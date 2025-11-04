import { config, satsToBtcString } from '../config.js';
import { MintOutputAmounts, MintPsbtResult, MintRequestBody } from '../types.js';
import { runCliJson, runCliRaw } from '../utils/bitcoinCli.js';

interface DescriptorInfo {
  descriptor: string;
  checksum: string;
}

interface WalletCreateFundedPsbtResult {
  psbt: string;
  fee: number;
  changepositions: number[];
}

interface DecodedPsbtVin {
  txid: string;
  vout: number;
}

interface DecodedPsbtVout {
  value: number;
  scriptPubKey: {
    address?: string;
    addresses?: string[];
  };
}

interface DecodedPsbt {
  tx: {
    vin: DecodedPsbtVin[];
    vout: DecodedPsbtVout[];
  };
}

function buildDescriptor(userPublicKey: string): string {
  return `wsh(or_i(multi(2,${config.guardianPublicKey},${userPublicKey}),multi(2,${config.vaultKeys[0]},${config.vaultKeys[1]})))`;
}

async function ensureWallet(wallet: string): Promise<void> {
  try {
    await runCliJson(['createwallet', wallet, 'true', 'true', '', 'false', 'true', 'false']);
  } catch (error: any) {
    const message = (error?.message ?? '').toLowerCase();
    if (!message.includes('database already exists')) {
      throw error;
    }
  }

  try {
    await runCliJson(['loadwallet', wallet]);
  } catch (error: any) {
    const message = (error?.message ?? '').toLowerCase();
    if (
      !message.includes('duplicate -wallet filename specified') &&
      !message.includes('already loaded')
    ) {
      throw error;
    }
  }
}

async function getDescriptorInfo(descriptor: string): Promise<DescriptorInfo> {
  const info = await runCliJson<DescriptorInfo>(['getdescriptorinfo', descriptor]);
  return info;
}

async function importDescriptor(
  wallet: string,
  descriptorWithChecksum: string
): Promise<void> {
  const payload = [
    {
      desc: descriptorWithChecksum,
      timestamp: "now",
      active: false,
      label: 'vault'
    }
  ];
  await runCliJson(['importdescriptors', JSON.stringify(payload)], { wallet });
}

async function deriveVaultAddress(descriptorWithChecksum: string): Promise<string> {
  const addresses = await runCliJson<string[]>([
    'deriveaddresses',
    descriptorWithChecksum
  ]);
  if (!addresses.length) {
    throw new Error('Failed to derive vault address from descriptor');
  }
  return addresses[0];
}

function resolveAmounts(amounts?: Partial<MintOutputAmounts>): MintOutputAmounts {
  return {
    ordinalsSats: amounts?.ordinalsSats ?? config.defaults.ordinalsSats,
    feeRecipientSats: amounts?.feeRecipientSats ?? config.defaults.feeRecipientSats,
    vaultSats: amounts?.vaultSats ?? config.defaults.vaultSats
  };
}

function findOutputByAddress(
  outputs: DecodedPsbtVout[],
  targetAddress: string
): DecodedPsbtVout | undefined {
  return outputs.find((out) => {
    if (out.scriptPubKey.address && out.scriptPubKey.address === targetAddress) {
      return true;
    }
    const addresses = out.scriptPubKey.addresses ?? [];
    return addresses.includes(targetAddress);
  });
}

function buildOutputsObject(
  ordinalsAddress: string,
  feeRecipientAddress: string,
  vaultAddress: string,
  paymentAddress: string,
  amounts: MintOutputAmounts,
  changeOutput?: DecodedPsbtVout
): Record<string, string | number> {
  const outputs: Record<string, string | number> = {
    data: config.mintRunestoneData,
    [ordinalsAddress]: Number(satsToBtcString(amounts.ordinalsSats)),
    [feeRecipientAddress]: Number(satsToBtcString(amounts.feeRecipientSats)),
    [vaultAddress]: Number(satsToBtcString(amounts.vaultSats))
  };

  if (changeOutput) {
    outputs[paymentAddress] = Number(changeOutput.value.toFixed(8));
  }

  return outputs;
}

function patchRunestoneData(rawHex: string): string {
  const target = `096a07${config.mintRunestoneData}`;
  const replacement = `0a6a5d07${config.mintRunestoneData}`;
  const lowerHex = rawHex.toLowerCase();
  const index = lowerHex.indexOf(target);
  if (index === -1) {
    throw new Error('Unable to locate rune data payload in raw transaction');
  }
  return (
    lowerHex.slice(0, index) +
    replacement +
    lowerHex.slice(index + target.length)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWalletRescan(wallet: string): Promise<void> {
  const timeoutMs = 5 * 60 * 1000; // 5 minutes safeguard
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const info = await runCliJson<{ scanning: boolean | { progress: number; duration: number } }>(
      ['getwalletinfo'],
      { wallet }
    );
    const scanning = info.scanning;
    if (scanning === false || scanning === undefined) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('wallet rescan still in progress after waiting 5 minutes');
    }
    await sleep(5000);
  }
}

