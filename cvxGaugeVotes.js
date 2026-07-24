const settings = require('./settings.json');
const rpc = settings.rpc;

// Max leaf calls per multicall RPC. A user may set 0 (or leave it blank/invalid)
// expecting "no limit", so treat anything that isn't a positive integer as
// unlimited (a single multicall).
function normalizeBatchLimit(value) {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : Infinity;
}
const batchLimit = normalizeBatchLimit(settings.batchLimit);
const eventBlocksLimit = normalizeBatchLimit(settings.eventBlocksLimit);
const eventConcurrentLimit = normalizeBatchLimit(settings.eventConcurrentLimit);

// Pause between chunked multicalls, in ms. Guard against missing/negative/NaN
// values by falling back to no delay.
const rawSleepTime = Number(settings.sleepTime);
const sleepTime = Number.isFinite(rawSleepTime) && rawSleepTime > 0
    ? rawSleepTime
    : 0;

const ethers = require('ethers');
const provider = new ethers.providers.JsonRpcProvider(rpc);

const contracts = require('./contracts.js')(provider);

// Multicall3 is deployed at the same address on virtually every EVM chain.
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL3_ABI = [
    "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"
];
const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// An entry passed to batchCall is either:
//   - a leaf descriptor { target, callData, decode }, or
//   - a composite { calls: [leaf...], combine } that expands into multiple leaves
//     and recombines their decoded results into one value.
// groupCalls builds a composite so a single abstracted function (e.g. one that needs
// two on-chain reads) still counts as ONE logical entry in a batch.
function groupCalls(calls, combine = (results) => results) {
    return { calls, combine };
}

// Given a call (leaf or composite), either return it (batched) or execute it now.
async function resolveCall(call, batched) {
    if (batched) return call;
    return (await batchCall([call]))[0];
}

// Takes an array of batched-mode entries (each a Promise resolving to a leaf or
// composite call), flattens them into leaves, sends a single multicall RPC, then
// reassembles results so the output lines up 1:1 with the input entries.
async function batchCall(functionCalls, limitOverride = null) {
    const entries = await Promise.all(functionCalls);

    // Flatten to leaf calls while recording how to rebuild each entry's result.
    const leaves = [];
    const plans = entries.map(entry => {
        const start = leaves.length;
        if (Array.isArray(entry.calls)) {
            entry.calls.forEach(c => leaves.push(c));
            return { start, count: entry.calls.length, combine: entry.combine };
        }
        leaves.push(entry);
        return { start, count: 1, combine: null };
    });

    // Chunk leaves into batchLimit-sized multicalls so a huge batch doesn't exceed
    // RPC limits. Multiple chunks run sequentially with a sleepTime pause between
    // them to avoid rate limiting.
    const results = [];
    const effectiveBatchLimit = limitOverride !== null ? normalizeBatchLimit(limitOverride) : batchLimit;
    for (let i = 0; i < leaves.length; i += effectiveBatchLimit) {
        const chunk = leaves.slice(i, i + effectiveBatchLimit);
        const chunkResults = await multicall.callStatic.aggregate3(
            chunk.map(c => ({ target: c.target, allowFailure: false, callData: c.callData }))
        );
        results.push(...chunkResults);
        if (i + effectiveBatchLimit < leaves.length) {
            await sleep(sleepTime);
        }
    }
    const decoded = results.map((r, i) => leaves[i].decode(r.returnData));

    return plans.map(p => {
        const slice = decoded.slice(p.start, p.start + p.count);
        return p.combine ? p.combine(slice) : slice[0];
    });
}

function validatePlatform(platform) {
    if (platform !== "Curve" && platform !== "Fx") {
        throw new Error('Invalid platform. Must be "Curve" or "Fx".');
    }
}

// Wrap a locally-computed value so it can be included in batchCall alongside
// on-chain calls. It contributes zero leaf calls and simply yields the value,
// keeping the batch's result ordering aligned with its inputs.
function staticValue(value) {
    return { calls: [], combine: () => value };
}

function currentEpoch(batched = false) {
    const now = Math.floor(Date.now() / 1000);
    const epochStart = 1646265600;
    const epoch = Math.floor((now - epochStart) / (7 * 24 * 60 * 60));
    return batched ? staticValue(epoch) : epoch;
}

