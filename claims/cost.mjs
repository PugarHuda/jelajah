// Monthly push (today) vs pull claims (this design), in satoshis. Sizes are exact: the claim size is the
// real depth-16 claim tx accepted on chipnet; the push output is a P2PKH token output as FoldingCash sends it.
//   node claims/cost.mjs
import { calculateDust, getOutputSize } from 'cashscript/dist/utils.js';
import { hexToBin } from '@bitauth/libauth';

const pushOutput = { to: hexToBin('76a914' + '11'.repeat(20) + '88ac'), amount: 0n, token: { category: '22'.repeat(32), amount: 123456789n } };
const outSize = getOutputSize(pushOutput);
const dust = calculateDust(pushOutput);
const FEE = 1;                    // sat/byte
const CLAIM_TX = 2361;            // bytes, depth-16 claim on chipnet (see README)
const ROOT_UPDATE = 400 + 600;    // propose + activate, bytes
const TX_OVERHEAD = 10 + 150;     // version/locktime + one funding input

const rows = [62, 300, 10_000].map((n) => {
  const push = n * (dust + outSize * FEE) + TX_OVERHEAD * FEE;
  const pullOperator = ROOT_UPDATE * FEE;
  return { folders: n, pushPerMonth: push, pullOperatorPerMonth: pullOperator, pullPerClaimPaidByFolder: CLAIM_TX * FEE + dust };
});
console.log(`token output: ${outSize} bytes, dust ${dust} sats`);
console.table(rows);
console.log('A folder who claims once a year pays one claim; under push the operator pays that folder 12 outputs a year.');
