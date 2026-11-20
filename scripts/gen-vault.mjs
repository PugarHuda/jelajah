// Fill RewardVault2's MINTER_TEMPLATE with the compiled StampMinter3 bytecode (no constructor args), so the vault can
// derive a new stall's minter address on chain. Run after compiling StampMinter3 (npm run contracts does both).
import { readFileSync, writeFileSync } from 'node:fs';
const minter = JSON.parse(readFileSync(new URL('../src/contracts/StampMinter3.json', import.meta.url)));
const template = readFileSync(new URL('../contracts/RewardVault2.template.cash', import.meta.url), 'utf8');
if (!template.includes('MINTER_TEMPLATE;')) throw new Error('MINTER_TEMPLATE placeholder missing');
writeFileSync(new URL('../contracts/RewardVault2.cash', import.meta.url), template.replace('MINTER_TEMPLATE;', `0x${minter.debug.bytecode};`));
console.log(`RewardVault2.cash: embedded StampMinter3 (${minter.debug.bytecode.length / 2} bytes)`);
