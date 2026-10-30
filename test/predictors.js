// Checks predictContributingWeights against Convex's own GaugeVoteHelper.getContributingWeights: for a delegate and
// its delegators, the prediction for the delegate's vote as it stands (its voteStatus and lastVoteSyncNonce) must
// equal what the helper returns, delegator by delegator, on Curve and f(x). Read-only.
//
// Usage: node test/predictors.js <rpc url> [block] [--users <file.json>] [--delegate <address>] [--proposal <id>]
//   block       pin every read to this block (needs an archive RPC, or a caching proxy)
//   --users     a JSON array of the addresses to check (default: the vlCVX lockers of the 20 weeks before the
//               block, from getAllLockedUsers, whose delegate at the proposal's epoch is the delegate)
//   --delegate  default Votium's delegate
//   --proposal  default each platform's latest gauge proposal at the block
// Exits 1 if any delegator's weights differ, or if there's no address to check.

const ethers = require('ethers');
const fs = require('fs');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const rpc = args[0];
const blockArg = args[1] && !args[1].startsWith('--') ? args[1] : null;
const block = blockArg === null ? null : Number(blockArg);
if (!rpc) {
    console.log('Usage: node test/predictors.js <rpc url> [block] [--users <file.json>] [--delegate <address>] [--proposal <id>]');
    process.exit(2);
}
// a typo would otherwise read as no block, and the test would run unpinned
if (block !== null && !(Number.isInteger(block) && block > 0)) {
    console.log(`Not a block number: ${blockArg}`);
    process.exit(2);
}

// every eth_call at the pinned block, if one is given, and that block as the latest one, so getAllLockedUsers scans
// the 20 weeks before it
class Pinned extends ethers.providers.StaticJsonRpcProvider {
    send(method, params) {
        if (block && method === 'eth_blockNumber') {
            return Promise.resolve('0x' + block.toString(16));
        }
        if (block && method === 'eth_call' && (params[1] === 'latest' || params[1] === undefined)) {
            params = [params[0], '0x' + block.toString(16)];
        }
        return super.send(method, params);
    }
}
const cvx = require('../cvxOnchain.js')({ provider: new Pinned(rpc, 1) });
const delegate = flag('--delegate') || '0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49';
const same = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

(async () => {
    const users = flag('--users') ? JSON.parse(fs.readFileSync(flag('--users'))) : null;
    // one log scan for both platforms, and one delegate lookup per epoch (Curve's and f(x)'s proposals usually share it)
    const lockers = users ? null : await cvx.getAllLockedUsers();
    const delegatesAt = {};
    let failed = 0;
    for (const platform of ['Curve', 'Fx']) {
        // the latest proposal at the block (the wall clock's "current" one may not exist yet there)
        const proposal = flag('--proposal') !== null
            ? Number(flag('--proposal'))
            : (await cvx.contracts[`${platform}GaugeVoting`].proposalCount()).toNumber() - 1;
        const epoch = (await cvx.gaugeProposals(platform, proposal)).epoch;
        let list = users;
        if (!list) {
            const delegates = delegatesAt[epoch] || (delegatesAt[epoch] = await cvx.gaugeDelegatesAtEpoch(lockers, epoch));
            list = lockers.filter((u) => delegates[u].toLowerCase() === delegate.toLowerCase());
        }
        if (list.length === 0) {
            console.log(`${platform} proposal ${proposal} (epoch ${epoch}${block ? ', block ' + block : ''}): no address to check`);
            failed++;
            continue;
        }
        const info = await cvx.userInfo(platform, proposal, delegate);
        const vote = { voteStatus: info.voteStatus, lastVoteSyncNonce: info.lastVoteSyncNonce };
        const [predicted, helper] = await Promise.all([
            cvx.predictContributingWeights(platform, proposal, delegate, list, vote),
            cvx.getContributingWeights(platform, proposal, delegate, list)
        ]);
        const differ = list.filter((u) => !same(predicted[u], helper[u]));
        const nonzero = list.filter((u) => helper[u] > 0).length;
        const total = list.reduce((t, u) => t + helper[u], 0);
        console.log(`${platform} proposal ${proposal} (epoch ${epoch}${block ? ', block ' + block : ''}), delegate vote status ${vote.voteStatus}, sync nonce ${vote.lastVoteSyncNonce}: `
            + `${list.length} addresses, ${nonzero} contributing ${total.toLocaleString('en-US', { maximumFractionDigits: 1 })} vlCVX, ${differ.length} differ`);
        for (const u of differ.slice(0, 10)) {
            console.log(`  ${u}: predicted ${predicted[u]}, helper ${helper[u]}`);
        }
        failed += differ.length;
    }
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