function currentProposalId(batched = false) {
    const epoch = currentEpoch();
    const id = Math.floor((epoch - 230) / 2);
    return batched ? staticValue(id) : id;
}

// Normalize a raw on-chain balance (BigNumber, in `decimals` base units) to a
// human-readable number. Centralizing this keeps normalization consistent.
function toUnits(value, decimals = 18) {
    return Number(ethers.utils.formatUnits(value, decimals));
}

async function getAllLockedUsers(batched = false) {
    const latestBlock = await provider.getBlockNumber();
    // Mainnet produces a block roughly every 12s post-merge; look back 20 weeks.
    const secondsBack = 20 * 7 * 24 * 60 * 60;
    const blocksBack = Math.floor(secondsBack / 12);
    const startBlock = Math.max(0, latestBlock - blocksBack);

    // Query a single [from, to] window resiliently: retry transient failures, and
    // if a range is rejected (e.g. too many logs / range too wide) split it in half
    // and recurse. Only a single block that still fails after retries throws, so the
    // final list is either complete or errors loudly rather than silently short.
    async function queryStakedWindow(filter, from, to, retries = 3) {
        try {
            return await contracts.vlCVX.queryFilter(filter, from, to);
        } catch (err) {
            if (from >= to) {
                if (retries > 0) {
                    await sleep(sleepTime);
                    return queryStakedWindow(filter, from, to, retries - 1);
                }
                throw err;
            }
            const mid = Math.floor((from + to) / 2);
            const [left, right] = await Promise.all([
                queryStakedWindow(filter, from, mid, retries),
                queryStakedWindow(filter, mid + 1, to, retries)
            ]);
            return left.concat(right);
        }
    }

    // Build all [from, to] windows of eventBlocksLimit blocks up front so a single
    // getLogs call doesn't exceed RPC range limits.
    const windows = [];
    for (let from = startBlock; from <= latestBlock; from += eventBlocksLimit) {
        const to = Math.min(from + eventBlocksLimit - 1, latestBlock);
        windows.push([from, to]);
    }

    // Run the window queries concurrently, capped at eventConcurrentLimit at a
    // time, pausing sleepTime only between waves to stay friendly with the RPC.
    const filter = contracts.vlCVX.filters.Staked();
    const users = new Set();
    for (let i = 0; i < windows.length; i += eventConcurrentLimit) {
        const wave = windows.slice(i, i + eventConcurrentLimit);
        const waveResults = await Promise.all(
            wave.map(([from, to]) => queryStakedWindow(filter, from, to))
        );
        waveResults.forEach(events => events.forEach(e => users.add(e.args._user)));
        if (i + eventConcurrentLimit < windows.length) {
            await sleep(sleepTime);
        }
    }

    const lockedUsers = Array.from(users);
    return batched ? staticValue(lockedUsers) : lockedUsers;
}

async function proposals(platform = "Curve", proposalId = "current", batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const contract = contracts[`${platform}GaugeVoting`];
    const call = {
        target: contract.address,
        callData: contract.interface.encodeFunctionData('proposals', [proposalId]),
        decode: (data) => contract.interface.decodeFunctionResult('proposals', data)
    };
    return resolveCall(call, batched);
}

async function userVotingPower(userAddress, epoch = "current", batched = false) {
    if(epoch === "current") {
        epoch = currentEpoch();
    }
    // Two on-chain reads combined into one logical value: [basePower, delegatedPower]
    const call = groupCalls([
        {
            target: contracts.vlCVX.address,
            callData: contracts.vlCVX.interface.encodeFunctionData('balanceAtEpochOf', [epoch, userAddress]),
            decode: (data) => toUnits(contracts.vlCVX.interface.decodeFunctionResult('balanceAtEpochOf', data)[0])
        },
        {
            target: contracts.GaugeDelegation.address,
            callData: contracts.GaugeDelegation.interface.encodeFunctionData('balanceAtEpochOf', [epoch, userAddress]),
            decode: (data) => toUnits(contracts.GaugeDelegation.interface.decodeFunctionResult('balanceAtEpochOf', data)[0])
        }
    ]);
    return resolveCall(call, batched);
}

