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

export function sanitizeWalletName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
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
  try {
    await runCliJson(['loadwallet', wallet]);
    return false;
  } catch (error: any) {
    const message = (error?.message ?? '').toLowerCase();
    if (
      !message.includes('wallet does not exist') &&
      !message.includes('database does not have wallet') &&
      !message.includes('not found')
    ) {
      if (
        message.includes('duplicate -wallet filename specified') ||
        message.includes('already loaded')
      ) {
        return false;
      }
      throw error;
    }
  }

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
    console.info('[mintService] wallet created', { wallet });
  }
  await runCliJson(['loadwallet', wallet]);
  return true;
}

async function getDescriptorInfo(descriptor: string): Promise<DescriptorInfo> {
  const info = await runCliJson<DescriptorInfo>(['getdescriptorinfo', descriptor]);
  return info;
}

async function importDescriptor(
  wallet: string,
  descriptorWithChecksum: string,
  label = 'vault',
  timestamp: number | 'now' = 0
): Promise<DescriptorImportResult> {
  const payload = [
    {
      desc: descriptorWithChecksum,
      timestamp,
      active: false,
      label
    }
  ];
  const result = await runCliJson<ImportDescriptorResultItem[]>(
    ['importdescriptors', JSON.stringify(payload)],
    { wallet }
  );
  return interpretImportResult(result);
}

async function importOrdinalsDescriptor(
  wallet: string,
  ordinalsXOnly: string,
  label = 'ordinals',
  timestamp: number | 'now' = 0
): Promise<DescriptorImportResult> {
  const descriptor = `tr(${ordinalsXOnly})`;
  const info = await getDescriptorInfo(descriptor);
  const payload = [
    {
      desc: info.descriptor,
      timestamp,
      active: false,
      label
    }
  ];
  const result = await runCliJson<ImportDescriptorResultItem[]>(
    ['importdescriptors', JSON.stringify(payload)],
    { wallet }
  );
  return interpretImportResult(result);
}

async function rescanWallet(wallet: string, startHeight = 0): Promise<void> {
  try {
    await runCliRaw(['rescanblockchain', startHeight.toString()], { wallet });
    console.info('[mintService] rescan started', { wallet, startHeight });
  } catch (error: any) {
    const message = (error?.message ?? '').toLowerCase();
    if (message.includes('wallet is currently rescanning')) {
      console.warn('[mintService] wallet already rescanning', { wallet });
      return;
    }
    throw error;
  }
}

interface ImportDescriptorResultItem {
  success: boolean;
  warnings?: string[];
  error?: { code: number; message: string };
}

type DescriptorImportResult = 'imported' | 'duplicate';

function interpretImportResult(result: ImportDescriptorResultItem[]): DescriptorImportResult {
  const item = result[0];
  if (item?.success) {
    return 'imported';
  }
  const warningText = (item?.warnings ?? []).join(' ').toLowerCase();
  const errorText = (item?.error?.message ?? '').toLowerCase();
  if (
    warningText.includes('duplicate') ||
    warningText.includes('exists') ||
    errorText.includes('duplicate') ||
    errorText.includes('exists')
  ) {
    return 'duplicate';
  }
  throw new Error(item?.error?.message || 'descriptor_import_failed');
}

