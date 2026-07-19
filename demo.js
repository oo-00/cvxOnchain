const cvxGaugeVotes = require('./cvxGaugeVotes');

var sleepTime = 500; // milliseconds for rpc limits

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function demo() {

    /*
    // Current Epoch, no contract calls needed
    var currentEpoch = await cvxGaugeVotes.currentEpoch();
    console.log(`
        cvxGaugeVotes.currentEpoch():
            Returns the current epoch number, based on a 7-day schedule starting from 1646265600.
        
            Result:    ${currentEpoch}
    `);

    // Current Proposal ID, no contract calls needed
    var currentProposalId = await cvxGaugeVotes.currentProposalId();
    console.log(`
        cvxGaugeVotes.currentProposalId():
            Returns the current proposal ID, based on the current epoch number.
        
            Result:    ${currentProposalId}
    `);

    // Proposal details, 1 contract call
    var proposalDetails = await cvxGaugeVotes.proposals(0, "Curve");
    console.log(`
        cvxGaugeVotes.proposals():
            Accepts a proposal ID and an optional platform ("Curve" or "Fx", default is "Curve").
            Returns the proposal details for the specified proposal ID.
        
            Result:    ${JSON.stringify(proposalDetails)}
    `);
    await sleep(sleepTime);

    // User voting power, 2 contract calls
    var userVotingPower = await cvxGaugeVotes.userVotingPower("0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49");
    console.log(`
        cvxGaugeVotes.userVotingPower():
            Accepts a user address and an optional epoch number (default is "current").
            Returns an array of [basePower, delegatedPower] for the user at the specified epoch.
        
            Result:    ${JSON.stringify(userVotingPower)}
    `);
    await sleep(sleepTime);

    // Get delegate, 2 contract calls
    var delegate = await cvxGaugeVotes.getDelegate("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e");
    console.log(`
        cvxGaugeVotes.getDelegate():
            Accepts a user address and returns an array with the current and future delegate addresses for the user.
        
            Result:    ${JSON.stringify(delegate)}
    `);
    await sleep(sleepTime);

    // User synced weight, 1 contract call
    var userSyncedWeight = await cvxGaugeVotes.userSyncedWeight("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e");
    console.log(`
        cvxGaugeVotes.userSyncedWeight():
            Accepts a user address and returns the user's synced weight from the GaugeDelegation contract.
        
            Result:    ${JSON.stringify(userSyncedWeight)}
    `);
    await sleep(sleepTime);

    // Vote totals, 1 contract call
    var voteTotal = await cvxGaugeVotes.voteTotal(0, "Curve");
    console.log(`
        cvxGaugeVotes.voteTotal():
            Accepts a proposal ID and an optional platform ("Curve" or "Fx", default is "Curve").
            Returns the total votes for the specified proposal ID.
        
            Result:    ${JSON.stringify(voteTotal)}
    `);
    await sleep(sleepTime);


    // Gauge totals, locally batched multicall
    var gaugeTotals = await cvxGaugeVotes.gaugeTotals("Curve", "current", ["0xeCBcF829742987c0600e0ee1117a32d09451882E", "0xCFc25170633581Bf896CB6CDeE170e3E3Aa59503", "0x26F7786de3E6D9Bd37Fcf47BE6F2bC455a21b74A"]);
    console.log(`
        cvxGaugeVotes.gaugeTotals():
            Accepts a platform, a proposal ID, and an array of gauge addresses.
            Returns the total votes for each specified gauge.
        
            Result:    ${JSON.stringify(gaugeTotals)}
    `);
    await sleep(sleepTime);

    // Get voter count, 1 contract call
    var voterCount = await cvxGaugeVotes.getVoterCount("Curve", "current");
    console.log(`
        cvxGaugeVotes.getVoterCount():
            Accepts a platform and a proposal ID.
            Returns the total number of voters for the specified proposal.
        
            Result:    ${JSON.stringify(voterCount)}
    `);
    await sleep(sleepTime);

    // Get all voter addresses, locally batched multicall
    var voterAddresses = await cvxGaugeVotes.getAllVoterAddresses("Curve", "current");
    console.log(`
        cvxGaugeVotes.getAllVoterAddresses():
            Accepts a platform and a proposal ID.
            Returns an array of all voter addresses for the specified proposal.
        
            Result:    ${JSON.stringify(voterAddresses)}
    `);
    await sleep(sleepTime);

    // Get user vote, 1 contract call
    var userVote = await cvxGaugeVotes.getVote("Curve", "current", "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49");
    console.log(`
        cvxGaugeVotes.getVote():
            Accepts a platform, a proposal ID, and a user address.
            Returns the user's vote details for the specified proposal.
        
            Result:    ${JSON.stringify(userVote)}
    `);
    await sleep(sleepTime); 

    

    // getAllLockedUsers
    var lockedUsers = await cvxGaugeVotes.getAllLockedUsers();
    console.log(`
        cvxGaugeVotes.getAllLockedUsers():
            Returns an array of all users who have locked vlCVX tokens.
        
            Result:    ${JSON.stringify(lockedUsers)}
    `);
    await sleep(sleepTime);

    
    var allVotes = await cvxGaugeVotes.getAllVotes("Curve", "current");
    console.log(allVotes);

    */

    var [epoch, propId, propData, userPower, delegate, userWeight, voteTotal, gaugeEntries, gaugeTotals, voterCount, voterAddresses, userVote] = await cvxGaugeVotes.batchCall([
        cvxGaugeVotes.currentEpoch(true),
        cvxGaugeVotes.currentProposalId(true),
        cvxGaugeVotes.proposals("Curve", "current", true),
        cvxGaugeVotes.userVotingPower("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", "current", true),
        cvxGaugeVotes.getDelegate("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", true),
        cvxGaugeVotes.userSyncedWeight("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", true),
        cvxGaugeVotes.voteTotal("Curve", "current", true),
        cvxGaugeVotes.getAllGaugeEntries("Curve", "current", true),
        cvxGaugeVotes.gaugeTotals("Curve", "current", ["0xeCBcF829742987c0600e0ee1117a32d09451882E", "0xCFc25170633581Bf896CB6CDeE170e3E3Aa59503", "0x26F7786de3E6D9Bd37Fcf47BE6F2bC455a21b74A"], true),
        cvxGaugeVotes.getVoterCount("Curve", "current", true),
        cvxGaugeVotes.getAllVoterAddresses("Curve", "current", true),
        cvxGaugeVotes.getVote("Curve", "current", "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49", true)
    ]);
    console.log(`
        cvxGaugeVotes.batchCall():
            Accepts an array of batched-mode calls (each a Promise resolving to a descriptor),
            compacts all involved contract calls into a single multicall, and returns decoded results in order.

            Note: Must include "true" as final argument in batched calls.
        
            Result:
            cvxGaugeVotes.currentEpoch(): ${JSON.stringify(epoch)}
            cvxGaugeVotes.currentProposalId(): ${JSON.stringify(propId)}
            cvxGaugeVotes.proposals("Curve", "current", true): ${JSON.stringify(propData)}
            cvxGaugeVotes.userVotingPower("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", "current", true): ${JSON.stringify(userPower)}
            cvxGaugeVotes.getDelegate("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", true): ${JSON.stringify(delegate)}
            cvxGaugeVotes.userSyncedWeight("0xAdE9e51C9E23d64E538A7A38656B78aB6Bcc349e", true): ${JSON.stringify(userWeight)}
            cvxGaugeVotes.voteTotal("Curve", "current", true): ${JSON.stringify(voteTotal)}
            cvxGaugeVotes.getAllGaugeEntries("Curve", "current", true):
${JSON.stringify(gaugeEntries, null, 2)}
            cvxGaugeVotes.gaugeTotals("Curve", "current", ["0xeCBcF829742987c0600e0ee1117a32d09451882E", "0xCFc25170633581Bf896CB6CDeE170e3E3Aa59503", "0x26F7786de3E6D9Bd37Fcf47BE6F2bC455a21b74A"], true):
${JSON.stringify(gaugeTotals, null, 2)}
            cvxGaugeVotes.getVoterCount("Curve", "current", true): ${JSON.stringify(voterCount)}
            cvxGaugeVotes.getAllVoterAddresses("Curve", "current", true): ${JSON.stringify(voterAddresses)}
            cvxGaugeVotes.getVote("Curve", "current", "0xde1E6A7ED0ad3F61D531a8a78E83CcDdbd6E0c49", true): ${JSON.stringify(userVote)}
    `);

    // Check if user has new locks that need synced
    if(Math.floor(userPower*10)/10 > userWeight) {
        console.log("User has new locks that need synced!");
    } else {
        console.log("User is fully synced.");
    }

}

demo();