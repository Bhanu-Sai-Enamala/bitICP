import { Transaction, SigHash } from '@scure/btc-signer/transaction';
import { tapLeafHash } from '@scure/btc-signer/payment';
import { concatBytes, tagSchnorr } from '@scure/btc-signer/utils';
import { config, SATS_PER_BTC, satsToBtcString } from '../config.js';
import {
  AuctionFinalizeRequest,
  AuctionPrepareRequest,
  AuctionPrepareResponse
} from '../types.js';
import { runCliJson, runCliRaw } from '../utils/bitcoinCli.js';
import { vaultStore, type VaultRecord, type AuctionState } from './vaultStore.js';
import { sanitizeWalletName } from './mintService.js';

interface ListUnspentEntry {
  txid: string;
  vout: number;
  address: string;
  amount: number;
  spendable: boolean;
  solvable: boolean;
  safe: boolean;
}

interface RawTxInfo {
  txid: string;
  vout: Array<{
    value: number;
    n: number;
    scriptPubKey: {
      hex?: string;
      address?: string;
      addresses?: string[];
    };
  }>;
}

interface WalletProcessResult {
  psbt: string;
}

interface AuctionSignaturePrompt {
  status: 'SIGNATURE_REQUIRED';
  vaultId: string;
  tapleafHash: string;
  controlBlock: string;
  sighash: string;
  merkleRoot: string;
  leafScript: string;
  missing: Array<'oracle' | 'liquidation'>;
}

interface ParsedAuctionPsbt {
  tx: Transaction;
  vaultInputIndex: number;
  controlBlock: ControlBlock;
  controlBlockBytes: Uint8Array;
  leafHash: Uint8Array;
  leafScript: Uint8Array;
  leafVersion: number;
  merkleRoot: Uint8Array;
  sighash: Uint8Array;
  hashType: number;
  psbtBase64: string;
}

const warmedWallets = new Set<string>();
type PsbtInput = ReturnType<Transaction['getInput']>;
type ControlBlock = {
  version: number;
  internalKey: Uint8Array;
  merklePath: Uint8Array[];
};
type TapLeafEntry = [ControlBlock, Uint8Array];

export async function prepareAuctionClaim(
  body: AuctionPrepareRequest
): Promise<AuctionPrepareResponse> {
  const vault = await vaultStore.getVault(body.vaultId);
  if (!vault) {
    throw new Error('vault_not_found');
  }
  if (!vault.txid) {
    throw new Error('vault_txid_missing');
  }
  const burnMetadata = body.burnMetadata.toLowerCase();
  const ordWallet = `ord-${sanitizeWalletName(body.ordinals.address)}`;
  const paymentWallet = sanitizeWalletName(body.payment.address);
  const vaultWallet = `vault-${sanitizeWalletName(body.vaultId)}`;

  await ensureWallet(ordWallet);
  await ensureWallet(paymentWallet);
  await ensureWallet(vaultWallet);
  await importPaymentDescriptor(paymentWallet, body.payment.publicKey, 'now');
  await importOrdinalsDescriptor(ordWallet, xOnly(body.ordinals.publicKey), 'ordinals', 'now');
  await importVaultDescriptor(vaultWallet, vault.descriptor);

  const runeUtxo = await selectRuneUtxo(ordWallet);
  const mintTx = await runCliJson<RawTxInfo>(['getrawtransaction', vault.txid, 'true']);
  const vaultOutput = mintTx.vout.find((entry) => matchesAddress(entry, vault.vaultAddress));
  if (!vaultOutput) {
    throw new Error('vault_output_not_found');
  }
  const inputs = [
    { txid: vault.txid, vout: vaultOutput.n },
    { txid: runeUtxo.txid, vout: runeUtxo.vout }
  ];

  const userPayoutSats = Math.min(body.claimPriceSats, vault.collateralSats);
  const treasurySats = Math.max(vault.collateralSats - userPayoutSats, 0);
  const userPayoutBtc = parseFloat(satsToBtcString(userPayoutSats));
  const feeRecipientBtc = parseFloat(satsToBtcString(treasurySats));
  const finalOutputs = [
    { data: burnMetadata },
    { [body.payment.address]: userPayoutBtc },
  ];
  if (treasurySats > 0) {
    finalOutputs.push({ [config.feeRecipientAddress]: feeRecipientBtc });
  }
  const raw = await runCliRaw([
    'createrawtransaction',
    JSON.stringify(inputs),
    JSON.stringify(finalOutputs),
  ]);
  const patched = patchBurnMetadata(raw, burnMetadata);
  const convertedPsbt = await runCliRaw(['converttopsbt', patched]);
  const ordProcessed = await runCliJson<WalletProcessResult>(['walletprocesspsbt', convertedPsbt], {
    wallet: ordWallet
  });
  const vaultProcessed = await runCliJson<WalletProcessResult>(['walletprocesspsbt', ordProcessed.psbt], {
    wallet: vaultWallet
  });

  return {
    vaultId: vault.vaultId,
    psbt: vaultProcessed.psbt,
    burnMetadata,
    claimPriceSats: body.claimPriceSats,
    ordinalsAddress: body.ordinals.address,
    paymentAddress: body.payment.address,
    mintTxId: vault.txid,
    runeTxId: runeUtxo.txid,
    inputs
  };
}