async function usersVotingPowers(userArray, epoch = "current", batched = false) {
    // get vlcvx (not delegated) voting power for many users at once
    if(epoch === "current") {
        epoch = currentEpoch();
    }
    const groupedCalls = userArray.map(userAddress => ({
        target: contracts.vlCVX.address,
        callData: contracts.vlCVX.interface.encodeFunctionData('balanceAtEpochOf', [epoch, userAddress]),
        decode: (data) => toUnits(contracts.vlCVX.interface.decodeFunctionResult('balanceAtEpochOf', data)[0])
    }));
    // This can be hundreds of calls, so always run it as its own self-contained
    // multicall rather than injecting the leaves into a parent batch (which could
    // exceed RPC limits and revert/deny). To the outer batchCall it looks like a
    // precomputed static value that occupies a single slot.
    const powersRaw = await batchCall(groupedCalls);
    var powers = {};
    userArray.forEach((userAddress, index) => {
        powers[userAddress] = powersRaw[index];
    });
    return batched ? staticValue(powers) : powers;
}
    

async function getDelegate(userAddress, batched = false) {
    var epoch = currentEpoch();
    var futureEpoch = epoch + 2;

    const call = groupCalls([
        {
            target: contracts.GaugeDelegation.address,
            callData: contracts.GaugeDelegation.interface.encodeFunctionData('getDelegateAtEpoch', [userAddress, epoch]),
            decode: (data) => contracts.GaugeDelegation.interface.decodeFunctionResult('getDelegateAtEpoch', data)[0]
        },
        {
            target: contracts.GaugeDelegation.address,
            callData: contracts.GaugeDelegation.interface.encodeFunctionData('getDelegateAtEpoch', [userAddress, futureEpoch]),
            decode: (data) => contracts.GaugeDelegation.interface.decodeFunctionResult('getDelegateAtEpoch', data)[0]
        }
    ], (results) => ([
        results[0],
        results[1]
    ]));
    return resolveCall(call, batched);
}

async function getDelegatesAtEpoch(userArray, epoch = "current", batched = false) {
    if(epoch === "current") {
        epoch = currentEpoch();
    }
    const groupedCalls = userArray.map(userAddress => ({
        target: contracts.GaugeDelegation.address,
        callData: contracts.GaugeDelegation.interface.encodeFunctionData('getDelegateAtEpoch', [userAddress, epoch]),
        decode: (data) => contracts.GaugeDelegation.interface.decodeFunctionResult('getDelegateAtEpoch', data)[0]
    }));
    // This can be hundreds of calls, so always run it as its own self-contained
    // multicall rather than injecting the leaves into a parent batch (which could
    // exceed RPC limits and revert/deny). To the outer batchCall it looks like a
    // precomputed static value that occupies a single slot.
    const delegatesRaw = await batchCall(groupedCalls);
    var delegates = {};
    userArray.forEach((userAddress, index) => {
        delegates[userAddress] = delegatesRaw[index];
    });
    return batched ? staticValue(delegates) : delegates;
}

async function userSyncedWeight(userAddress, batched = false) {
    const contract = contracts.GaugeDelegation;
    const call = {
        target: contract.address,
        callData: contract.interface.encodeFunctionData('getUserWeight', [userAddress]),
        decode: (data) => toUnits(contract.interface.decodeFunctionResult('getUserWeight', data)[0])
    };
    return resolveCall(call, batched);
}

async function voteTotal(platform = "Curve", proposalId = "current", batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const contract = contracts[`${platform}GaugeVoting`];
    const call = {
        target: contract.address,
        callData: contract.interface.encodeFunctionData('voteTotals', [proposalId]),
        decode: (data) => toUnits(contract.interface.decodeFunctionResult('voteTotals', data)[0])
    };
    return resolveCall(call, batched);
}

async function getGaugeCount(platform = "Curve", proposalId = "current", batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const contract = contracts[`${platform}GaugeVoting`];
    const call = {
        target: contract.address,
        callData: contract.interface.encodeFunctionData('getGaugeCount', [proposalId]),
        decode: (data) => contract.interface.decodeFunctionResult('getGaugeCount', data)[0].toNumber()
    };
    return resolveCall(call, batched);
}

