// Check xo/built.json against the BCH 2026 VM using the real source outputs from chipnet (or NET=mainnet).
import { readFileSync } from 'node:fs';
import { ElectrumNetworkProvider } from 'cashscript';
import { createVirtualMachineBch2026, decodeTransaction, hexToBin, binToHex } from '@bitauth/libauth';
const built = JSON.parse(readFileSync(new URL('./built.json', import.meta.url)));
const tx = decodeTransaction(hexToBin(built.serializedTransaction));
const provider = new ElectrumNetworkProvider(process.env.NET === 'mainnet' ? 'mainnet' : 'chipnet');
const sourceOutputs = [];
for (const i of tx.inputs) {
  const prev = decodeTransaction(hexToBin(await provider.getRawTransaction(binToHex(i.outpointTransactionHash))));
  sourceOutputs.push(prev.outputs[i.outpointIndex]);
}
const result = createVirtualMachineBch2026().verify({ transaction: tx, sourceOutputs });
console.log(result === true ? 'VALID under BCH 2026 VM' : result);
console.log('outputs:', tx.outputs.map((o, k) => `#${k} ${o.valueSatoshis} sats${o.token ? ` token ${binToHex(o.token.category).slice(0, 8)} nft=${o.token.nft ? binToHex(o.token.nft.commitment) : '-'}` : ''}`).join(' | '));
process.exit(0);