export async function finalizeAuctionClaim(
  body: AuctionFinalizeRequest
): Promise<
  | { status: 'FINALIZED'; txid: string; hex: string; psbt: string }
  | AuctionSignaturePrompt
> {
  const vault = await vaultStore.getVault(body.vaultId);
  if (!vault) {
    throw new Error('auction_not_found');
  }
  const currentState =
    vault.auctionState ??
    ({
      startedAt: Date.now(),
      lastUpdatedAt: Date.now(),
      claimPriceSats: 0,
      offerRatioBps: 0,
      treasuryDeadline: Date.now(),
      claimed: false
    } as AuctionState);

  const analysis = analyzeAuctionPsbt(body.psbt, vault);
  if (!analysis) {
    throw new Error('auction_psbt_invalid');
  }

  if (body.oracleSignature) {
    applyAuctionSignature(analysis, vault.oraclePublicKey, body.oracleSignature, 'oracle_signature');
  }
  if (body.liquidationSignature) {
    applyAuctionSignature(
      analysis,
      vault.liquidationPublicKey,
      body.liquidationSignature,
      'liquidation_signature'
    );
  }

  const oracleReady = hasTaprootSignature(analysis, vault.oraclePublicKey);
  const liquidationReady = hasTaprootSignature(analysis, vault.liquidationPublicKey);
  const missing: Array<'oracle' | 'liquidation'> = [];
  if (!oracleReady) missing.push('oracle');
  if (!liquidationReady) missing.push('liquidation');

  if (missing.length) {
    return {
      status: 'SIGNATURE_REQUIRED',
      vaultId: vault.vaultId,
      tapleafHash: bytesToHex(analysis.leafHash),
      controlBlock: bytesToHex(analysis.controlBlockBytes),
      sighash: bytesToHex(analysis.sighash),
      merkleRoot: bytesToHex(analysis.merkleRoot),
      leafScript: bytesToHex(analysis.leafScript),
      missing
    };
  }

  let patchedPsbt = sanitizePsbtString(
    Buffer.from(analysis.tx.toPSBT(analysis.tx.opts.PSBTVersion ?? 0)).toString('base64')
  );
  const originalPsbt = sanitizePsbtString(body.psbt);
  const combinedPayload = JSON.stringify([originalPsbt, patchedPsbt]);
  patchedPsbt = sanitizePsbtString(await runCliRaw(['combinepsbt', combinedPayload]));

  const finalized = await runCliJson<{ psbt?: string; hex: string; complete: boolean }>([
    'finalizepsbt',
    patchedPsbt
  ]);
  if (!finalized.complete || !finalized.hex) {
    throw new Error('auction_finalize_incomplete');
  }
  const hex = finalized.hex.trim();
  const txid = await runCliRaw(['sendrawtransaction', hex]);
  const newState = {
    ...currentState,
    claimed: true,
    claimTxId: txid,
    claimantAddress: body.claimantPaymentAddress,
    lastUpdatedAt: Date.now()
  };
  await vaultStore.updateVault(body.vaultId, { auctionState: newState });
  return { status: 'FINALIZED', txid, hex, psbt: patchedPsbt };
}

async function ensureWallet(name: string): Promise<void> {
  if (warmedWallets.has(name)) {
    return;
  }
  const loaded = await runCliJson<string[]>(['listwallets']);
  if (!loaded.includes(name)) {
    const directory = await runCliJson<{ wallets: { name: string }[] }>(['listwalletdir']);
    const exists = (directory.wallets ?? []).some((entry) => entry.name === name);
    if (!exists) {
      await runCliRaw([
        'createwallet',
        name,
        'true',
        'true',
        '',
        'false',
        'true',
        'false'
      ]);
    } else {
      await runCliRaw(['loadwallet', name]);
    }
  }
  warmedWallets.add(name);
}

