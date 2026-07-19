Work in progress!

Please review cvxGaugeVotes.js and demo.js for reference

Tested for Curve gauges. Known issue: new voting platform enforces using `rootGauge` for sidechain gauges, while some deposits may come in using just `gauge` address. During the transition, we will need to check curve gauge API to map incentives to correct mainnet gauge address.