import { ethers, network } from '@solidcash/solidhat/hardhat3';

const [deployer] = await ethers.getSigners(1);
console.log(`Deploying on ${network.name} from ${deployer.address}`);

const Counter = await ethers.getContractFactory('Counter', deployer);
const counter = await Counter.deploy();
await counter.waitForDeployment();
const transaction = counter.deploymentTransaction();

console.log(JSON.stringify({
  network: network.name,
  address: await counter.getAddress(),
  transaction: transaction.txid,
}, null, 2));
