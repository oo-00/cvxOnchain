const ethers = require('ethers');

const addresses = {
  "CurveGaugeRegistry": "0x96b24E0534B0cA31D8523D4be4904747Fd579D95",
  "CurveGaugeVoting": "0x64D9B5AC386B70af9EDCD20A58cE9262D2EAC278",
  "FxGaugeRegistry": "0xC2F99261d84D1665Df7e50F46813497A737AfB20",
  "FxGaugeVoting": "0xDcEa673B021f1f431E7D0Ec70a63bF8DcB6d44E6",
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