async function importPaymentDescriptor(
  wallet: string,
  paymentCompressed33: string,
  timestamp: number | 'now' = 0
) {
  const descriptor = `wpkh(${paymentCompressed33})`;
  const info = await runCliJson<{ descriptor: string }>(['getdescriptorinfo', descriptor]);
  const payload = [
    {
      desc: info.descriptor,
      timestamp,
      active: false,
      label: 'user-payment'
    }
  ];
  try {
    await runCliJson(['importdescriptors', JSON.stringify(payload)], { wallet });
  } catch (error: any) {
    const message = (error?.message ?? '').toLowerCase();
    if (!message.includes('wallet is currently rescanning')) {
      throw error;
    }
  }
}

async function importOrdinalsDescriptor(
  wallet: string,
  ordinalsXOnly: string,
  label = 'ordinals',
  timestamp: number | 'now' = 0
) {
  const descriptor = `tr(${ordinalsXOnly})`;
  const info = await runCliJson<{ descriptor: string }>(['getdescriptorinfo', descriptor]);
  const payload = [
    {
      desc: info.descriptor,
      timestamp,
      active: false,
      label
    }
  ];
  try {
    await runCliJson(['importdescriptors', JSON.stringify(payload)], { wallet });
  } catch (error: any) {
    const message = (error?.message ?? '').toLowerCase();
    if (!message.includes('wallet is currently rescanning')) {
      throw error;
    }
  }
}

async function importVaultDescriptor(wallet: string, descriptor: string) {
  const info = await runCliJson<{ descriptor: string }>(['getdescriptorinfo', descriptor]);
  const payload = [
    {
      desc: info.descriptor,
      timestamp: 0,
      active: false,
      label: 'vault'
    }
  ];
  try {
    await runCliJson(['importdescriptors', JSON.stringify(payload)], { wallet });
  } catch (error: any) {
    const message = (error?.message ?? '').toLowerCase();
    if (!message.includes('wallet is currently rescanning')) {
      throw error;
    }
  }
}

async function selectRuneUtxo(wallet: string): Promise<ListUnspentEntry> {
  const utxos = await runCliJson<ListUnspentEntry[]>(['listunspent', '0', '9999999'], { wallet });
  for (const utxo of utxos) {
    if (utxo.vout !== 1 || !utxo.spendable) continue;
    if (await isRuneUtxo(utxo.txid)) {
      return utxo;
    }
  }
  throw new Error('insufficient_rune_balance');
}

async function isRuneUtxo(txid: string): Promise<boolean> {
  const tx = await runCliJson<RawTxInfo>(['getrawtransaction', txid, 'true']);
  const burnOutput = tx.vout.find((v) => v.n === 0 && v.scriptPubKey.hex?.startsWith('6a'));
  if (!burnOutput?.scriptPubKey.hex) {
    return false;
  }
  return burnOutput.scriptPubKey.hex.toLowerCase().includes(config.mintRunestoneData.toLowerCase());
}

function matchesAddress(entry: RawTxInfo['vout'][number], address: string): boolean {
  if (entry.scriptPubKey.address && entry.scriptPubKey.address === address) {
    return true;
  }
  const addresses = entry.scriptPubKey.addresses ?? [];
  return addresses.includes(address);
}

function sumOutputs(vout: RawTxInfo['vout'], address: string): number {
  const matches = vout.filter((entry) => matchesAddress(entry, address));
  const total = matches.reduce((sum, entry) => sum + entry.value, 0);
  return parseFloat(total.toFixed(8));
}

function patchBurnMetadata(rawHex: string, burnHex: string): string {
  const lower = rawHex.toLowerCase();
  const data = burnHex.toLowerCase();
  const dataIdx = lower.indexOf(data);
  if (dataIdx === -1) {
    throw new Error('Unable to locate burn metadata for auction patch');
  }
  if (dataIdx < 6) {
    throw new Error('Burn metadata located too close to beginning of script');
  }

  const pushLenHex = lower.slice(dataIdx - 2, dataIdx);
  const opReturnHex = lower.slice(dataIdx - 4, dataIdx - 2);
  const scriptLenHex = lower.slice(dataIdx - 6, dataIdx - 4);

  if (opReturnHex !== '6a') {
    throw new Error('Unexpected OP_RETURN opcode when patching auction metadata');
  }

  const scriptLen = parseInt(scriptLenHex, 16);
  if (!Number.isFinite(scriptLen)) {
    throw new Error('Unable to parse auction script length byte');
  }
  const newScriptLenHex = (scriptLen + 1).toString(16).padStart(2, '0');

  return (
    lower.slice(0, dataIdx - 6) +
    newScriptLenHex +
    opReturnHex +
    '5d' +
    pushLenHex +
    lower.slice(dataIdx)
  );
}