async function getGaugeEntry(platform = "Curve", proposalId = "current", index, batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const contract = contracts[`${platform}GaugeVoting`];
    const call = {
        target: contract.address,
        callData: contract.interface.encodeFunctionData('getGaugeEntry', [proposalId, index]),
        decode: (data) => {
            const [gauge, totalWeight] = contract.interface.decodeFunctionResult('getGaugeEntry', data);
            return [gauge, toUnits(totalWeight)];
        }
    };
    return resolveCall(call, batched);
}

async function getAllGaugeEntries(platform = "Curve", proposalId = "current", batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const count = await getGaugeCount(platform, proposalId);
    var groupedCalls = [];
    for (let i = 0; i < count; i++) {
        groupedCalls.push({
            target: contracts[`${platform}GaugeVoting`].address,
            callData: contracts[`${platform}GaugeVoting`].interface.encodeFunctionData('getGaugeEntry', [proposalId, i]),
            decode: (data) => {
                const [gauge, totalWeight] = contracts[`${platform}GaugeVoting`].interface.decodeFunctionResult('getGaugeEntry', data);
                return [gauge, toUnits(totalWeight)];
            }
        });
    }
    // map results from [ [gauge, weight], ... ] to { gauge: weight, ... }
    const call = groupCalls(groupedCalls, (results) => {
        var gaugeEntries = {};
        results.forEach(([gauge, weight]) => {
            gaugeEntries[gauge] = weight;
        });
        return gaugeEntries;
    });
    return resolveCall(call, batched);
}

async function gaugeTotals(platform = "Curve", proposalId = "current", gauges, batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const contract = contracts[`${platform}GaugeVoting`];
    // gaugeTotal takes proposalId and gauge address, so we need to make a call for each gauge
    const groupedCalls = gauges.map(gauge => ({
        target: contract.address,
        callData: contract.interface.encodeFunctionData('gaugeTotal', [proposalId, gauge]),
        decode: (data) => toUnits(contract.interface.decodeFunctionResult('gaugeTotal', data)[0])
    }));
    // This can be dozens of calls, so always run it as its own self-contained
    // multicall rather than injecting the leaves into a parent batch (which could
    // exceed RPC limits and revert/deny). To the outer batchCall it looks like a
    // precomputed static value that occupies a single slot.
    const totalsRaw = await batchCall(groupedCalls);
    var totals = {};
    gauges.forEach((gauge, index) => {
        totals[gauge] = totalsRaw[index];
    });
    return batched ? staticValue(totals) : totals;
}

async function getVoterCount(platform = "Curve", proposalId = "current", batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const contract = contracts[`${platform}GaugeVoting`];
    const call = {
        target: contract.address,
        callData: contract.interface.encodeFunctionData('getVoterCount', [proposalId]),
        decode: (data) => contract.interface.decodeFunctionResult('getVoterCount', data)[0].toNumber()
    };
    return resolveCall(call, batched);
}

async function getAllVoterAddresses(platform = "Curve", proposalId = "current", batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const count = await getVoterCount(platform, proposalId);
    var groupedCalls = [];
    for (let i = 0; i < count; i++) {
        groupedCalls.push({
            target: contracts[`${platform}GaugeVoting`].address,
            callData: contracts[`${platform}GaugeVoting`].interface.encodeFunctionData('getVoterAtIndex', [proposalId, i]),
            decode: (data) => contracts[`${platform}GaugeVoting`].interface.decodeFunctionResult('getVoterAtIndex', data)[0]
        });
    }
    // This can be dozens of calls, so always run it as its own self-contained
    // multicall rather than injecting the leaves into a parent batch (which could
    // exceed RPC limits and revert/deny). To the outer batchCall it looks like a
    // precomputed static value that occupies a single slot.
    const addresses = await batchCall(groupedCalls);
    return batched ? staticValue(addresses) : addresses;
}

