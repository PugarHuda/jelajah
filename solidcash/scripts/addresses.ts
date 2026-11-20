// Print the signer addresses for the selected network (fund them before running lifecycle.ts).
import { ethers, network } from '@solidcash/solidhat/hardhat3';

const signers = await ethers.getSigners(2);
for (const [i, s] of signers.entries()) console.log(network.name, i === 0 ? 'stall   ' : 'customer', s.address);
