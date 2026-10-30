# cvxOnchain

Reads, and unsigned transaction builders, for Convex's on-chain vlCVX voting: gauge votes on
Curve and f(x), DAO votes, delegation and vlCVX balances. Convex data only: Votium's own
contracts (deposits, opt-out registries) are read by [votium.js](https://github.com/oo-00/votium.js).

## Install

```json
"dependencies": { "cvxonchain": "github:oo-00/cvxOnchain#v1.0.0" }
```

## Use

```js
const cvx = require('cvxonchain')({ rpc: process.env.RPC_URL });
// or pass your own ethers v5 provider: require('cvxonchain')({ provider })

const proposalId = cvx.gaugeProposalId();
const votes = await cvx.gaugeAllVotes('Curve', proposalId);
```

There's no settings file: options are passed in, and no RPC call is made until you call a function. Options:

| Option | Default | Meaning |
|---|---|---|
| `rpc` or `provider` | required | mainnet RPC URL, or an ethers v5 provider |
| `batchLimit` | 100 | max view calls per Multicall3 request |
| `eventBlocksLimit` | 10000 | block range per log query |
| `eventConcurrentLimit` | 5 | log queries in flight |
| `sleepTime` | 500 | ms between chunked requests |

Most read functions take a trailing `batched` flag: pass `true` to get a call descriptor you
can combine with others in one `batchCall([...])` multicall. Functions that read a list (all
voters or votes, many users or gauges), the predictors and the log scans still make their own
requests right away: in batched mode they return the finished value, which takes one slot.

For your own view calls, `leafCall(contract, fn, args, decode, { allowFailure })` builds an
entry, `groupCalls(calls, combine)` turns several into one result, and `staticValue(value)` adds
a value you already have. A batch of more than `batchLimit` calls is split into several requests,
all read at the same block. If your own provider pins reads to a block, have it answer
`eth_blockNumber` with that block too.

`demo.js` shows the main reads. It loads its options from `settings.json`, which git ignores: copy
`settings.example.json` to `settings.json` and put your RPC URL there.

`node test/predictors.js <rpc url> [block]` checks `predictContributingWeights` against Convex's on-chain
`GaugeVoteHelper.getContributingWeights` for Votium's delegators (see the file for the options).

## What's in it

- **Gauge voting:** proposals, totals, per-gauge totals, voters and their votes, delegation
  (`gaugeDelegatesAtEpoch`), contributed weights (`getContributingWeights`), and the
  predictors `predictVoteWeight` / `predictContributingWeights`, which reproduce the platform
  and GaugeVoteHelper logic for a vote not yet cast.
- **Gauge registry:** `gaugeRegistryStatus` (registered, force-removed, addable) and
  `prepareSetGaugeTx`.
- **DAO voting** (Convex, Curve, f(x), Frax, Resupply), partner proposals, Snapshot helpers,
  and Curve proposal metadata.
- **`provider` and `contracts`**, exposed for direct calls.

Sidechain gauges: the vote platform only accepts the `rootGauge` address, while deposits may
use the sidechain `gauge`. Map one to the other with Curve's `getAllGauges` API.

## Upgrading from earlier versions

Before 1.0.0, cvxOnchain was a module configured by a tracked `settings.json`. Now:

- `require('cvxonchain')` returns a function: call it with your options,
  `require('cvxonchain')({ rpc })`, and use what it returns as before.
- `settings.json` is no longer tracked. If you edited yours, move it out of the repository before
  pulling (git won't overwrite it) and back afterwards, when it's ignored; an unedited one is
  removed. Pass its values as options instead (`demo.js` still reads one: copy
  `settings.example.json`).
- `daoUserVote` returns `{ voted, yesWeight, noWeight, baseWeight, adjustedWeight }`, as each
  entry of `daoAllVotes` does. Its old `weight` was the yes share in basis points, misread as a
  vlCVX amount.
- `partnerProposal` on fxn.eth and frax.eth: each proposal also carries `nativeId`, and one whose
  title has no FIP number is keyed by its Snapshot id (they used to overwrite each other under
  `null`).