function xOnly(hex: string): string {
  const lower = hex.toLowerCase();
  if (lower.length === 66 && (lower.startsWith('02') || lower.startsWith('03'))) {
    return lower.slice(2);
  }
  if (lower.length === 64) return lower;
  throw new Error('invalid_pubkey_format');
}

function sanitizePsbtString(psbt: string): string {
  return psbt.replace(/\s+/g, '');
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.length % 2 === 0 ? hex : `0${hex}`;
  return Uint8Array.from(Buffer.from(normalized, 'hex'));
}

function normalizeSignatureHex(hex: string): string {
  return hex.length % 2 === 0 ? hex : `0${hex}`;
}

function normalizeTaprootSignature(
  sig: Uint8Array,
  label: string,
  hashType: number
): Uint8Array {
  if (hashType === SigHash.DEFAULT) {
    if (sig.length === 64) return Uint8Array.from(sig);
    if (sig.length === 65 && sig[64] === 0x00) {
      console.warn(`[auction] ${label}_default_trailer_trimmed`);
      return Uint8Array.from(sig.subarray(0, 64));
    }
    throw new Error(`${label}_unexpected_trailer_for_default`);
  }
  const expected = hashType & 0xff;
  if (sig.length === 65 && sig[64] === expected) {
    return Uint8Array.from(sig);
  }
  throw new Error(`${label}_invalid_sighash:${sig[64] ?? -1}`);
}

function equalBytes(a?: Uint8Array, b?: Uint8Array): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function hashTapBranch(a: Uint8Array, b: Uint8Array): Uint8Array {
  const compare = Buffer.compare(Buffer.from(a), Buffer.from(b));
  const [left, right] = compare <= 0 ? [a, b] : [b, a];
  return tagSchnorr('TapBranch', concatBytes(left, right));
}

function computeMerkleRoot(leafHash: Uint8Array, controlBlock: ControlBlock): Uint8Array {
  return controlBlock.merklePath.reduce((acc: Uint8Array, node: Uint8Array) => {
    if (node.length !== 32) {
      throw new Error('invalid_control_block_node');
    }
    return hashTapBranch(acc, node);
  }, leafHash);
}

function ensurePrevOut(input: PsbtInput): { script: Uint8Array; amount: bigint } {
  if (input.witnessUtxo) {
    return {
      script: input.witnessUtxo.script,
      amount: input.witnessUtxo.amount
    };
  }
  if (input.nonWitnessUtxo && typeof input.index === 'number') {
    const prev = input.nonWitnessUtxo.outputs[input.index];
    if (prev) {
      return prev;
    }
  }
  throw new Error('missing_prevout');
}

function serializeControlBlock(block: ControlBlock): Uint8Array {
  const size = 1 + block.internalKey.length + block.merklePath.length * 32;
  const buf = new Uint8Array(size);
  buf[0] = block.version;
  buf.set(block.internalKey, 1);
  block.merklePath.forEach((node: Uint8Array, idx: number) => {
    buf.set(node, 33 + idx * 32);
  });
  return buf;
}

