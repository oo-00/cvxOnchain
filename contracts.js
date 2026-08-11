const ethers = require('ethers');

const accessoryContracts = {
  "CurveGaugeRegistry": "0x96b24E0534B0cA31D8523D4be4904747Fd579D95",
  "FxGaugeRegistry": "0xC2F99261d84D1665Df7e50F46813497A737AfB20",
  "GaugeDelegation": "0xb8270eef1319173dE9f5033FED442F638ff1607d",
  "GaugeVoteHelper": "0x76C484F67898EA978aa874dc7B32e648380FB9b1",
  "vlCVX": "0x72a19342e8F1838460eBFCCEf09F6585e32db86E",
  "ResupplyVoteExecutor": "0xEaC960e8bb7f24bCD566d148d9Ac1DAD66E07950",
  "CurveVoteExecutor": "0x98f98c2fc9683481c896BD912DE74537F36C6ada",
  "CurveGaugeExecutor": "0x399382E82D9b6362ccAbd1f3C763bEE93E80c9e8",
  "FxGaugeExecutor": "0xD2c4c902D3F6882Dd9E8C18218CBD788c7CD4835"
};

const gaugeVotingContracts = {
  "CurveGaugeVoting": "0x64D9B5AC386B70af9EDCD20A58cE9262D2EAC278",
  "FxGaugeVoting": "0xDcEa673B021f1f431E7D0Ec70a63bF8DcB6d44E6"
};

const daoVotingContracts = {
  "ConvexDaoVoting": "0x26674330B9696E052D70b4F971E46425761daCc2",
  "CurveDaoVoting": "0xE645F3d7b04BFFD67F5Ad4457c08E0C8FE1ddB89",
  "FraxDaoVoting": "0xC4df4415120C1305b7dd998a881e809fA6695f03",
  "FxDaoVoting": "0x51e08c14991387C2F5ad2E374eBc9B144FFC1E13",
  "ResupplyDaoVoting": "0xb463Cf769577aa062Cb72f5e1f8276eDF28914f3"
};

const partnerContracts = {
  "ResupplyVoter": "0x11111111063874cE8dC6232cb5C1C849359476E6",
  "FxGaugeController": "0xe60eB8098B34eD775ac44B1ddE864e098C6d7f37",
  "CurveGaugeController": "0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB",
  "CurveOwnership": "0xE478de485ad2fe566d49342Cbd03E49ed7DB3356",
  "CurveParameter": "0xBCfF8B0b9419b9A88c44546519b1e909cF330399"
};



var abis = {};
for (const name in accessoryContracts) {
  abis[name] = require(`./abi/${name}.json`);
}
abis["GaugeVoting"] = require(`./abi/GaugeVoting.json`);
abis["DaoVoting"] = require(`./abi/DaoVoting.json`);
for (const name in partnerContracts) {
  abis[name] = require(`./abi/partners/${name}.json`);
}

module.exports = function (provider) {
  const contracts = {};
  for (const name in accessoryContracts) {
    contracts[name] = new ethers.Contract(accessoryContracts[name], abis[name], provider);
  }
  for (const name in gaugeVotingContracts) {
    contracts[name] = new ethers.Contract(gaugeVotingContracts[name], abis["GaugeVoting"], provider);
  }
  for (const name in daoVotingContracts) {
    contracts[name] = new ethers.Contract(daoVotingContracts[name], abis["DaoVoting"], provider);
  }
  for (const name in partnerContracts) {
    contracts[name] = new ethers.Contract(partnerContracts[name], abis[name], provider);
  }
  
  return contracts;
}