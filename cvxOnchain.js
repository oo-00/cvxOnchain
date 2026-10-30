// cvxOnchain: reads (and unsigned tx builders) for Convex's on-chain vlCVX voting.
//
//   const cvx = require('cvxonchain')({ rpc: 'https://...' });   // or ({ provider })
//
// Options: rpc or provider (required), batchLimit, eventBlocksLimit, eventConcurrentLimit,
// sleepTime. There's no settings file, and no RPC is made until a function is called.

const ethers = require('ethers');
const createContracts = require('./contracts.js');
// Snapshot (off-chain) voting helper for partner platforms that use Snapshot.
const snapshot = require('./snapshot.js');

const DEFAULTS = { batchLimit: 100, eventBlocksLimit: 10000, eventConcurrentLimit: 5, sleepTime: 500 };

module.exports = function cvxOnchain(options = {}) {

// SETUP 
    // options passed as undefined (an unset environment variable, say) keep their defaults
    const settings = { ...DEFAULTS };
    for (const [key, value] of Object.entries(options || {})) {
        if (value !== undefined) settings[key] = value;
    }
    if (!settings.provider && !settings.rpc) {
        throw new Error('cvxOnchain: pass { rpc } or { provider }');
    }

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

    // Static, and told it's mainnet (the only chain these contracts are on): ethers' JsonRpcProvider asks the RPC for
    // its chain id before almost every request, and without a network as soon as it's built
    const provider = settings.provider || new ethers.providers.StaticJsonRpcProvider(settings.rpc, 1);

    const contracts = createContracts(provider);

    // Multicall3 is deployed at the same address on virtually every EVM chain.
    const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
    const MULTICALL3_ABI = [
        "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[] returnData)"
    ];
    const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

    async function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

// BATCHING FUNCTIONS

    // An entry passed to batchCall is either:
    //   - a leaf descriptor { target, callData, decode, allowFailure? } (leafCall builds one): with
    //     allowFailure, a call that reverts, or returns nothing (an address with no code, say),
    //     yields null instead of failing the whole multicall, or
    //   - a composite { calls: [leaf...], combine } that expands into multiple leaves
    //     and recombines their decoded results into one value.
    // groupCalls builds a composite so a single abstracted function (e.g. one that needs
    // two on-chain reads) still counts as ONE logical entry in a batch.
    function groupCalls(calls, combine = (results) => results) {
        return { calls, combine };
    }

    // A leaf descriptor for one view call: encodes fn(args) on contract, decodes with `decode`.
    // allowFailure: a revert, or an empty result (no code at the target), yields null rather than failing
    // the multicall it's batched in.
    function leafCall(contract, fn, args, decode = (result) => result, { allowFailure = false } = {}) {
        return {
            target: contract.address,
            callData: contract.interface.encodeFunctionData(fn, args),
            decode: (data) => decode(contract.interface.decodeFunctionResult(fn, data)),
            allowFailure
        };
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
        // them to avoid rate limiting, all at the same block, so the batch reads one
        // block's state. (A provider that pins reads to a block should answer
        // eth_blockNumber with that block too.)
        const results = [];
        const effectiveBatchLimit = limitOverride !== null ? normalizeBatchLimit(limitOverride) : batchLimit;
        const overrides = leaves.length > effectiveBatchLimit ? { blockTag: await provider.getBlockNumber() } : {};
        for (let i = 0; i < leaves.length; i += effectiveBatchLimit) {
            const chunk = leaves.slice(i, i + effectiveBatchLimit);
            const chunkResults = await multicall.callStatic.aggregate3(
                chunk.map(c => ({ target: c.target, allowFailure: !!c.allowFailure, callData: c.callData })),
                overrides
            );
            results.push(...chunkResults);
            if (i + effectiveBatchLimit < leaves.length) {
                await sleep(sleepTime);
            }
        }
        // only allowFailure leaves can come back unsuccessful or empty; anything else that won't decode throws
        const decoded = results.map((r, i) => (!r.success || (leaves[i].allowFailure && r.returnData === '0x')
            ? null
            : leaves[i].decode(r.returnData)));

        return plans.map(p => {
            const slice = decoded.slice(p.start, p.start + p.count);
            return p.combine ? p.combine(slice) : slice[0];
        });
    }

    // Wrap a locally-computed value so it can be included in batchCall alongside
    // on-chain calls. It contributes zero leaf calls and simply yields the value,
    // keeping the batch's result ordering aligned with its inputs.
    function staticValue(value) {
        return { calls: [], combine: () => value };
    }

// LOCAL FUNCTIONS

    // Normalize a raw on-chain balance (BigNumber, in `decimals` base units) to a
    // human-readable number. Centralizing this keeps normalization consistent.
    function toUnits(value, decimals = 18) {
        return Number(ethers.utils.formatUnits(value, decimals));
    }

    function validatePlatform(platform, type) {
        if(type === "gauge" && platform !== "Curve" && platform !== "Fx") {
            throw new Error('Invalid platform. Must be "Curve" or "Fx".');
        }
        if(type === "dao" &&
        platform !== "Convex" &&
        platform !== "Curve" && 
        platform !== "Fx" &&
        platform !== "Frax" &&
        platform !== "Resupply") {
            throw new Error('Invalid platform. Must be "Convex", "Curve", "Fx", "Frax", or "Resupply".');
        }
    }

    function currentEpoch(batched = false) {
        const now = Math.floor(Date.now() / 1000);
        const epochStart = 1646265600;
        const epoch = Math.floor((now - epochStart) / (7 * 24 * 60 * 60));
        return batched ? staticValue(epoch) : epoch;
    }

    function gaugeProposalId(batched = false) {
        const epoch = currentEpoch();
        const id = Math.floor((epoch - 230) / 2);
        return batched ? staticValue(id) : id;
    }

// CORE FUNCTIONS (for gauge and dao voting)

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

    async function userVotingPower(userAddress, epoch = "current", batched = false) {
        if(epoch === "current") {
            epoch = await currentEpoch();
        }
        // Two on-chain reads combined into one logical value: [basePower, delegatedPower]
        const call = groupCalls([
            leafCall(contracts.vlCVX, 'balanceAtEpochOf', [epoch, userAddress], (r) => toUnits(r[0])),
            leafCall(contracts.GaugeDelegation, 'balanceAtEpochOf', [epoch, userAddress], (r) => toUnits(r[0]))
        ]);
        return resolveCall(call, batched);
    }

    async function usersVotingPowers(userArray, epoch = "current", batched = false) {
        // get vlcvx (not delegated) voting power for many users at once
        if(epoch === "current") {
            epoch = await currentEpoch();
        }
        const groupedCalls = userArray.map(userAddress => leafCall(contracts.vlCVX, 'balanceAtEpochOf', [epoch, userAddress], (r) => toUnits(r[0])));
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

// GAUGE VOTING FUNCTIONS
    async function gaugeProposals(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = leafCall(contract, 'proposals', [proposalId]);
        return resolveCall(call, batched);
    }

    async function gaugeDelegate(userAddress, batched = false) {
        var epoch = await currentEpoch();
        var futureEpoch = epoch + 2;

        const call = groupCalls([
            leafCall(contracts.GaugeDelegation, 'getDelegateAtEpoch', [userAddress, epoch], (r) => r[0]),
            leafCall(contracts.GaugeDelegation, 'getDelegateAtEpoch', [userAddress, futureEpoch], (r) => r[0])
        ], (results) => ([
            results[0],
            results[1]
        ]));
        return resolveCall(call, batched);
    }

    async function gaugeDelegatesAtEpoch(userArray, epoch = "current", batched = false) {
        if(epoch === "current") {
            epoch = await currentEpoch();
        }
        const groupedCalls = userArray.map(userAddress => leafCall(contracts.GaugeDelegation, 'getDelegateAtEpoch', [userAddress, epoch], (r) => r[0]));
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

    async function gaugeSyncedWeight(userAddress, batched = false) {
        const contract = contracts.GaugeDelegation;
        const call = leafCall(contract, 'getUserWeight', [userAddress], (r) => toUnits(r[0]));
        return resolveCall(call, batched);
    }

    async function gaugeVoteTotal(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = leafCall(contract, 'voteTotals', [proposalId], (r) => toUnits(r[0]));
        return resolveCall(call, batched);
    }

    async function getGaugeCount(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = leafCall(contract, 'getGaugeCount', [proposalId], (r) => r[0].toNumber());
        return resolveCall(call, batched);
    }

    // GaugeVoting.getGaugeEntry, decoded: [gauge, totalWeight]
    const decodeGaugeEntry = ([gauge, totalWeight]) => [gauge, toUnits(totalWeight)];

    async function getGaugeEntry(platform = "Curve", proposalId = "current", index, batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = leafCall(contract, 'getGaugeEntry', [proposalId, index], decodeGaugeEntry);
        return resolveCall(call, batched);
    }

    async function getAllGaugeEntries(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const count = await getGaugeCount(platform, proposalId);
        var groupedCalls = [];
        for (let i = 0; i < count; i++) {
            groupedCalls.push(leafCall(contracts[`${platform}GaugeVoting`], 'getGaugeEntry', [proposalId, i], decodeGaugeEntry));
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
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        // gaugeTotal takes proposalId and gauge address, so we need to make a call for each gauge
        const groupedCalls = gauges.map(gauge => leafCall(contract, 'gaugeTotal', [proposalId, gauge], (r) => toUnits(r[0])));
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

    async function gaugeVoterCount(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = leafCall(contract, 'getVoterCount', [proposalId], (r) => r[0].toNumber());
        return resolveCall(call, batched);
    }

    async function gaugeAllVoterAddresses(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const count = await gaugeVoterCount(platform, proposalId);
        var groupedCalls = [];
        for (let i = 0; i < count; i++) {
            groupedCalls.push(leafCall(contracts[`${platform}GaugeVoting`], 'getVoterAtIndex', [proposalId, i], (r) => r[0]));
        }
        // This can be dozens of calls, so always run it as its own self-contained
        // multicall rather than injecting the leaves into a parent batch (which could
        // exceed RPC limits and revert/deny). To the outer batchCall it looks like a
        // precomputed static value that occupies a single slot.
        const addresses = await batchCall(groupedCalls);
        return batched ? staticValue(addresses) : addresses;
    }

    // GaugeVoting.getVote, decoded
    const decodeGaugeVote = ([gauges, weights, voted, baseWeight, adjustedWeight]) => ({
        gauges,
        weights: weights.map(w => toUnits(w, 0)),
        voted,
        baseWeight: toUnits(baseWeight),
        adjustedWeight: toUnits(adjustedWeight)
    });

    async function gaugeUserVote(platform = "Curve", proposalId = "current", userAddress, batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const call = leafCall(contracts[`${platform}GaugeVoting`], 'getVote', [proposalId, userAddress], decodeGaugeVote);
        return resolveCall(call, batched);
    }

    async function gaugeAllVotes(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const voterAddresses = await gaugeAllVoterAddresses(platform, proposalId);
        const groupedCalls = voterAddresses.map(userAddress => leafCall(contracts[`${platform}GaugeVoting`], 'getVote', [proposalId, userAddress], (r) => ({ userAddress, ...decodeGaugeVote(r) })));
        // This can be hundreds of calls, so always run it as its own self-contained multicall rather than injecting the leaves into a parent batch (which could exceed RPC limits and revert/deny). To the outer batchCall it looks like a precomputed static value that occupies a single slot.
        const votes = await batchCall(groupedCalls);
        return batched ? staticValue(votes) : votes;
    }

    async function getContributingWeights(platform = "Curve", proposalId = "current", delegate, users, batched = false) {
        validatePlatform(platform, "gauge");
        if(platform === "Curve") {
            platform = contracts.CurveGaugeVoting.address;
        } else if(platform === "Fx") {
            platform = contracts.FxGaugeVoting.address;
        }
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        // since users may contain hundreds of addresses, we will enforce batchLimit for the number of users checked at once
        // contract: GaugeVoteHelper.getContributingWeights(address platform, uint256 proposalId, address delegate, address[] users) returns (uint256[] weights)
        const groupedCalls = [];
        for (let i = 0; i < users.length; i += batchLimit) {
            const userBatch = users.slice(i, i + batchLimit);
            groupedCalls.push(leafCall(contracts.GaugeVoteHelper, 'getContributingWeights', [proposalId, delegate, userBatch, platform], (r) => r[0].map(w => toUnits(w))));
        }
        // Run as its own multicalls, one helper call (batchLimit users) per request: packing batchLimit of them into one
        // multicall would put batchLimit² users in a single eth_call, past the RPC's gas cap for a large delegate.
        // To the outer batchCall it looks like a precomputed static value that occupies a single slot.
        const weightsBatches = await batchCall(groupedCalls, 1);
        // flatten the array of arrays into a single array
        const weights = weightsBatches.flat();
        // return an object with user addresses as keys and weights as values
        const weightsMap = {};
        for (let i = 0; i < users.length; i++) {
            weightsMap[users[i]] = weights[i];
        }
        return batched ? staticValue(weightsMap) : weightsMap;
    }

    async function gaugeIsFinalized(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = leafCall(contract, 'isFinalized', [proposalId], (r) => r[0]);
        return resolveCall(call, batched);
    }

    async function prepareGaugeVoteTx(platform, gauges, weights, signer, voter) {
        validatePlatform(platform, "gauge");
        const tx = await contracts[`${platform}GaugeVoting`].connect(signer).populateTransaction.vote(voter, gauges, weights);
        return tx;
    }

    async function gaugeIsDone(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeExecutor`];
        const call = leafCall(contract, 'isDone', [proposalId], (r) => r[0]);
        return resolveCall(call, batched);
    }

// DAO VOTING FUNCTIONS

    async function daoProposalCount(platform = "Convex", batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'proposalCount', [], (r) => r[0].toNumber());
        return resolveCall(call, batched);
    }

    async function daoProposal(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'proposals', [proposalId], ([startTime, endTime, epoch, voteType, nativeId]) => ({
            startTime,
            endTime,
            epoch,
            voteType,
            nativeId: toUnits(nativeId, 0)
        }));
        return resolveCall(call, batched);
    }

    async function daoVoteTotal(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'voteTotals', [proposalId], (r) => toUnits(r[0]));
        return resolveCall(call, batched);
    }

    // DaoVoting.getVote, decoded: yesWeight and noWeight split the vote in basis points (10000 = all of it)
    const decodeDaoVote = ([voted, yesWeight, noWeight, baseWeight, adjustedWeight]) => ({
        voted,
        yesWeight: toUnits(yesWeight, 0),
        noWeight: toUnits(noWeight, 0),
        baseWeight: toUnits(baseWeight),
        adjustedWeight: toUnits(adjustedWeight)
    });

    async function daoUserVote(platform = "Convex", proposalId, userAddress, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'getVote', [proposalId, userAddress], decodeDaoVote);
        return resolveCall(call, batched);
    }

    async function daoYesTotal(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'getYes', [proposalId], (r) => toUnits(r[0]));
        return resolveCall(call, batched);
    }

    async function daoNoTotal(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'getNo', [proposalId], (r) => toUnits(r[0]));
        return resolveCall(call, batched);
    }

    async function daoIsFinished(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'isFinished', [proposalId], (r) => r[0]);
        return resolveCall(call, batched);
    }

    async function daoIsFinalized(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'isFinalized', [proposalId], (r) => r[0]);
        return resolveCall(call, batched);
    }

    async function daoIsDone(platform = "Curve", proposalId, batched = false) {
        if(platform !== "Curve" && platform !== "Resupply") {
            throw new Error('Invalid platform. Must be "Curve" or "Resupply".');
        }
        const contract = contracts[`${platform}VoteExecutor`];
        const call = leafCall(contract, 'isDone', [proposalId], (r) => r[0]);
        return resolveCall(call, batched);
    }

    async function daoVoterCount(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = leafCall(contract, 'getVoterCount', [proposalId], (r) => r[0].toNumber());
        return resolveCall(call, batched);
    }

    async function daoAllVoterAddresses(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const count = await daoVoterCount(platform, proposalId);
        var groupedCalls = [];
        for (let i = 0; i < count; i++) {
            groupedCalls.push(leafCall(contracts[`${platform}DaoVoting`], 'getVoterAtIndex', [proposalId, i], (r) => r[0]));
        }
        // This can be dozens of calls, so always run it as its own self-contained
        // multicall rather than injecting the leaves into a parent batch (which could
        // exceed RPC limits and revert/deny). To the outer batchCall it looks like a
        // precomputed static value that occupies a single slot.
        const addresses = await batchCall(groupedCalls);
        return batched ? staticValue(addresses) : addresses;
    }

    async function daoAllVotes(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const voterAddresses = await daoAllVoterAddresses(platform, proposalId);
        const groupedCalls = voterAddresses.map(userAddress => leafCall(contracts[`${platform}DaoVoting`], 'getVote', [proposalId, userAddress], (r) => ({ userAddress, ...decodeDaoVote(r) })));
        // This can be hundreds of calls, so always run it as its own self-contained multicall rather than injecting the leaves into a parent batch (which could exceed RPC limits and revert/deny). To the outer batchCall it looks like a precomputed static value that occupies a single slot.
        const votes = await batchCall(groupedCalls);
        return batched ? staticValue(votes) : votes;
    }

// PARTNER VOTING FUNCTIONS

    const partnerDaoPlatforms = ["ResupplyVoter", "CurveOwnership", "CurveParameter", "fxn.eth", "frax.eth"];

    async function partnerProposalCount(platform, batched = false) {
        if(!partnerDaoPlatforms.includes(platform)) {
            throw new Error(`Invalid platform. Must be one of: ${partnerDaoPlatforms.join(", ")}`);
        }
        const contract = contracts[platform];
        if(platform === "CurveOwnership" || platform === "CurveParameter") {
            const call = leafCall(contract, 'votesLength', [], (r) => toUnits(r[0], 0));
            return resolveCall(call, batched);
        }
        if(platform === "ResupplyVoter") {
            const call = leafCall(contract, 'getProposalCount', [], (r) => toUnits(r[0], 0));
            return resolveCall(call, batched);
        }
        if(platform === "fxn.eth" || platform === "frax.eth") {
            // use Math.floor of time / 6 hours to create a pseudo-proposal count that increments every 6 hours
            // this way we check for new proposals every 6 hours and can use the snapshotGetNewProposals function to get the actual proposals
            const now = Math.floor(Date.now() / 1000);
            const proposalCount = Math.floor(now / (6 * 60 * 60));
            return batched ? staticValue(proposalCount) : proposalCount;
        }
    }

    async function partnerProposal(platform, proposalId, batched = false) {
        if(!partnerDaoPlatforms.includes(platform)) {
            throw new Error(`Invalid platform. Must be one of: ${partnerDaoPlatforms.join(", ")}`);
        }
        const contract = contracts[platform];
        if(platform === "CurveOwnership" || platform === "CurveParameter") {
            const call = leafCall(contract, 'getVote', [proposalId], (r) => ({
                start: toUnits(r.startDate, 0),
                voteType: platform === "CurveOwnership" ? 0 : 1,
                cvxId: null,
                script: r.script
            }));
            return resolveCall(call, batched);
        } else if(platform === "ResupplyVoter") {
            const call = leafCall(contract, 'getProposalData', [proposalId], (r) => ({
                description: r.description,
                start: toUnits(r.createdAt, 0),
                voteType: 0,
                cvxId: null,
                payload: r.payload
            }));
            return resolveCall(call, batched);
        } else if(platform === "fxn.eth" || platform === "frax.eth") {
            var proposals = await snapshot.getNewProposals(platform, proposalId);
            var formattedProposals = {};
            if(proposals.length == 0) {
                return batched ? staticValue(null) : null;
            } else {
                for(var i = 0; i < proposals.length; i++) {
                    // extract nativeId from title
                    // examples 
                    // '[FIP-30] Add FXN gauge to OUSD/fxUSD'
                    // '[FIP - 446] Early withdrawal of stkcvxSTGFRAXBP and stkcvxCOILFRAXBP'
                    // '[FIP- 446] Early withdrawal of stkcvxSTGFRAXBP and stkcvxCOILFRAXBP'
                    // etc
                    var title = proposals[i].title;
                    var nativeId = title.match(/\[FIP[-\s]*(\d+)\]/);
                    if(nativeId && nativeId.length > 1) {
                        nativeId = parseInt(nativeId[1]);
                    } else {
                        nativeId = null;
                    }
                    // keyed by FIP number, or by Snapshot id for a title without one (nativeId null), so none
                    // overwrites another
                    formattedProposals[nativeId !== null ? nativeId : proposals[i].id] = {
                        nativeId,
                        snapshotId: proposals[i].id,
                        description: proposals[i].title,
                        start: proposals[i].start,
                        voteType: 0,
                        cvxId: null
                    };
                }
            }
            return batched ? staticValue(formattedProposals) : formattedProposals;
        } else {
            throw new Error(`Invalid platform. Must be one of: ${partnerDaoPlatforms.join(", ")}`);
        }
    }

    async function getCurveMetadata(proposalId, type, batched = false) {
        // Metadata is only emitted in the event logs, so we need to query the logs for the proposalId
        // event StartVote(uint256 indexed voteId, address indexed creator, string metadata, uint256 minBalance, uint256 minTime, uint256 totalSupply, uint256 creatorVotingPower);
        // both vote types use identical contract abi, but different contract addresses, so we can use the same function to get metadata for both
        var contract;
        if(type == 0) {
            contract = contracts.CurveOwnership;
        } else if(type == 1) {
            contract = contracts.CurveParameter;
        } else {
            throw new Error(`Invalid type. Must be one of: 0 (CurveOwnership), 1 (CurveParameter)`);
        }
        // The vote's record says where its StartVote event is: Aragon voting sets snapshotBlock to the block before
        // the one that creates the vote. getVote reverts (VOTING_NO_VOTE) for a vote that doesn't exist.
        const [snapshotBlock] = await batchCall([
            leafCall(contract, 'getVote', [proposalId], (r) => r.snapshotBlock.toNumber(), { allowFailure: true })
        ]);
        if(snapshotBlock === null) {
            throw new Error(`No vote ${proposalId} on ${type == 0 ? "CurveOwnership" : "CurveParameter"}`);
        }
        const filter = contract.filters.StartVote(proposalId);
        var events = await contract.queryFilter(filter, snapshotBlock, snapshotBlock + 1);
        // fallback, should the event not be there: windows of eventBlocksLimit blocks, newest first, from the latest
        // block back to block 0
        if(events.length == 0) {
            var toBlock = await provider.getBlockNumber();
            while(toBlock >= 0) {
                const fromBlock = Math.max(0, toBlock - eventBlocksLimit + 1);
                events = await contract.queryFilter(filter, fromBlock, toBlock);
                if(events.length > 0) {
                    break;
                }
                toBlock = fromBlock - 1;
            }
        }
        if(events.length == 0) {
            throw new Error(`No StartVote event found for proposalId ${proposalId}`);
        }
        const metadata = events[0].args.metadata;
        // check if metadata is ipfs:// or ipns:// and if so, fetch the metadata from ipfs
        if(metadata.startsWith("ipfs:") || metadata.startsWith("ipns:")) {
            var ipfsHash = metadata.split(":")[1];
            // check if ipfsHash starts with // and remove it
            if(ipfsHash.startsWith("//")) {
                ipfsHash = ipfsHash.substring(2);
            }
            const ipfsUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
            const response = await fetch(ipfsUrl);
            await sleep(sleepTime); // sleep for a bit to avoid rate limiting
            if(!response.ok) {
                throw new Error(`Failed to fetch metadata from IPFS: ${response.status} ${response.statusText}`);
            }
            var ipfsMetadata = await response.json();
            var metaText = ipfsMetadata.text;
            return batched ? staticValue(metaText) : metaText;
        }
        return batched ? staticValue(metadata) : metadata;
    }

// GAUGE VOTE WEIGHTS (ported from the vlCVX voter)

    async function userInfo(platform = "Curve", proposalId = "current", userAddress, batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = gaugeProposalId();
        }
        const call = leafCall(contracts[`${platform}GaugeVoting`], 'userInfo', [proposalId, userAddress], (r) => ({
            baseWeight: toUnits(r.baseWeight),
            adjustedWeight: toUnits(r.adjustedWeight),
            lastVoteSyncNonce: Number(r.lastVoteSyncNonce),
            voteStatus: r.voteStatus,
            delegate: r.delegate,
            totalDelegationWeight: toUnits(r.totalDelegationWeight)
        }));
        return resolveCall(call, batched);
    }

    // The weight an account's next vote() on a proposal will carry, as { baseWeight, adjustedWeight }.
    // Stored weights go stale mid-round (a delegator relocks and syncs, say), and the platform
    // refreshes them on every vote: a first vote reads the base and delegated balances fresh on
    // top of any adjustments already recorded, and a re-vote also applies pending adjustments.
    async function predictVoteWeight(platform = "Curve", proposalId = "current", userAddress, batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = gaugeProposalId();
        }
        const epoch = (await gaugeProposals(platform, proposalId)).epoch;
        const [info, base, delegated, pending] = await batchCall([
            userInfo(platform, proposalId, userAddress, true),
            leafCall(contracts.vlCVX, 'balanceAtEpochOf', [epoch, userAddress], (r) => toUnits(r[0])),
            leafCall(contracts.GaugeDelegation, 'balanceAtEpochOf', [epoch, userAddress], (r) => toUnits(r[0])),
            leafCall(contracts[`${platform}GaugeVoting`], 'pendingWeightAdjustment', [proposalId, userAddress], (r) => toUnits(r[0]))
        ]);
        var weight;
        if (info.delegate == ethers.constants.AddressZero) {
            weight = { baseWeight: base, adjustedWeight: info.adjustedWeight + delegated };
        } else if (info.voteStatus > 0) {
            weight = { baseWeight: base, adjustedWeight: info.adjustedWeight + delegated - info.totalDelegationWeight + pending };
        } else {
            weight = { baseWeight: info.baseWeight, adjustedWeight: info.adjustedWeight };
        }
        return batched ? staticValue(weight) : weight;
    }

    // The weight each of `users` contributes to `delegate`'s vote, following
    // GaugeVoteHelper.getContributingWeights. It depends on the delegate's own vote: weight a
    // delegator syncs in (by relocking, say) only counts once the delegate votes again, and a
    // delegator who voted manually only contributes what they synced in after their own vote.
    // By default this predicts the delegate's next vote, which records the current delegation
    // syncNonce. Pass delegateVote { voteStatus, lastVoteSyncNonce } to follow the helper for
    // the delegate's vote as it stands instead.
    async function predictContributingWeights(platform = "Curve", proposalId = "current", delegate, users, delegateVote = null, batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = gaugeProposalId();
        }
        const epoch = (await gaugeProposals(platform, proposalId)).epoch;
        const delegation = contracts.GaugeDelegation;
        const voting = contracts[`${platform}GaugeVoting`];
        // This can be hundreds of calls, so always run it as its own self-contained multicall. The delegation syncNonce
        // goes last in the same batch, so it's read at the same block as the users.
        const calls = users.map(user => groupCalls([
            leafCall(delegation, 'getDelegateAtEpoch', [user, epoch], (r) => r[0]),
            leafCall(delegation, 'userWeightAtEpochOf', [epoch, user], (r) => toUnits(r[0])),
            leafCall(delegation, 'getSyncSnapshot', [user, epoch], (r) => ({ preSyncWeight: toUnits(r.preSyncWeight), snapNonce: r.snapshotNonce.toNumber() })),
            leafCall(voting, 'userInfo', [proposalId, user], (r) => ({ voteStatus: r.voteStatus, lastVoteSyncNonce: Number(r.lastVoteSyncNonce) }))
        ]));
        if (delegateVote == null) {
            calls.push(leafCall(delegation, 'syncNonce', [], (r) => r[0].toNumber()));
        }
        const perUser = await batchCall(calls);
        if (delegateVote == null) {
            delegateVote = { voteStatus: 1, lastVoteSyncNonce: perUser.pop() };
        }
        var weights = {};
        users.forEach((user, i) => {
            const [userDelegate, weight, snap, info] = perUser[i];
            var contributed = 0;
            if (userDelegate.toLowerCase() == delegate.toLowerCase()) {
                if (info.voteStatus > 0) {
                    if (snap.snapNonce > info.lastVoteSyncNonce && snap.snapNonce <= delegateVote.lastVoteSyncNonce && weight > snap.preSyncWeight) {
                        contributed = weight - snap.preSyncWeight;
                    }
                } else if (delegateVote.voteStatus == 0 || snap.snapNonce == 0 || snap.snapNonce <= delegateVote.lastVoteSyncNonce) {
                    contributed = weight;
                } else {
                    contributed = snap.preSyncWeight;
                }
            }
            weights[user] = contributed;
        });
        return batched ? staticValue(weights) : weights;
    }

// GAUGE REGISTRY

    // vote() reverts with NotGauge if any gauge isn't in the platform's gauge registry.
    // Anyone can register a gauge with setGauge(address), but it only gets added if the
    // gauge controller knows it and it isn't killed, and never if the owner force removed it.
    // Returns { gauge: { registered, forceRemoved, addable } }.
    async function gaugeRegistryStatus(platform = "Curve", gauges, batched = false) {
        validatePlatform(platform, "gauge");
        const contract = contracts[`${platform}GaugeRegistry`];
        // isValidGauge reverts for addresses the gauge controller doesn't know: that means "not addable", and is
        // allowed to fail without sinking the multicall. Any other error (the RPC failing, say) throws.
        const groupedCalls = gauges.map(gauge => groupCalls([
            leafCall(contract, 'isRegisteredGauge', [gauge], (r) => r[0]),
            leafCall(contract, 'forceRemoved', [gauge], (r) => r[0]),
            leafCall(contract, 'isValidGauge', [gauge], (r) => r[0], { allowFailure: true })
        ], ([registered, forceRemoved, valid]) => ({ registered, forceRemoved, addable: !registered && !forceRemoved && valid === true })));
        const statusRaw = await batchCall(groupedCalls);
        var status = {};
        gauges.forEach((gauge, i) => {
            status[gauge] = statusRaw[i];
        });
        return batched ? staticValue(status) : status;
    }

    async function prepareSetGaugeTx(platform, gauge, signer) {
        validatePlatform(platform, "gauge");
        // setGauge is overloaded (gauge id / gauge address), so name the signature explicitly.
        const tx = await contracts[`${platform}GaugeRegistry`].connect(signer).populateTransaction["setGauge(address)"](gauge);
        return tx;
    }

// EXPORTS

    return {
    provider,
    contracts,
    batchCall,
    leafCall,
    groupCalls,
    staticValue,
    currentEpoch,
    gaugeProposalId,
    gaugeProposals,
    userVotingPower,
    usersVotingPowers,
    getAllLockedUsers,
    gaugeSyncedWeight,
    gaugeVoteTotal,
    gaugeDelegate,
    gaugeDelegatesAtEpoch,
    getGaugeCount,
    getGaugeEntry,
    getAllGaugeEntries,
    gaugeTotals,
    gaugeVoterCount,
    gaugeAllVoterAddresses,
    gaugeUserVote,
    gaugeAllVotes,
    getContributingWeights,
    prepareGaugeVoteTx,
    daoProposalCount,
    daoProposal,
    daoVoteTotal,
    daoUserVote,
    daoYesTotal,
    daoNoTotal,
    daoIsFinished,
    daoIsFinalized,
    daoIsDone,
    daoVoterCount,
    daoAllVoterAddresses,
    daoAllVotes,
    partnerDaoPlatforms,
    gaugeIsFinalized,
    gaugeIsDone,
    partnerProposalCount,
    partnerProposal,
    validatePlatform,
    snapshotGetNewProposals: snapshot.getNewProposals,
    snapshotGetVote: snapshot.getVote,
    snapshotHasVoted: snapshot.hasVoted,
    getCurveMetadata,
    userInfo,
    predictVoteWeight,
    predictContributingWeights,
    gaugeRegistryStatus,
    prepareSetGaugeTx
    };
};
