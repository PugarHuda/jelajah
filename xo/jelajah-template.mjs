// "Buy and stamp" from Jelajah as an XO template.
// The locking script assembles to the exact bytes of Jelajah's StampMinter covenant (CashScript 0.14,
// P2SH32), so this template spends the live rally's minters; no new contract was deployed for XO.
import { readFileSync } from 'node:fs';

// CashScript's ASM for the covenant body, with bare hex pushes turned into CashASM pushes.
const artifact = JSON.parse(readFileSync(new URL('../src/contracts/StampMinter.json', import.meta.url)));
const covenantBody = artifact.bytecode.split(' ').map((t) => (t.startsWith('OP_') ? t : `<0x${t}>`)).join(' ');

/** @type {import('@xo-cash/types').XOTemplate} */
export const jelajahStampTemplate = {
  $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',

  name: 'Jelajah stamp',
  description: 'Pay a stall in a Jelajah stamp rally and receive its stamp NFT in the same transaction.',
  icon: 'stamp',

  version: '1',
  supported: ['BCH_2025_05', 'BCH_2026_05'],

  resources: [
    { name: 'Jelajah', description: 'Stamp rallies on Bitcoin Cash (BCH BLAZE 2026).', url: 'https://github.com/PugarHuda/jelajah' },
  ],

  roles: {
    buyer: { name: 'Buyer', description: 'Pays the stall and receives its stamp.', icon: 'buyer' },
  },

  // A wallet can't discover a stall's minter coin by itself: the rally app supplies it (like faucet.cash's service).
  start: [],

  actions: {
    buyStamp: {
      name: 'Buy and stamp',
      description: 'Pay a stall $(<stallPrice>) satoshis and receive its stamp NFT.',
      icon: 'stamp',
      roles: {
        buyer: {
          requirements: {
            variables: ['merchantId', 'stallPrice', 'stallLockingScript', 'stampCategory', 'minterSatoshis', 'buyerLockingScript', 'stampCommitmentHex'],
          },
        },
      },
      requirements: {
        participants: [{ role: 'buyer', slots: { min: 1, max: 1 } }],
      },
      transaction: 'buyStampTransaction',
    },
  },

  transactions: {
    buyStampTransaction: {
      name: 'Stamped at a stall',
      description: 'Paid $(<stallPrice>) satoshis and received a Jelajah stamp.',
      icon: 'stamp',
      inputs: [{ input: 'minterInput', inputIndex: 0 }],
      outputs: [
        { output: 'minterOutput', outputIndex: 0 },
        { output: 'paymentOutput', outputIndex: 1 },
        { output: 'stampOutput', outputIndex: 2 },
      ],
    },
  },

  inputs: {
    minterInput: {
      name: 'Stall minter',
      description: "The stall's covenant coin, holding the rally's minting NFT.",
      icon: 'contract',
      valueSatoshis: '$(<minterSatoshis>)',
      token: { category: '$(<stampCategory>)', amount: '0', nft: { capability: 'minting', commitment: '' } },
      unlockingScript: 'minterUnlockingBytecode',
    },
  },

  outputs: {
    minterOutput: {
      name: 'Stall minter',
      description: 'The minter goes back to the covenant unchanged.',
      icon: 'contract',
      lockingScript: 'stampMinter',
      valueSatoshis: '$(<minterSatoshis>)',
      token: { category: '$(<stampCategory>)', amount: '0', nft: { capability: 'minting', commitment: '' } },
      selectable: false,
      balance: { satoshis: 0n, fungibleTokens: 0n, nonfungibleTokens: 0 },
      roles: { buyer: { relevant: false } },
    },

    paymentOutput: {
      name: 'Payment to the stall',
      description: '$(<stallPrice>) satoshis to the stall.',
      icon: 'send',
      lockingScript: '$(<stallLockingScript>)',
      valueSatoshis: '$(<stallPrice>)',
      token: null,
    },

    stampOutput: {
      name: 'Your stamp',
      description: 'The stall stamp NFT, bound to your key: stall id followed by your public key hash.',
      icon: 'stamp',
      lockingScript: '$(<buyerLockingScript>)',
      valueSatoshis: '$(<tokenDust>)',
      token: {
        category: '$(<stampCategory>)',
        amount: '0',
        // Engine 0.1.1-next decodes a commitment expression's result as UTF-8 text and then parses that text as hex,
        // so an expression computing raw bytes comes out garbled. The app passes the hex instead; the covenant
        // still checks on chain that it equals stall id ‖ buyer pkh (scripts.stampCommitment shows the rule).
        nft: { capability: 'none', commitment: '$(<stampCommitmentHex>)' },
      },
    },
  },

  lockingScripts: {
    stampMinter: {
      name: 'Jelajah stall minter',
      description: 'Lets a stamp out only when the stall is paid at least its price, in the same transaction.',
      icon: 'contract',
      lockingType: 'p2sh',
      lockingBytecode: 'minterRedeemBytecode',
      selectable: false,
      balance: { satoshis: 0n, fungibleTokens: 0n, nonfungibleTokens: 0 },
      roles: { buyer: { relevant: false } },
    },
  },

  scripts: {
    // StampMinter(merchantLock, minPrice, merchantId): CashScript pushes constructor arguments in reverse order.
    minterRedeemBytecode: `<merchantId> <stallPrice> <stallLockingScript> ${covenantBody}`,
    minterUnlockingBytecode: '<minterRedeemBytecode>',
    // commitment = stall id ‖ buyer pkh (bytes 3..23 of a P2PKH locking script)
    stampCommitment: '<merchantId> <buyerLockingScript> OP_3 OP_SPLIT OP_NIP <20> OP_SPLIT OP_DROP OP_CAT',
  },

  constants: {
    tokenDust: { name: 'Token dust', description: 'Satoshis carried by the stamp output.', type: 'integer', value: 1000 },
  },

  variables: {
    merchantId: { name: 'Stall id', description: 'One byte, 01 to 7f.', type: 'bytes' },
    stallPrice: { name: 'Stall price', description: 'Minimum payment the covenant accepts.', type: 'satoshis' },
    stallLockingScript: { name: 'Stall address', description: 'Where the stall gets paid.', type: 'locking_script' },
    stampCategory: { name: 'Rally category', description: "The rally's token category.", type: 'bytes' },
    minterSatoshis: { name: 'Minter satoshis', description: "Satoshis on the stall's minter coin.", type: 'integer' },
    buyerLockingScript: { name: 'Your address', description: 'Where your stamp goes. Must be P2PKH: the rally binds it to your key.', type: 'locking_script' },
    stampCommitmentHex: { name: 'Stamp commitment', description: 'Stall id followed by your public key hash, as hex.', type: 'string' },
  },
};
