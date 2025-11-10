import { config, satsToBtcString } from '../config.js';
import { MintOutputAmounts, MintPsbtResult, MintRequestBody } from '../types.js';
import { runCliJson, runCliRaw } from '../utils/bitcoinCli.js';
import { vaultStore } from './vaultStore.js';

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

function xOnly(hex: string): string {
  const h = hex.toLowerCase();
  if (h.length === 66 && (h.startsWith('02') || h.startsWith('03'))) {
    return h.slice(2);
  }
  if (h.length === 64) return h;
  throw new Error(`invalid pubkey length for x-only conversion: len=${hex.length}`);
}

function buildDescriptor(protocolXOnly: string, userCompressed33: string): string {
  const internal = xOnly(config.guardianPublicKey);
  const userX = xOnly(userCompressed33);
  // Redemption leaf: protocol key (x-only) + user
  const leafAX = `multi_a(2,${protocolXOnly.toLowerCase()},${userX})`;

  const vkA = xOnly(config.vaultKeys[0]);
  const vkB = xOnly(config.vaultKeys[1]);
  const leafBX = `multi_a(2,${vkA},${vkB})`;

  // TapTree with guardian internal key and two script leaves
  return `tr(${internal},{${leafAX},${leafBX}})`;
}

async function ensureWallet(wallet: string): Promise<boolean> {
  let created = false;
  try {
    const result = await runCliJson<{ name: string }>([
      'createwallet',
      wallet,
      'true',
      'true',
      '',
      'false',
      'true',
      'false'
    ]);
    if (result?.name) {
      created = true;
      console.info('[mintService] wallet created', { wallet });
    }
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
  return created;
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

interface ImportDescriptorResultItem {
  success: boolean;
  warnings?: string[];
  error?: { code: number; message: string };
}

type PaymentDescriptorImport = 'imported' | 'duplicate';

async function importPaymentDescriptor(
  wallet: string,
  paymentCompressed33: string
): Promise<PaymentDescriptorImport> {
  // Watch-only import of user's payment address via wpkh(<33-byte pubkey>)
  const descriptor = `wpkh(${paymentCompressed33})`;
  const info = await getDescriptorInfo(descriptor);
  const payload = [
    {
      desc: info.descriptor,
      timestamp: 0, // rescan entire chain so existing UTXOs become visible
      active: false,
      label: 'user-payment'
    }
  ];
  const result = await runCliJson<ImportDescriptorResultItem[]>(
    ['importdescriptors', JSON.stringify(payload)],
    { wallet }
  );
  const item = result[0];
  if (item?.success) {
    return 'imported';
  }
  const warningText = (item?.warnings ?? []).join(' ').toLowerCase();
  const errorText = (item?.error?.message ?? '').toLowerCase();
  if (warningText.includes('duplicate') || warningText.includes('exists') ||
      errorText.includes('duplicate') || errorText.includes('exists')) {
    return 'duplicate';
  }
  throw new Error(item?.error?.message || 'failed to import payment descriptor');
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
  const data = config.mintRunestoneData;
  const lowerHex = rawHex.toLowerCase();

  // New format (you specified): 08 6a 06 <data>  ->  09 6a 5d 06 <data>
  const targetNew = `086a06${data}`;
  const replacementNew = `096a5d06${data}`;
  let idx = lowerHex.indexOf(targetNew);
  if (idx !== -1) {
    return lowerHex.slice(0, idx) + replacementNew + lowerHex.slice(idx + targetNew.length);
  }

  // Legacy format (previous): 09 6a 07 <data>  ->  0a 6a 5d 07 <data>
  const targetOld = `096a07${data}`;
  const replacementOld = `0a6a5d07${data}`;
  idx = lowerHex.indexOf(targetOld);
  if (idx !== -1) {
    return lowerHex.slice(0, idx) + replacementOld + lowerHex.slice(idx + targetOld.length);
  }

  throw new Error('Unable to locate rune data payload in raw transaction (no matching pattern)');
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
      console.info('[mintService] wallet rescan complete', { wallet });
      return;
    }
    if (scanning && typeof scanning === 'object') {
      console.info('[mintService] wallet rescan in progress', {
        wallet,
        progress: scanning.progress?.toFixed?.(4) ?? scanning.progress,
        duration: scanning.duration
      });
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('wallet rescan still in progress after waiting 5 minutes');
    }
    await sleep(5000);
  }
}

export async function buildMintPsbt(body: MintRequestBody): Promise<MintPsbtResult> {
  const wallet = body.payment.address; // funding wallet (watch-only of user's payment key)
  const vaultWallet = `vault-${body.vaultId}`; // separate watch-only wallet that tracks vault descriptors
  const vaultId = body.vaultId;
  const protocolPublicKey = body.protocolPublicKey.toLowerCase();
  const protocolChainCode = body.protocolChainCode.toLowerCase();
  console.info('[mintService] start', {
    wallet,
    rune: body.rune,
    feeRate: body.feeRate,
    ordinals: body.ordinals.address,
    payment: body.payment.address,
    vaultId,
    protocolPublicKey
  });
  const walletCreated = await ensureWallet(wallet);
  await ensureWallet(vaultWallet);

  // Ensure the funding wallet watches the user's payment address
  try {
    const importStatus = await importPaymentDescriptor(wallet, body.payment.publicKey);
    if (importStatus === 'imported') {
      console.info('[mintService] payment descriptor imported; waiting for rescan', { wallet, walletCreated });
      await waitForWalletRescan(wallet);
    } else if (walletCreated) {
      // Wallet was just created but descriptor already existed (unlikely). Force rescan once.
      console.info('[mintService] wallet newly created but descriptor duplicate; forcing rescan', { wallet });
      await runCliJson(['rescanblockchain'], { wallet });
      await waitForWalletRescan(wallet);
    }
  } catch (e: any) {
    console.warn('[mintService] importPaymentDescriptor warning (continuing)', { message: e?.message });
  }

  const descriptor = buildDescriptor(protocolPublicKey, body.payment.publicKey);
  const descriptorInfo = await getDescriptorInfo(descriptor);
  const descriptorWithChecksum = descriptorInfo.descriptor; // already contains #checksum

  // Import vault descriptor into dedicated vault watch-only wallet, not the funding wallet
  try {
    await importDescriptor(vaultWallet, descriptorWithChecksum);
  } catch (e: any) {
    console.warn('[mintService] import vault descriptor warning (continuing)', { message: e?.message, wallet: vaultWallet });
  }
  const vaultAddress = await deriveVaultAddress(descriptorWithChecksum);
  console.info('[mintService] descriptor ready', { wallet, vaultWallet, vaultAddress, vaultId });

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
    vaultId,
    protocolPublicKey,
    protocolChainCode,
    descriptor: descriptorWithChecksum,
    originalPsbt: psbtResult.psbt,
    patchedPsbt: updatedPsbt,
    rawTransactionHex: patchedRawTx,
    inputs,
    changeOutput: changeOutput
      ? { address: body.payment.address, amountBtc: changeOutput.value.toFixed(8) }
      : undefined,
    collateralSats: resolvedAmounts.vaultSats,
    rune: body.rune,
    feeRate: body.feeRate,
    ordinalsAddress: body.ordinals.address,
    paymentAddress: body.payment.address
  };
}
