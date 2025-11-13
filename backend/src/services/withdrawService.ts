import { Transaction, SigHash } from '@scure/btc-signer/transaction';
import { tapLeafHash } from '@scure/btc-signer/payment';
import { concatBytes, tagSchnorr } from '@scure/btc-signer/utils';
import type { TaprootControlBlock } from '@scure/btc-signer/psbt';
import { config, satsToBtcString } from '../config.js';
import { vaultStore, type VaultRecord } from './vaultStore.js';
import { runCliJson, runCliRaw } from '../utils/bitcoinCli.js';
import { sanitizeWalletName } from './mintService.js';

const DEFAULT_BURN_METADATA = '00dde905020a00';
const PAYMENT_WITHDRAW_SATS = 10_000; // 0.00010000 BTC
const PSBT_PARSE_OPTIONS = {
  allowUnknownInputs: true,
  allowUnknownOutputs: true,
  allowLegacyWitnessUtxo: true,
  disableScriptCheck: true
} as const;

interface RawTxInfo {
  txid: string;
  vout: Array<{
    value: number;
    n: number;
    scriptPubKey: {
      addresses?: string[];
      address?: string;
    };
  }>;
}

function matchesAddress(entry: RawTxInfo['vout'][number], address: string): boolean {
  if (entry.scriptPubKey.address && entry.scriptPubKey.address === address) {
    return true;
  }
  const list = entry.scriptPubKey.addresses ?? [];
  return list.includes(address);
}