async function getVote(platform = "Curve", proposalId = "current", userAddress, batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const contract = contracts[`${platform}GaugeVoting`];
    const call = {
        target: contract.address,
        callData: contract.interface.encodeFunctionData('getVote', [proposalId, userAddress]),
        decode: (data) => {
            const [gauges, weights, voted, baseWeight, adjustedWeight] = contract.interface.decodeFunctionResult('getVote', data);
            return {
                gauges,
                weights: weights.map(w => toUnits(w, 0)),
                voted,
                baseWeight: toUnits(baseWeight),
                adjustedWeight: toUnits(adjustedWeight)
            };
        }
    };
    return resolveCall(call, batched);
}

async function getAllVotes(platform = "Curve", proposalId = "current", batched = false) {
    validatePlatform(platform);
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    const voterAddresses = await getAllVoterAddresses(platform, proposalId);
    const groupedCalls = voterAddresses.map(userAddress => ({
        target: contracts[`${platform}GaugeVoting`].address,
        callData: contracts[`${platform}GaugeVoting`].interface.encodeFunctionData('getVote', [proposalId, userAddress]),
        decode: (data) => {
            const [gauges, weights, voted, baseWeight, adjustedWeight] = contracts[`${platform}GaugeVoting`].interface.decodeFunctionResult('getVote', data);
            return {
                userAddress,
                gauges,
                weights: weights.map(w => toUnits(w, 0)),
                voted,
                baseWeight: toUnits(baseWeight),
                adjustedWeight: toUnits(adjustedWeight)
            };
        }
    }));
    // This can be hundreds of calls, so always run it as its own self-contained multicall rather than injecting the leaves into a parent batch (which could exceed RPC limits and revert/deny). To the outer batchCall it looks like a precomputed static value that occupies a single slot.
    const votes = await batchCall(groupedCalls);
    return batched ? staticValue(votes) : votes;
}

async function getContributingWeights(platform = "Curve", proposalId = "current", delegate, users, batched = false) {
    validatePlatform(platform);
    if(platform === "Curve") {
        platform = contracts.CurveGaugeVoting.address;
    } else if(platform === "Fx") {
        platform = contracts.FxGaugeVoting.address;
    }
    if(proposalId === "current") {
        proposalId = currentProposalId();
    }
    // since users may contain hundreds of addresses, we will enforce batchLimit for the number of users checked at once
    // contract: GaugeVoteHelper.getContributingWeights(address platform, uint256 proposalId, address delegate, address[] users) returns (uint256[] weights)
    const groupedCalls = [];
    for (let i = 0; i < users.length; i += batchLimit) {
        const userBatch = users.slice(i, i + batchLimit);
        groupedCalls.push({
            target: contracts.GaugeVoteHelper.address,
            callData: contracts.GaugeVoteHelper.interface.encodeFunctionData('getContributingWeights', [proposalId, delegate, userBatch, platform]),
            decode: (data) => contracts.GaugeVoteHelper.interface.decodeFunctionResult('getContributingWeights', data)[0].map(w => toUnits(w))
        });
    }
    // This can be hundreds of calls, so always run it as its own self-contained multicall rather than injecting the leaves into a parent batch (which could exceed RPC limits and revert/deny). To the outer batchCall it looks like a precomputed static value that occupies a single slot.
    const weightsBatches = await batchCall(groupedCalls);
    // flatten the array of arrays into a single array
    const weights = weightsBatches.flat();
    // return an object with user addresses as keys and weights as values
    const weightsMap = {};
    for (let i = 0; i < users.length; i++) {
        weightsMap[users[i]] = weights[i];
    }
    return batched ? staticValue(weightsMap) : weightsMap;
}

async function prepareTx(platform, gauges, weights, signer, voter) {
    validatePlatform(platform);
    const tx = await contracts[`${platform}GaugeVoting`].connect(signer).populateTransaction.vote(voter, gauges, weights);
    return tx;
}

module.exports = {
    batchCall,
    currentEpoch,
    currentProposalId,
    proposals,
    userVotingPower,
    usersVotingPowers,
    getAllLockedUsers,
    userSyncedWeight,
    voteTotal,
    getDelegate,
    getDelegatesAtEpoch,
    getGaugeCount,
    getGaugeEntry,
    getAllGaugeEntries,
    gaugeTotals,
    getVoterCount,
    getAllVoterAddresses,
    getVote,
    getAllVotes,
    getContributingWeights,
    prepareTx
};