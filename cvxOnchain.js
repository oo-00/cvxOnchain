// SETUP 
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

    // Snapshot (off-chain) voting helper for partner platforms that use Snapshot.
    const snapshot = require('./snapshot.js');

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
            epoch = await currentEpoch();
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

// GAUGE VOTING FUNCTIONS
    async function gaugeProposals(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('proposals', [proposalId]),
            decode: (data) => contract.interface.decodeFunctionResult('proposals', data)
        };
        return resolveCall(call, batched);
    }

    async function gaugeDelegate(userAddress, batched = false) {
        var epoch = await currentEpoch();
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

    async function gaugeDelegatesAtEpoch(userArray, epoch = "current", batched = false) {
        if(epoch === "current") {
            epoch = await currentEpoch();
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

    async function gaugeSyncedWeight(userAddress, batched = false) {
        const contract = contracts.GaugeDelegation;
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('getUserWeight', [userAddress]),
            decode: (data) => toUnits(contract.interface.decodeFunctionResult('getUserWeight', data)[0])
        };
        return resolveCall(call, batched);
    }

    async function gaugeVoteTotal(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
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
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
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
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
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
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
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
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
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

    async function gaugeVoterCount(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('getVoterCount', [proposalId]),
            decode: (data) => contract.interface.decodeFunctionResult('getVoterCount', data)[0].toNumber()
        };
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

    async function gaugeUserVote(platform = "Curve", proposalId = "current", userAddress, batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
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

    async function gaugeAllVotes(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const voterAddresses = await gaugeAllVoterAddresses(platform, proposalId);
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

    async function gaugeIsFinalized(platform = "Curve", proposalId = "current", batched = false) {
        validatePlatform(platform, "gauge");
        if(proposalId === "current") {
            proposalId = await gaugeProposalId();
        }
        const contract = contracts[`${platform}GaugeVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('isFinalized', [proposalId]),
            decode: (data) => contract.interface.decodeFunctionResult('isFinalized', data)[0]
        };
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
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('isDone', [proposalId]),
            decode: (data) => contract.interface.decodeFunctionResult('isDone', data)[0]
        };
        return resolveCall(call, batched);
    }

// DAO VOTING FUNCTIONS

    async function daoProposalCount(platform = "Convex", batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('proposalCount', []),
            decode: (data) => contract.interface.decodeFunctionResult('proposalCount', data)[0].toNumber()
        };
        return resolveCall(call, batched);
    }

    async function daoProposal(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('proposals', [proposalId]),
            decode: (data) => {
                const [startTime, endTime, epoch, voteType, nativeId] = contract.interface.decodeFunctionResult('proposals', data);
                return {
                    startTime,
                    endTime,
                    epoch,
                    voteType,
                    nativeId: toUnits(nativeId, 0)
                };
            }
        };
        return resolveCall(call, batched);
    }

    async function daoVoteTotal(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('voteTotals', [proposalId]),
            decode: (data) => toUnits(contract.interface.decodeFunctionResult('voteTotals', data)[0])
        };
        return resolveCall(call, batched);
    }

    async function daoUserVote(platform = "Convex", proposalId, userAddress, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('getVote', [proposalId, userAddress]),
            decode: (data) => {
                const [voted, weight] = contract.interface.decodeFunctionResult('getVote', data);
                return {
                    voted,
                    weight: toUnits(weight)
                };
            }
        };
        return resolveCall(call, batched);
    }

    async function daoYesTotal(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('getYes', [proposalId]),
            decode: (data) => toUnits(contract.interface.decodeFunctionResult('getYes', data)[0])
        };
        return resolveCall(call, batched);
    }

    async function daoNoTotal(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('getNo', [proposalId]),
            decode: (data) => toUnits(contract.interface.decodeFunctionResult('getNo', data)[0])
        };
        return resolveCall(call, batched);
    }

    async function daoIsFinished(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('isFinished', [proposalId]),
            decode: (data) => contract.interface.decodeFunctionResult('isFinished', data)[0]
        };
        return resolveCall(call, batched);
    }

    async function daoIsFinalized(platform = "Convex", proposalId, batched = false) {
        validatePlatform(platform, "dao");
        const contract = contracts[`${platform}DaoVoting`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('isFinalized', [proposalId]),
            decode: (data) => contract.interface.decodeFunctionResult('isFinalized', data)[0]
        };
        return resolveCall(call, batched);
    }

    async function daoIsDone(platform = "Curve", proposalId, batched = false) {
        if(platform !== "Curve" && platform !== "Resupply") {
            throw new Error('Invalid platform. Must be "Curve" or "Resupply".');
        }
        const contract = contracts[`${platform}VoteExecutor`];
        const call = {
            target: contract.address,
            callData: contract.interface.encodeFunctionData('isDone', [proposalId]),
            decode: (data) => contract.interface.decodeFunctionResult('isDone', data)[0]
        };
        return resolveCall(call, batched);
    }

// PARTNER VOTING FUNCTIONS

    const partnerDaoPlatforms = ["ResupplyVoter", "CurveOwnership", "CurveParameter", "fxn.eth", "frax.eth"];

    async function partnerProposalCount(platform, batched = false) {
        if(!partnerDaoPlatforms.includes(platform)) {
            throw new Error(`Invalid platform. Must be one of: ${partnerDaoPlatforms.join(", ")}`);
        }
        const contract = contracts[platform];
        if(platform === "CurveOwnership" || platform === "CurveParameter") {
            const call = {
                target: contract.address,
                callData: contract.interface.encodeFunctionData('votesLength', []),
                decode: (data) => toUnits(contract.interface.decodeFunctionResult('votesLength', data)[0], 0)
            };
            return resolveCall(call, batched);
        }
        if(platform === "ResupplyVoter") {
            const call = {
                target: contract.address,
                callData: contract.interface.encodeFunctionData('getProposalCount', []),
                decode: (data) => toUnits(contract.interface.decodeFunctionResult('getProposalCount', data)[0], 0)
            };
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
            const call = {
                target: contract.address,
                callData: contract.interface.encodeFunctionData('getVote', [proposalId]),
                decode: (data) => {
                    const [open, executed, startDate, snapshotBlock, supportRequired, minAcceptQuorum, yea, nay, votingPower, script] = contract.interface.decodeFunctionResult('getVote', data);
                    return { 
                        start: toUnits(startDate, 0),
                        voteType: platform === "CurveOwnership" ? 0 : 1,
                        cvxId: null,
                        script: script
                    };
                }
            };
            return resolveCall(call, batched);
        } else if(platform === "ResupplyVoter") {
            const call = {
                target: contract.address,
                callData: contract.interface.encodeFunctionData('getProposalData', [proposalId]),
                decode: (data) => {
                    const [description, epoch, createdAt, quorumWeight, weightYes,weightNo,processed,executable,payload] = contract.interface.decodeFunctionResult('getProposalData', data);
                    return { 
                        description,
                        start: toUnits(createdAt, 0),
                        voteType: 0,
                        cvxId: null,
                        payload
                    };
                }
            };
            return resolveCall(call, batched);
        } else if(platform === "fxn.eth" || platform === "frax.eth") {
            var proposals = await snapshot.getNewProposals(platform, proposalId);
            var formattedProposals = {};
            if(proposals.length == 0) {
                return null;
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
                    formattedProposals[nativeId] = {
                        snapshotId: proposals[i].id,
                        description: proposals[i].title,
                        start: proposals[i].start,
                        voteType: 0,
                        cvxId: null
                    };
                }
            }
            return formattedProposals;
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
        // use indexed event filter to get the StartVote event for the proposalId
        // begin at latest block and search in batches of eventBlocksLimit blocks back until we find the event
        // eventBlocksLimit and eventConcurrentLimit are already defined in the config
        const latestBlock = await provider.getBlockNumber();
        const filter = contract.filters.StartVote(proposalId);
        var fromBlock = latestBlock - eventBlocksLimit;
        if(fromBlock < 0) {
            fromBlock = 0;
        }
        var toBlock = latestBlock;
        var events = [];
        while(fromBlock <= latestBlock) {
            events = await contract.queryFilter(filter, fromBlock, toBlock);
            if(events.length > 0) {
                break;
            }
            fromBlock = Math.max(0, fromBlock - eventBlocksLimit);
            toBlock = fromBlock + eventBlocksLimit - 1;
        }
        if(events.length == 0) {
            throw new Error(`No StartVote event found for proposalId ${proposalId} in the last ${eventBlocksLimit} blocks`);
        }
        const metadata = events[0].args.metadata;
        // check if metadata is ipfs:// or ipns:// and if so, fetch the metadata from ipfs
        if(metadata.startsWith("ipfs:") || metadata.startsWith("ipns:")) {
            console.log("Fetching metadata from IPFS for proposalId", proposalId);
            var ipfsHash = metadata.split(":")[1];
            // check if ipfsHash starts with // and remove it
            if(ipfsHash.startsWith("//")) {
                ipfsHash = ipfsHash.substring(2);
            }
            const ipfsUrl = `https://ipfs.io/ipfs/${ipfsHash}`;
            const response = await fetch(ipfsUrl);
            if(!response.ok) {
                throw new Error(`Failed to fetch metadata from IPFS: ${response.status} ${response.statusText}`);
            }
            var ipfsMetadata = await response.json();
            var metaText = ipfsMetadata.text;
            return batched ? staticValue(metaText) : metaText;
        }
        return batched ? staticValue(metadata) : metadata;
    }

// EXPORTS

module.exports = {
    batchCall,
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
    gaugeIsFinalized,
    gaugeIsDone,
    partnerProposalCount,
    partnerProposal,
    validatePlatform,
    snapshotGetNewProposals: snapshot.getNewProposals,
    snapshotGetVote: snapshot.getVote,
    snapshotHasVoted: snapshot.hasVoted,
    getCurveMetadata
};