async function importPaymentDescriptor(
  wallet: string,
  paymentCompressed33: string,
  timestamp: number | 'now' = 0
): Promise<DescriptorImportResult> {
  // Watch-only import of user's payment address via wpkh(<33-byte pubkey>)
  const descriptor = `wpkh(${paymentCompressed33})`;
  const info = await getDescriptorInfo(descriptor);
  const payload = [
    {
      desc: info.descriptor,
      timestamp,
      active: false,
      label: 'user-payment'
    }
  ];
  const result = await runCliJson<ImportDescriptorResultItem[]>(
    ['importdescriptors', JSON.stringify(payload)],
    { wallet }
  );
  return interpretImportResult(result);
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

export async function buildMintPsbt(body: MintRequestBody): Promise<MintPsbtResult> {
  const wallet = body.payment.address; // funding wallet (watch-only of user's payment key)
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
  const descriptor = buildDescriptor(protocolPublicKey, body.payment.publicKey);
  const descriptorInfo = await getDescriptorInfo(descriptor);
  const descriptorWithChecksum = descriptorInfo.descriptor; // already contains #checksum

  const vaultAddress = await deriveVaultAddress(descriptorWithChecksum);
  console.info('[mintService] descriptor ready', { wallet, vaultAddress, vaultId });

  const resolvedAmounts = resolveAmounts(body.amounts);
  const overrideInputs = body.inputsOverride;
  let overrideOutputs = body.outputsOverrideJson;
  if (overrideOutputs) {
    const parsedOutputs = JSON.parse(overrideOutputs);
    if (typeof parsedOutputs === 'object' && parsedOutputs !== null) {
      parsedOutputs.data = config.mintRunestoneData;
      overrideOutputs = JSON.stringify(parsedOutputs);
    }
  }

  console.info('[mintService] override payload', {
    wallet,
    overrideInputs: overrideInputs?.length ?? 0,
    hasOutputs: Boolean(overrideOutputs)
  });
  if (!overrideInputs?.length || !overrideOutputs) {
    if (!config.allowLegacyMint) {
      throw new Error('inputs_override_required');
    }
    console.info('[mintService] override inputs missing, falling back to legacy PSBT builder', {
      wallet,
      vaultId
    });
    return buildLegacyMintPsbt(body, descriptorWithChecksum, vaultAddress, resolvedAmounts);
  }

  console.info('[mintService] override inputs/outputs provided', {
    wallet,
    overrides: overrideInputs.length
  });

  const rawTx = await runCliRaw([
    'createrawtransaction',
    JSON.stringify(
      overrideInputs.map(({ txid, vout }) => ({
        txid,
        vout
      }))
    ),
    overrideOutputs
  ]);
  console.info('[mintService] createrawtransaction (override)', {
    wallet,
    rawTxLength: rawTx.length
  });

  const patchedRawTx = patchRunestoneData(rawTx);
  const convertedPsbt = await runCliRaw(['converttopsbt', patchedRawTx]);
  const updatedPsbt = await runCliRaw(['utxoupdatepsbt', convertedPsbt]);
  console.info('[mintService] utxoupdatepsbt (override)', {
    wallet,
    psbtLength: updatedPsbt.length
  });

  return {
    wallet,
    vaultAddress,
    vaultId,
    protocolPublicKey,
    protocolChainCode,
    descriptor: descriptorWithChecksum,
    originalPsbt: convertedPsbt,
    patchedPsbt: updatedPsbt,
    rawTransactionHex: patchedRawTx,
    inputs: overrideInputs.map(({ txid, vout }) => ({ txid, vout })),
    changeOutput: undefined,
    collateralSats: resolvedAmounts.vaultSats,
    rune: body.rune,
    feeRate: body.feeRate,
    ordinalsAddress: body.ordinals.address,
    paymentAddress: body.payment.address
  };
}

async function buildLegacyMintPsbt(
  body: MintRequestBody,
  descriptorWithChecksum: string,
  vaultAddress: string,
  resolvedAmounts: MintOutputAmounts
): Promise<MintPsbtResult> {
  const wallet = body.payment.address;
  await ensureWallet(wallet);

  const paymentImport = await importPaymentDescriptor(wallet, body.payment.publicKey);
  if (paymentImport === 'imported') {
    console.info('[mintService] payment descriptor imported, continuing without rescan wait', {
      wallet
    });
  }

  const ordinalsXOnly = xOnly(body.ordinals.publicKey);
  await importOrdinalsDescriptor(wallet, ordinalsXOnly);

  const outputs = buildOutputsObject(
    body.ordinals.address,
    config.feeRecipientAddress,
    vaultAddress,
    body.payment.address,
    resolvedAmounts
  );

  const createOptions = {
    includeWatching: true,
    add_inputs: true,
    changeAddress: body.payment.address,
    fee_rate: body.feeRate,
    subtractFeeFromOutputs: [],
    changeType: 'witness_v0_keyhash'
  };

  const funded = await runCliJson<WalletCreateFundedPsbtResult>(
    [
      'walletcreatefundedpsbt',
      '[]',
      JSON.stringify(outputs),
      '0',
      JSON.stringify(createOptions)
    ],
    { wallet }
  );

  const updatedPsbt = await runCliRaw(['utxoupdatepsbt', funded.psbt]);
  const decoded = await runCliJson<DecodedPsbt>(['decodepsbt', updatedPsbt]);

  const changeOutput = findOutputByAddress(decoded.tx.vout, body.payment.address);

  return {
    wallet,
    vaultAddress,
    vaultId: body.vaultId,
    protocolPublicKey: body.protocolPublicKey,
    protocolChainCode: body.protocolChainCode,
    descriptor: descriptorWithChecksum,
    originalPsbt: funded.psbt,
    patchedPsbt: updatedPsbt,
    rawTransactionHex: '',
    inputs: decoded.tx.vin.map((vin) => ({ txid: vin.txid, vout: vin.vout })),
    changeOutput: changeOutput
      ? {
          address: body.payment.address,
          amountBtc: changeOutput.value.toFixed(8)
        }
      : undefined,
    collateralSats: resolvedAmounts.vaultSats,
    rune: body.rune,
    feeRate: body.feeRate,
    ordinalsAddress: body.ordinals.address,
    paymentAddress: body.payment.address
  };
}

export async function warmUserWallets(
  paymentAddress: string,
  paymentCompressed33: string,
  ordinalsPubKey: string,
  ordinalsAddress: string
): Promise<void> {
  const wallet = paymentAddress;
  await ensureWallet(wallet);
  const paymentImport = await importPaymentDescriptor(wallet, paymentCompressed33, 'now');
  if (paymentImport === 'imported') {
    console.info('[siwb] payment descriptor imported during warmup', { wallet });
  }
  const ordinalsXOnly = xOnly(ordinalsPubKey);
  await importOrdinalsDescriptor(wallet, ordinalsXOnly, 'ordinals', 'now');

  const ordWallet = `ord-${sanitizeWalletName(ordinalsAddress)}`;
  const ordCreated = await ensureWallet(ordWallet);
  const ordImport = await importOrdinalsDescriptor(ordWallet, ordinalsXOnly, 'ordinals', 0);
  if (ordCreated || ordImport === 'imported') {
    await rescanWallet(ordWallet, 0);
  }

  const userVaults = await vaultStore.listVaultsByPayment(paymentAddress);
  for (const vault of userVaults) {
    const vaultWallet = `vault-${sanitizeWalletName(vault.vaultId)}`;
    const created = await ensureWallet(vaultWallet);
    const imported = await importDescriptor(vaultWallet, vault.descriptor, 'vault', 0);
    if (created || imported === 'imported') {
      await rescanWallet(vaultWallet, 0);
    }
  }
}