function analyzeAuctionPsbt(
  psbtBase64: string,
  vault: VaultRecord
): ParsedAuctionPsbt | null {
  if (!psbtBase64) return null;
  let bytes: Uint8Array;
  try {
    const buf = Buffer.from(psbtBase64, 'base64');
    if (!buf.length) {
      throw new Error('empty_psbt');
    }
    bytes = new Uint8Array(buf);
  } catch {
    throw new Error('invalid_psbt_encoding');
  }
  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(bytes, {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      allowLegacyWitnessUtxo: true,
      disableScriptCheck: true
    });
  } catch (error: any) {
    throw new Error(`invalid_psbt: ${error?.message ?? 'failed to parse'}`);
  }

  let vaultInputIndex = -1;
  let vaultInput: PsbtInput | undefined;
  for (let i = 0; i < tx.inputsLength; i += 1) {
    const input = tx.getInput(i);
    if (input.tapLeafScript && input.tapLeafScript.length > 0) {
      vaultInputIndex = i;
      vaultInput = input;
      break;
    }
  }
  if (vaultInputIndex === -1 || !vaultInput) {
    throw new Error('vault_input_missing');
  }

  const oracleKey = vault.oraclePublicKey.toLowerCase();
  const liquidationKey = vault.liquidationPublicKey.toLowerCase();
  const tapLeafScripts: TapLeafEntry[] = vaultInput.tapLeafScript ?? [];
  const matchingLeaf = tapLeafScripts.find(([, scriptWithVer]) => {
    const scriptHex = bytesToHex(scriptWithVer.subarray(0, scriptWithVer.length - 1));
    return scriptHex.includes(oracleKey) && scriptHex.includes(liquidationKey);
  });
  const selectedLeaf = matchingLeaf ?? tapLeafScripts[0];
  if (!selectedLeaf) {
    throw new Error('auction_leaf_not_found');
  }

  const [controlBlock, scriptWithVer] = selectedLeaf;
  const leafVersion = scriptWithVer[scriptWithVer.length - 1];
  if (leafVersion !== 0xc0) {
    throw new Error('unsupported_leaf_version');
  }
  const controlBlockVersion = controlBlock.version;
  if ((controlBlockVersion & 0xfe) !== 0xc0) {
    throw new Error('bad_control_block_version');
  }
  const leafScript = scriptWithVer.subarray(0, scriptWithVer.length - 1);
  const leafHash = tapLeafHash(leafScript, leafVersion);
  const merkleRoot = computeMerkleRoot(leafHash, controlBlock);

  const prevOuts = Array.from({ length: tx.inputsLength }, (_, idx) => {
    const input = idx === vaultInputIndex ? vaultInput! : tx.getInput(idx);
    return ensurePrevOut(input);
  });
  const prevOutScripts = prevOuts.map((out) => out.script);
  const prevOutAmounts = prevOuts.map((out) => out.amount);
  const hashType = vaultInput.sighashType ?? SigHash.DEFAULT;
  const sighash = tx.preimageWitnessV1(
    vaultInputIndex,
    prevOutScripts,
    hashType,
    prevOutAmounts,
    undefined,
    leafScript,
    leafVersion
  );
  const controlBlockBytes = serializeControlBlock(controlBlock);
  return {
    tx,
    vaultInputIndex,
    controlBlock,
    controlBlockBytes,
    leafHash,
    leafScript,
    leafVersion,
    merkleRoot,
    sighash,
    hashType,
    psbtBase64
  };
}

function hasTaprootSignature(analysis: ParsedAuctionPsbt, targetHex: string): boolean {
  const input = analysis.tx.getInput(analysis.vaultInputIndex);
  const tapSigs = input.tapScriptSig ?? [];
  const target = targetHex.toLowerCase();
  return tapSigs.some(
    ([info]) =>
      info.leafHash &&
      equalBytes(info.leafHash, analysis.leafHash) &&
      bytesToHex(info.pubKey).toLowerCase() === target
  );
}

function applyAuctionSignature(
  analysis: ParsedAuctionPsbt,
  signerHex: string,
  signatureHex: string,
  label: string
): void {
  const normalizedHex = normalizeSignatureHex(signatureHex);
  const signature = hexToBytes(normalizedHex);
  const witness = normalizeTaprootSignature(signature, label, analysis.hashType);
  const pubKeyBytes = hexToBytes(signerHex);
  const input = analysis.tx.getInput(analysis.vaultInputIndex);
  const existingTapSigs = input.tapScriptSig ?? [];

  const filtered = existingTapSigs.filter(
    ([info]) =>
      !info.leafHash ||
      !equalBytes(info.leafHash, analysis.leafHash) ||
      bytesToHex(info.pubKey).toLowerCase() !== signerHex.toLowerCase()
  );

  const scriptWithVersion = new Uint8Array(analysis.leafScript.length + 1);
  scriptWithVersion.set(analysis.leafScript, 0);
  scriptWithVersion[scriptWithVersion.length - 1] = analysis.leafVersion;
  const existingLeafScripts = input.tapLeafScript ?? [];
  const hasLeaf = existingLeafScripts.some(
    ([_, script]) => bytesToHex(script) === bytesToHex(scriptWithVersion)
  );
  const tapLeafScript: TapLeafEntry[] = hasLeaf
    ? (existingLeafScripts as TapLeafEntry[])
    : [...existingLeafScripts, [analysis.controlBlock, scriptWithVersion] as TapLeafEntry];

  const newTapScriptSig = [
    ...filtered,
    [{ pubKey: pubKeyBytes, leafHash: analysis.leafHash }, witness] as [
      { pubKey: Uint8Array; leafHash: Uint8Array },
      Uint8Array
    ]
  ];

  analysis.tx.updateInput(
    analysis.vaultInputIndex,
    {
      tapLeafScript,
      tapScriptSig: newTapScriptSig
    },
    true
  );
}
