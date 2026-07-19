const ethers = require('ethers');

const addresses = {
  "CurveGaugeRegistry": "0x96b24E0534B0cA31D8523D4be4904747Fd579D95",
  "CurveGaugeVoting": "0x21F304a9DF75E087A035B4c5792bD4e6BB7AF8aF",
  "FxGaugeRegistry": "0xC2F99261d84D1665Df7e50F46813497A737AfB20",
  "FxGaugeVoting": "0xC3701a7696Cd41a4E3e107B8A7b897A3aFB4c50a",
  "GaugeDelegation": "0xb8270eef1319173dE9f5033FED442F638ff1607d",
  "GaugeVoteHelper": "0x76C484F67898EA978aa874dc7B32e648380FB9b1",
  "vlCVX": "0x72a19342e8F1838460eBFCCEf09F6585e32db86E"
};

var abis = {};
for (const name in addresses) {
  abis[name] = require(`./abi/${name}.json`);
}

module.exports = function (provider) {
  const contracts = {};
  for (const [name, address] of Object.entries(addresses)) {
    contracts[name] = new ethers.Contract(address, abis[name], provider);
  }
  return contracts;
}