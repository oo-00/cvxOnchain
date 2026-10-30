// options from settings.json (untracked: copy settings.example.json and put your RPC URL in it)
const fs = require('fs');
if (!fs.existsSync(__dirname + '/settings.json')) {
    console.log('No settings.json: copy settings.example.json to settings.json and set your RPC URL there.');
    process.exit(1);
}
const cvxOnchain = require('./cvxOnchain')(require('./settings.json'));

var sleepTime = 500; // milliseconds for rpc limits

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gaugeDemo() {

    // Current Epoch, no contract calls needed
    var currentEpoch = await cvxOnchain.currentEpoch();
    console.log(`
        cvxOnchain.currentEpoch():
            Returns the current epoch number, based on a 7-day schedule starting from 1646265600.
        
            Result:    ${currentEpoch}
    `);

    // Current Proposal ID, no contract calls needed
    var currentProposalId = await cvxOnchain.gaugeProposalId();
    console.log(`
        cvxOnchain.gaugeProposalId():
            Returns the current proposal ID, based on the current epoch number.
        
            Result:    ${currentProposalId}
    `);

    // Proposal details, 1 contract call
    var proposalDetails = await cvxOnchain.gaugeProposals("Curve", 0);
    console.log(`
        cvxOnchain.gaugeProposals():
            Accepts platform ("Curve" or "Fx", default is "Curve") and a proposal ID (default is "current").
            Returns the proposal details for the specified proposal ID.
        
            Result:    ${JSON.stringify(proposalDetails)}
    `);
    await sleep(sleepTime);

    // User voting power, 2 contract calls
    var userVotingPower = await cvxOnchain.userVotingPower("0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49");
    console.log(`
        cvxOnchain.userVotingPower():
            Accepts a user address and an optional epoch number (default is "current").
            Returns an array of [basePower, delegatedPower] for the user at the specified epoch.
        
            Result:    ${JSON.stringify(userVotingPower)}
    `);
    await sleep(sleepTime);

    // Get delegate, 2 contract calls
    var delegate = await cvxOnchain.gaugeDelegate("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e");
    console.log(`
        cvxOnchain.gaugeDelegate():
            Accepts a user address and returns an array with the current and future delegate addresses for the user.
        
            Result:    ${JSON.stringify(delegate)}
    `);
    await sleep(sleepTime);

    // User synced weight, 1 contract call
    var gaugeSyncedWeight = await cvxOnchain.gaugeSyncedWeight("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e");
    console.log(`
        cvxOnchain.gaugeSyncedWeight():
            Accepts a user address and returns the user's synced weight from the GaugeDelegation contract.
        
            Result:    ${JSON.stringify(gaugeSyncedWeight)}
    `);
    await sleep(sleepTime);

    // Vote totals, 1 contract call
    var voteTotal = await cvxOnchain.gaugeVoteTotal("Curve", 0);
    console.log(`
        cvxOnchain.gaugeVoteTotal():
            Accepts platform ("Curve" or "Fx", default is "Curve") and a proposal ID (default is "current").
            Returns the total votes for the specified proposal ID.
        
            Result:    ${JSON.stringify(voteTotal)}
    `);
    await sleep(sleepTime);


    // Gauge totals, locally batched multicall
    var gaugeTotals = await cvxOnchain.gaugeTotals("Curve", "current", ["0xeCBcF829742987c0600e0ee1117a32d09451882E", "0xCFc25170633581Bf896CB6CDeE170e3E3Aa59503", "0x26F7786de3E6D9Bd37Fcf47BE6F2bC455a21b74A"]);
    console.log(`
        cvxOnchain.gaugeTotals():
            Accepts a platform, a proposal ID, and an array of gauge addresses.
            Returns the total votes for each specified gauge.
        
            Result:    ${JSON.stringify(gaugeTotals)}
    `);
    await sleep(sleepTime);

    // Get voter count, 1 contract call
    var voterCount = await cvxOnchain.gaugeVoterCount("Curve", "current");
    console.log(`
        cvxOnchain.gaugeVoterCount():
            Accepts a platform and a proposal ID.
            Returns the total number of voters for the specified proposal.
        
            Result:    ${JSON.stringify(voterCount)}
    `);
    await sleep(sleepTime);

    // Get all voter addresses, locally batched multicall
    var voterAddresses = await cvxOnchain.gaugeAllVoterAddresses("Curve", "current");
    console.log(`
        cvxOnchain.gaugeAllVoterAddresses():
            Accepts a platform and a proposal ID.
            Returns an array of all voter addresses for the specified proposal.
        
            Result:    ${JSON.stringify(voterAddresses)}
    `);
    await sleep(sleepTime);

    // Get user vote, 1 contract call
    var userVote = await cvxOnchain.gaugeUserVote("Curve", "current", "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49");
    console.log(`
        cvxOnchain.gaugeUserVote():
            Accepts a platform, a proposal ID, and a user address.
            Returns the user's vote details for the specified proposal.
        
            Result:    ${JSON.stringify(userVote)}
    `);
    await sleep(sleepTime); 

    

    // getAllLockedUsers
    var lockedUsers = await cvxOnchain.getAllLockedUsers();
    console.log(`
        cvxOnchain.getAllLockedUsers():
            Returns an array of all users who have locked vlCVX tokens.
        
            Result:    ${JSON.stringify(lockedUsers)}
    `);
    await sleep(sleepTime);

    
    var allVotes = await cvxOnchain.gaugeAllVotes("Curve", "current");
    console.log(allVotes);


    var [epoch, propId, propData, userPower, delegate, userWeight, voteTotal, gaugeEntries, gaugeTotals, voterCount, voterAddresses, userVote] = await cvxOnchain.batchCall([
        cvxOnchain.currentEpoch(true),
        cvxOnchain.gaugeProposalId(true),
        cvxOnchain.gaugeProposals("Curve", "current", true),
        cvxOnchain.userVotingPower("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", "current", true),
        cvxOnchain.gaugeDelegate("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", true),
        cvxOnchain.gaugeSyncedWeight("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", true),
        cvxOnchain.gaugeVoteTotal("Curve", "current", true),
        cvxOnchain.getAllGaugeEntries("Curve", "current", true),
        cvxOnchain.gaugeTotals("Curve", "current", ["0xeCBcF829742987c0600e0ee1117a32d09451882E", "0xCFc25170633581Bf896CB6CDeE170e3E3Aa59503", "0x26F7786de3E6D9Bd37Fcf47BE6F2bC455a21b74A"], true),
        cvxOnchain.gaugeVoterCount("Curve", "current", true),
        cvxOnchain.gaugeAllVoterAddresses("Curve", "current", true),
        cvxOnchain.gaugeUserVote("Curve", "current", "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49", true)
    ]);
    console.log(`
        cvxOnchain.batchCall():
            Accepts an array of batched-mode calls (each a Promise resolving to a descriptor),
            compacts all involved contract calls into a single multicall, and returns decoded results in order.

            Note: Must include "true" as final argument in batched calls.
        
            Result:
            cvxOnchain.currentEpoch(): ${JSON.stringify(epoch)}
            cvxOnchain.gaugeProposalId(): ${JSON.stringify(propId)}
            cvxOnchain.gaugeProposals("Curve", "current", true): ${JSON.stringify(propData)}
            cvxOnchain.userVotingPower("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", "current", true): ${JSON.stringify(userPower)}
            cvxOnchain.gaugeDelegate("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", true): ${JSON.stringify(delegate)}
            cvxOnchain.gaugeSyncedWeight("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", true): ${JSON.stringify(userWeight)}
            cvxOnchain.gaugeVoteTotal("Curve", "current", true): ${JSON.stringify(voteTotal)}
            cvxOnchain.getAllGaugeEntries("Curve", "current", true):
${JSON.stringify(gaugeEntries, null, 2)}
            cvxOnchain.gaugeTotals("Curve", "current", ["0xeCBcF829742987c0600e0ee1117a32d09451882E", "0xCFc25170633581Bf896CB6CDeE170e3E3Aa59503", "0x26F7786de3E6D9Bd37Fcf47BE6F2bC455a21b74A"], true):
${JSON.stringify(gaugeTotals, null, 2)}
            cvxOnchain.gaugeVoterCount("Curve", "current", true): ${JSON.stringify(voterCount)}
            cvxOnchain.gaugeAllVoterAddresses("Curve", "current", true): ${JSON.stringify(voterAddresses)}
            cvxOnchain.gaugeUserVote("Curve", "current", "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49", true): ${JSON.stringify(userVote)}
    `);

    // Check if user has new locks that need synced
    if(Math.floor(userPower*10)/10 > userWeight) {
        console.log("User has new locks that need synced!");
    } else {
        console.log("User is fully synced.");
    }
}

async function daoDemo() {
    const platforms = ["Convex", "Curve", "Frax", "Fx", "Resupply"];
    for(const platform of platforms) {
        const count = await cvxOnchain.daoProposalCount(platform);
        console.log(count);
        console.log(`cvxOnchain.daoProposalCount(${platform}, "current"): ${count}`);
        await sleep(sleepTime);
        if(count > 0) {
            const proposalNumber = count - 1;
            const proposal = await cvxOnchain.daoProposal(platform, proposalNumber);
            console.log(`cvxOnchain.daoProposal(${platform}, ${proposalNumber}): ${JSON.stringify(proposal)}`);
            await sleep(sleepTime);
            const yesTotal = await cvxOnchain.daoYesTotal(platform, proposalNumber);
            console.log(`cvxOnchain.daoYesTotal(${platform}, ${proposalNumber}): ${yesTotal}`);
            await sleep(sleepTime);
            const noTotal = await cvxOnchain.daoNoTotal(platform, proposalNumber);
            console.log(`cvxOnchain.daoNoTotal(${platform}, ${proposalNumber}): ${noTotal}`);
            await sleep(sleepTime);
        }

    }
}

gaugeDemo();
daoDemo();