function patchWithdrawData(rawHex: string, burnData: string): string {
  const lower = rawHex.toLowerCase();
  const data = burnData.toLowerCase();
  const dataIdx = lower.indexOf(data);
  if (dataIdx === -1) {
    throw new Error('Unable to locate burn metadata for withdraw patch');
  }
  if (dataIdx < 6) {
    throw new Error('Burn metadata located too close to beginning of script');
  }

  const pushLenHex = lower.slice(dataIdx - 2, dataIdx);
  const opReturnHex = lower.slice(dataIdx - 4, dataIdx - 2);
  const scriptLenHex = lower.slice(dataIdx - 6, dataIdx - 4);

  if (opReturnHex !== '6a') {
    throw new Error('Unexpected OP_RETURN opcode when patching withdraw metadata');
  }

  const scriptLen = parseInt(scriptLenHex, 16);
  if (!Number.isFinite(scriptLen)) {
    throw new Error('Unable to parse withdraw script length byte');
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

export interface WithdrawPrepareResult {
  psbt: string;
  burnMetadata: string;
  inputs: Array<{ txid: string; vout: number; value: number }>;
  vaultId: string;
  ordinalsAddress: string;
  paymentAddress: string;
  vaultAddress: string;
}

export interface WithdrawSignatureRequest {
  vaultId: string;
  tapleafHash: string;
  controlBlock: string;
  sighash: string;
  merkleRoot: string;
  leafScript: string;
}

export interface WithdrawFinalizeResult {
  vaultId: string;
  psbt: string;
  hex: string;
  txid: string | null;
}

type PsbtInput = ReturnType<Transaction['getInput']>;

interface ParsedPsbt {
  tx: Transaction;
  vaultInputIndex: number;
  controlBlock: ControlBlock;
  leafHash: Uint8Array;
  leafScript: Uint8Array;
  leafVersion: number;
  controlBlockBytes: Uint8Array;
  merkleRoot: Uint8Array;
  sighash: Uint8Array;
  hashType: number;
  psbtBase64: string;
}

function hexToBytes(hex: string): Uint8Array {
  let working = hex.trim();
  const commentIdx = working.indexOf('#');
  if (commentIdx >= 0) {
    working = working.slice(0, commentIdx);
  }
  working = working.replace(/^0x/i, '').replace(/\s+/g, '');
  if (working.length === 0) {
    return new Uint8Array();
  }
  if (working.length % 2 !== 0) {
    throw new Error(`invalid_hex_length:${working.length}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(working)) {
    throw new Error(`invalid_hex_chars:${working.slice(0, 20)}`);
  }
  const normalized = working.toLowerCase();
  return Uint8Array.from(normalized.match(/.{2}/g)!.map((byte) => parseInt(byte, 16)));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function normalizeSignatureHex(hex: string): string {
  let cleaned = hex.trim().toLowerCase();
  if (cleaned.length === 130 && cleaned.endsWith('00')) {
    cleaned = cleaned.slice(0, -2);
  }
  return cleaned;
}

function sanitizePsbtString(psbt: string): string {
  return psbt.replace(/\s+/g, '').trim();
}

function parseTransactionFromPsbt(psbtBase64: string): Transaction {
  const bytes = Buffer.from(psbtBase64, 'base64');
  if (!bytes.length) {
    throw new Error('empty_psbt');
  }
  return Transaction.fromPSBT(new Uint8Array(bytes), PSBT_PARSE_OPTIONS);
}

function buildWitnessStack(items: Uint8Array[]): Uint8Array[] {
  if (items.length === 0) {
    throw new Error('witness_empty');
  }
  return items.map((item) => Uint8Array.from(item));
}

function finalizeTaprootKeyInputs(tx: Transaction): void {
  for (let idx = 0; idx < tx.inputsLength; idx += 1) {
    const input = tx.getInput(idx);
    if (input.tapKeySig && input.tapKeySig.length) {
      tx.updateInput(
        idx,
        {
          finalScriptWitness: [Uint8Array.from(input.tapKeySig)],
          tapKeySig: undefined
        },
        true
      );
    }
  }
}

function applyFinalWitnessToPsbt(
  psbtBase64: string,
  inputIndex: number,
  witness: Uint8Array[]
): { psbt: string; hex?: string } {
  const tx = parseTransactionFromPsbt(psbtBase64);
  tx.updateInput(
    inputIndex,
    {
      finalScriptWitness: witness,
      tapLeafScript: [],
      tapScriptSig: [],
      tapBip32Derivation: []
    },
    true
  );

  let hex: string | undefined;
  finalizeTaprootKeyInputs(tx);

  try {
    hex = tx.hex;
  } catch (error) {
    if (error instanceof Error) {
      console.warn('[withdraw] local hex extraction failed', {
        reason: error.message
      });
    }
  }

  const updatedPsbt = Buffer.from(tx.toPSBT(tx.opts.PSBTVersion ?? 0)).toString('base64');
  return {
    psbt: sanitizePsbtString(updatedPsbt),
    hex
  };
}

function equalBytes(a?: Uint8Array, b?: Uint8Array): boolean {
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function serializeControlBlock(
  block: { version: number; internalKey: Uint8Array; merklePath: Uint8Array[] }
): Uint8Array {
  const size = 1 + block.internalKey.length + block.merklePath.length * 32;
  const buf = new Uint8Array(size);
  buf[0] = block.version;
  buf.set(block.internalKey, 1);
  block.merklePath.forEach((node, idx) => {
    buf.set(node, 33 + idx * 32);
  });
  return buf;
}

type ControlBlock = Parameters<typeof serializeControlBlock>[0];

const TAPROOT_SIGHASH_TRAILERS = new Set<number>([
  SigHash.ALL,
  SigHash.NONE,
  SigHash.SINGLE,
  SigHash.DEFAULT_ANYONECANPAY,
  SigHash.ALL_ANYONECANPAY,
  SigHash.NONE_ANYONECANPAY,
  SigHash.SINGLE_ANYONECANPAY
]);

function normalizeTaprootSignature(
  sig: Uint8Array,
  label: string,
  hashType: number
): Uint8Array {
  if (hashType === SigHash.DEFAULT) {
    if (sig.length === 64) {
      return Uint8Array.from(sig);
    }
    if (sig.length === 65 && sig[64] === 0x00) {
      console.warn(`[withdraw] ${label} default_trailer_trimmed`);
      return Uint8Array.from(sig.subarray(0, 64));
    }
    throw new Error(`${label}_unexpected_trailer_for_default`);
  }
  const expectedTrailer = hashType & 0xff;
  if (sig.length === 65 && sig[64] === expectedTrailer) {
    return Uint8Array.from(sig);
  }
  throw new Error(`${label}_invalid_sighash:${sig[64] ?? -1}`);
}

function hashTapBranch(a: Uint8Array, b: Uint8Array): Uint8Array {
  const compare = Buffer.compare(Buffer.from(a), Buffer.from(b));
  const [left, right] = compare <= 0 ? [a, b] : [b, a];
  return tagSchnorr('TapBranch', concatBytes(left, right));
}

function computeMerkleRoot(
  leafHash: Uint8Array,
  controlBlock: { merklePath: Uint8Array[] }
): Uint8Array {
  return controlBlock.merklePath.reduce((acc, node) => {
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

async function fetchVaultOrThrow(vaultId: string): Promise<VaultRecord> {
  const record = await vaultStore.getVault(vaultId);
  if (!record) {
    throw new Error('vault_not_found');
  }
  if (!record.txid) {
    throw new Error('vault_txid_missing');
  }
  if (record.withdrawTxId) {
    throw new Error('vault_already_withdrawn');
  }
  return record;
}

function analyzeVaultPsbt(psbtBase64: string, record: VaultRecord): ParsedPsbt {
  console.info('[withdraw] analyze psbt start', { vaultId: record.vaultId, psbtLength: psbtBase64.length });
  if (!psbtBase64) {
    throw new Error('missing_psbt');
  }
  let psbtBytes: Uint8Array;
  try {
    const buf = Buffer.from(psbtBase64, 'base64');
    if (!buf.length) {
      throw new Error('empty_psbt');
    }
    psbtBytes = new Uint8Array(buf);
  } catch {
    throw new Error('invalid_psbt_encoding');
  }

  let tx: Transaction;
  try {
    tx = Transaction.fromPSBT(psbtBytes, {
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

  const protocolKey = record.protocolPublicKey.toLowerCase();
  const tapLeafScripts = vaultInput.tapLeafScript ?? [];
  const matchingIndex = tapLeafScripts.findIndex(([_, scriptWithVer]) => {
    const scriptHex = bytesToHex(scriptWithVer.subarray(0, scriptWithVer.length - 1));
    return scriptHex.includes(protocolKey);
  });
  const matchingLeaf = matchingIndex >= 0 ? tapLeafScripts[matchingIndex] : tapLeafScripts[0];
  if (!matchingLeaf || matchingLeaf[1].length === 0) {
    throw new Error('protocol_leaf_not_found');
  }
  console.info('[withdraw] matching tapleaf found', {
    vaultId: record.vaultId,
    vaultInputIndex,
    totalLeaves: tapLeafScripts.length,
    matchedLeafIndex: matchingIndex,
    scriptHexPreview: bytesToHex(matchingLeaf[1]).slice(0, 40),
    controlBlockVersion: matchingLeaf[0].version,
    merklePathLength: matchingLeaf[0].merklePath.length
  });

  const [controlBlock, scriptWithVer] = matchingLeaf;
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
    leafHash,
    leafScript,
    leafVersion,
    controlBlockBytes,
    merkleRoot,
    sighash,
    hashType,
    psbtBase64
  };
}

export async function prepareWithdraw(vaultId: string, burnMetadata?: string): Promise<WithdrawPrepareResult> {
  console.info('[withdraw] prepare start', { vaultId, burnMetadataProvided: Boolean(burnMetadata) });
  const record = await vaultStore.getVault(vaultId);
  if (!record) {
    throw new Error('vault_not_found');
  }
  if (!record.txid) {
    throw new Error('vault_txid_missing');
  }
  if (record.withdrawTxId) {
    throw new Error('vault_already_withdrawn');
  }

  const txInfo = await runCliJson<RawTxInfo>(['getrawtransaction', record.txid, 'true']);
  console.info('[withdraw] raw transaction fetched', { vaultId, txid: record.txid });
  const ordEntry = txInfo.vout.find((v) => matchesAddress(v, record.metadata.ordinalsAddress));
  const vaultEntry = txInfo.vout.find((v) => matchesAddress(v, record.vaultAddress));
  if (!ordEntry || !vaultEntry) {
    throw new Error('vault_outputs_not_found');
  }

  const inputs = [
    { txid: record.txid, vout: ordEntry.n, value: ordEntry.value },
    { txid: record.txid, vout: vaultEntry.n, value: vaultEntry.value },
  ];

  const outputs = {
    data: (burnMetadata ?? DEFAULT_BURN_METADATA).toLowerCase(),
    [record.metadata.paymentAddress]: Number(satsToBtcString(PAYMENT_WITHDRAW_SATS)),
  } as Record<string, string | number>;

  const rawTx = await runCliRaw([
    'createrawtransaction',
    JSON.stringify(inputs),
    JSON.stringify(outputs),
  ]);
  console.info('[withdraw] raw transaction created', {
    vaultId,
    rawTxLength: rawTx.length,
    rawTxPreview: rawTx.slice(0, 120)
  });

  const patched = patchWithdrawData(rawTx, outputs.data as string);
  console.info('[withdraw] burn metadata patched', {
    vaultId,
    patchedLength: patched.length,
    patchedPreview: patched.slice(0, 120)
  });
  const initialPsbt = await runCliRaw(['converttopsbt', patched]);
  console.info('[withdraw] converted to psbt', {
    vaultId,
    psbtLength: initialPsbt.length,
    psbt: initialPsbt
  });

  const ordWallet = `ord-${sanitizeWalletName(record.metadata.ordinalsAddress)}`;
  const vaultWallet = `vault-${vaultId}`;

  const ordProcessed = await runCliJson<{ psbt: string }>(
    ['walletprocesspsbt', initialPsbt, 'false'],
    { wallet: ordWallet }
  );
  console.info('[withdraw] ord walletprocesspsbt complete', {
    vaultId,
    ordWallet,
    psbtLength: ordProcessed.psbt.length,
    psbtPreview: ordProcessed.psbt.slice(0, 120),
    psbt: ordProcessed.psbt
  });
  const finalPsbt = await runCliJson<{ psbt: string }>(
    ['walletprocesspsbt', ordProcessed.psbt, 'false'],
    { wallet: vaultWallet }
  );
  console.info('[withdraw] vault walletprocesspsbt complete', {
    vaultId,
    vaultWallet,
    psbtLength: finalPsbt.psbt.length,
    psbtPreview: finalPsbt.psbt.slice(0, 120),
    psbt: finalPsbt.psbt
  });

  return {
    psbt: finalPsbt.psbt,
    burnMetadata: outputs.data as string,
    inputs,
    vaultId,
    ordinalsAddress: record.metadata.ordinalsAddress,
    paymentAddress: record.metadata.paymentAddress,
    vaultAddress: record.vaultAddress,
  };
}

export async function requestProtocolSignature(
  vaultId: string,
  psbtBase64: string
): Promise<WithdrawSignatureRequest> {
  const record = await fetchVaultOrThrow(vaultId);
  const analysis = analyzeVaultPsbt(psbtBase64, record);
  return {
    vaultId,
    tapleafHash: bytesToHex(analysis.leafHash),
    controlBlock: bytesToHex(analysis.controlBlockBytes),
    sighash: bytesToHex(analysis.sighash),
    merkleRoot: bytesToHex(analysis.merkleRoot),
    leafScript: bytesToHex(analysis.leafScript)
  };
}

export async function finalizeWithdrawPsbt(
  vaultId: string,
  psbtBase64: string,
  protocolSignatureHex: string,
  broadcast = true
): Promise<WithdrawFinalizeResult> {
  console.info('[withdraw] finalize start', {
    vaultId,
    psbtLength: psbtBase64.length,
    psbt: psbtBase64
  });
  const record = await fetchVaultOrThrow(vaultId);
  const analysis = analyzeVaultPsbt(psbtBase64, record);
  const hashType = analysis.hashType;
  const normalizedProtocolHex = normalizeSignatureHex(protocolSignatureHex);
  const signature = hexToBytes(normalizedProtocolHex);
  console.info('[withdraw] protocol signature decoded', { vaultId });

  const protocolKeyBytes = hexToBytes(record.protocolPublicKey);
  const protocolKeyHex = record.protocolPublicKey.toLowerCase();
  console.info('[withdraw] protocol signature decoded', {
    vaultId,
    signatureHex: protocolSignatureHex
  });
  const input = analysis.tx.getInput(analysis.vaultInputIndex);
  const existingTapSigs = input.tapScriptSig ?? [];
  const userEntry = existingTapSigs.find(
    ([key]) => bytesToHex(key.pubKey).toLowerCase() !== record.protocolPublicKey.toLowerCase()
  );
  if (!userEntry) {
    throw new Error('user_signature_missing');
  }
  if (!userEntry[0].leafHash || !equalBytes(userEntry[0].leafHash, analysis.leafHash)) {
    throw new Error('user_signature_for_different_leaf');
  }

  const protocolWitness = normalizeTaprootSignature(signature, 'protocol_signature', hashType);
  const userEntryIndex = existingTapSigs.indexOf(userEntry);
  const userSignature = normalizeTaprootSignature(userEntry[1], 'user_signature', hashType);
  const userEntryUpdated = [userEntry[0], userSignature] as typeof userEntry;
  console.info('[withdraw] signature artifacts', {
    vaultId,
    hashType,
    sighash: bytesToHex(analysis.sighash),
    userSignatureHex: bytesToHex(userSignature),
    protocolSignatureHex: bytesToHex(protocolWitness)
  });

  const filteredTapSigs = existingTapSigs
    .filter((_, idx) => idx !== userEntryIndex)
    .filter(([key]) => bytesToHex(key.pubKey).toLowerCase() !== protocolKeyHex);
  const otherLeafEntries = filteredTapSigs.filter(
    (entry) => !entry[0].leafHash || !equalBytes(entry[0].leafHash, analysis.leafHash)
  );

  const controlBlockBytes = Uint8Array.from(analysis.controlBlockBytes);
  const controlBlockObject = analysis.controlBlock;
  const scriptWithVersion = new Uint8Array(analysis.leafScript.length + 1);
  scriptWithVersion.set(analysis.leafScript, 0);
  scriptWithVersion[scriptWithVersion.length - 1] = analysis.leafVersion;

  console.info('[withdraw] tapleaf artifacts', {
    vaultId,
    protocolSigLen: protocolWitness.length,
    userSigLen: userSignature.length,
    controlBlockLen: controlBlockBytes.length,
    scriptWithVersionLen: scriptWithVersion.length
  });

  const existingLeafScripts = input.tapLeafScript ?? [];
  const hasLeaf = existingLeafScripts.some(
    ([_, script]) => bytesToHex(script) === bytesToHex(scriptWithVersion)
  );
  const tapLeafScript = hasLeaf
    ? existingLeafScripts
    : [...existingLeafScripts, [controlBlockObject, scriptWithVersion] as [ControlBlock, Uint8Array]];

  const targetLeafEntries = [
    [{ pubKey: protocolKeyBytes, leafHash: analysis.leafHash }, protocolWitness] as [
      { pubKey: Uint8Array; leafHash: Uint8Array },
      Uint8Array
    ],
    userEntryUpdated
  ];

  const newTapScriptSig = [...otherLeafEntries, ...targetLeafEntries];

  analysis.tx.updateInput(
    analysis.vaultInputIndex,
    {
      tapLeafScript,
      tapScriptSig: newTapScriptSig
    },
    true
  );

  let patchedPsbt = sanitizePsbtString(
    Buffer.from(analysis.tx.toPSBT(analysis.tx.opts.PSBTVersion ?? 0)).toString('base64')
  );
  console.info('[withdraw] psbt after protocol insertion', {
    vaultId,
    psbtLength: patchedPsbt.length,
    psbt: patchedPsbt
  });

  const originalPsbt = sanitizePsbtString(psbtBase64);
  const combinedPayload = JSON.stringify([originalPsbt, patchedPsbt]);
  const combinedPsbt = sanitizePsbtString(await runCliRaw(['combinepsbt', combinedPayload]));
  console.info('[withdraw] psbt combined', {
    vaultId,
    originalLength: originalPsbt.length,
    patchedLength: patchedPsbt.length,
    combinedLength: combinedPsbt.length,
    combinedPsbt
  });

  const witnessStack = buildWitnessStack([
    userSignature,
    protocolWitness,
    analysis.leafScript,
    controlBlockBytes
  ]);
  console.info('[withdraw] witness stack prepared', {
    vaultId,
    witnessItems: 4,
    userSigLen: userSignature.length,
    protocolSigLen: protocolWitness.length,
    scriptLen: analysis.leafScript.length,
    controlBlockLen: controlBlockBytes.length,
    controlBlockPrefix: controlBlockBytes[0]
  });

  const applied = applyFinalWitnessToPsbt(combinedPsbt, analysis.vaultInputIndex, witnessStack);
  patchedPsbt = applied.psbt;
  console.info('[withdraw] final witness applied', {
    vaultId,
    psbtLength: patchedPsbt.length,
    localHex: Boolean(applied.hex)
  });

  let rawHex = applied.hex;
  if (!rawHex) {
    const finalize = await runCliJson<{ psbt?: string; hex: string; complete: boolean }>([
      'finalizepsbt',
      patchedPsbt
    ]);
    if (!finalize.complete || !finalize.hex) {
      const report = await runCliJson<any>(['analyzepsbt', patchedPsbt]);
      console.error('[withdraw] finalize incomplete', { vaultId, report });
      throw new Error('withdraw_finalize_incomplete');
    }
    rawHex = finalize.hex;
    if (finalize.psbt) {
      patchedPsbt = sanitizePsbtString(finalize.psbt);
    }
  }

  let txid: string | undefined;
  if (broadcast) {
    txid = await runCliRaw(['sendrawtransaction', rawHex]);
    console.info('[withdraw] transaction broadcasted', { vaultId, txid });
    await vaultStore.setWithdrawTxId(vaultId, txid);
  }

  return {
    vaultId,
    psbt: patchedPsbt,
    hex: rawHex,
    txid: txid ?? null
  };
}