export async function buildMintPsbt(body: MintRequestBody): Promise<MintPsbtResult> {
  const wallet = body.payment.address;
  console.info('[mintService] start', {
    wallet,
    rune: body.rune,
    feeRate: body.feeRate,
    ordinals: body.ordinals.address,
    payment: body.payment.address
  });
  await ensureWallet(wallet);

  const descriptor = buildDescriptor(body.payment.publicKey);
  const descriptorInfo = await getDescriptorInfo(descriptor);
  const descriptorWithChecksum = descriptorInfo.descriptor; // already contains #checksum

  await importDescriptor(wallet, descriptorWithChecksum);
  const vaultAddress = await deriveVaultAddress(descriptorWithChecksum);
  console.info('[mintService] descriptor ready', { wallet, vaultAddress });

  const resolvedAmounts = resolveAmounts(body.amounts);
  const feeRecipientAddr = config.feeRecipientAddress;

  async function createPsbt(): Promise<WalletCreateFundedPsbtResult> {
    console.info('[mintService] walletcreatefundedpsbt', {
      wallet,
      ordinals: body.ordinals.address,
      feeRecipient: feeRecipientAddr,
      vaultAddress,
      feeRate: body.feeRate
    });
    const out = await runCliRaw(
      [
        'walletcreatefundedpsbt',
        '[]',
        JSON.stringify({
          data: config.mintRunestoneData,
          [body.ordinals.address]: Number(satsToBtcString(resolvedAmounts.ordinalsSats)),
          [feeRecipientAddr]: Number(satsToBtcString(resolvedAmounts.feeRecipientSats)),
          [vaultAddress]: Number(satsToBtcString(resolvedAmounts.vaultSats))
        }),
        '0',
        JSON.stringify({
          changeAddress: body.payment.address,
          changePosition: 4,
          add_inputs: true,
          includeWatching: true,
          fee_rate: body.feeRate
        })
      ],
      { wallet }
    );
    try {
      return JSON.parse(out) as WalletCreateFundedPsbtResult;
    } catch {
      // Some versions return the base64 psbt string only
      return { psbt: out, fee: 0, changepositions: [] } as WalletCreateFundedPsbtResult;
    }
  }

  let psbtResult: WalletCreateFundedPsbtResult;
  try {
    psbtResult = await createPsbt();
  } catch (e: any) {
    const msg = String(e?.message ?? '').toLowerCase();
    if (msg.includes('wallet is currently rescanning')) {
      console.warn('[mintService] wallet rescanning detected, waiting', { wallet });
      await waitForWalletRescan(wallet);
      psbtResult = await createPsbt();
    } else {
      throw e;
    }
  }
  console.info('[mintService] walletcreatefundedpsbt success', {
    wallet,
    fee: psbtResult.fee,
    changePositions: psbtResult.changepositions
  });

  const decoded = await runCliJson<DecodedPsbt>(['decodepsbt', psbtResult.psbt]);
  const inputs = decoded.tx.vin.map((input) => ({ txid: input.txid, vout: input.vout }));
  const changeOutput = findOutputByAddress(decoded.tx.vout, body.payment.address);
  console.info('[mintService] decodepsbt', {
    wallet,
    inputs: inputs.length,
    hasChange: Boolean(changeOutput)
  });

  const rawOutputs = buildOutputsObject(
    body.ordinals.address,
    feeRecipientAddr,
    vaultAddress,
    body.payment.address,
    resolvedAmounts,
    changeOutput
  );

  const rawTxInputs = inputs.map(({ txid, vout }) => ({ txid, vout }));
  const rawTx = await runCliRaw([
    'createrawtransaction',
    JSON.stringify(rawTxInputs),
    JSON.stringify(rawOutputs)
  ]);
  console.info('[mintService] createrawtransaction', { wallet, rawTxLength: rawTx.length });

  const patchedRawTx = patchRunestoneData(rawTx);
  const patchedPsbt = await runCliRaw(['converttopsbt', patchedRawTx]);

  const updatedPsbt = await runCliRaw(['utxoupdatepsbt', patchedPsbt]);
  console.info('[mintService] utxoupdatepsbt', { wallet, psbtLength: updatedPsbt.length });

  return {
    wallet,
    vaultAddress,
    descriptor: descriptorWithChecksum,
    originalPsbt: psbtResult.psbt,
    patchedPsbt: updatedPsbt,
    rawTransactionHex: patchedRawTx,
    inputs,
    changeOutput: changeOutput
      ? { address: body.payment.address, amountBtc: changeOutput.value.toFixed(8) }
      : undefined
  };
}
