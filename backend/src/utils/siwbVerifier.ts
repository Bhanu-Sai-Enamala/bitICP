import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { Address, OutScript } from '@scure/btc-signer';
import { Script, OP } from '@scure/btc-signer/script';
import { SigHash, Transaction } from '@scure/btc-signer/transaction';
import { NETWORK, TEST_NETWORK, concatBytes } from '@scure/btc-signer/utils';

const encoder = new TextEncoder();

function isTestnet(address: string): boolean {
  return address.startsWith('tb') || address.startsWith('m') || address.startsWith('n') || address.startsWith('2');
}

function encodeVarInt(value: number): Uint8Array {
  if (value < 0xfd) {
    return Uint8Array.of(value);
  }
  if (value <= 0xffff) {
    const buf = new Uint8Array(3);
    buf[0] = 0xfd;
    const view = new DataView(buf.buffer);
    view.setUint16(1, value, true);
    return buf;
  }
  const buf = new Uint8Array(5);
  buf[0] = 0xfe;
  const view = new DataView(buf.buffer);
  view.setUint32(1, value, true);
  return buf;
}

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

function bip322Hash(message: string): Uint8Array {
  const tag = encoder.encode('BIP0322-signed-message');
  const tagHash = sha256(tag);
  return sha256(concatBytes(tagHash, tagHash, encoder.encode(message)));
}

function buildTxToSpend(messageHash: Uint8Array, outputScript: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  const version = new Uint8Array(4); // 0x00000000
  parts.push(version);
  parts.push(Uint8Array.of(0x01)); // input count
  parts.push(new Uint8Array(32)); // prevout hash zero
  const index = new Uint8Array(4);
  new DataView(index.buffer).setUint32(0, 0xffffffff, true);
  parts.push(index);
  const scriptSig = concatBytes(Uint8Array.of(0x00, 0x20), messageHash);
  parts.push(encodeVarInt(scriptSig.length));
  parts.push(scriptSig);
  parts.push(new Uint8Array(4)); // sequence zero
  parts.push(Uint8Array.of(0x01)); // outputs
  const value = new Uint8Array(8); // zero value
  parts.push(value);
  parts.push(encodeVarInt(outputScript.length));
  parts.push(outputScript);
  parts.push(new Uint8Array(4)); // locktime zero
  return concatBytes(...parts);
}

function decodeBase64(signature: string): Uint8Array {
  let normalized = signature.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4 !== 0) {
    normalized += '=';
  }
  return Uint8Array.from(Buffer.from(normalized, 'base64'));
}

function decodeTaprootSignature(signature: string): Uint8Array {
  const raw = decodeBase64(signature);
  if (!raw.length) throw new Error('Empty signature');
  const scriptBytes = raw.slice(1); // strip stack element count
  const ops = Script.decode(Uint8Array.from(scriptBytes));
  if (!ops.length) {
    throw new Error('Invalid taproot signature witness');
  }
  const push = ops[0];
  if (!(push instanceof Uint8Array || Array.isArray(push))) {
    throw new Error('Invalid taproot signature push');
  }
  const buf = new Uint8Array(push as Uint8Array);
  return buf.length === 65 ? buf.slice(0, -1) : buf;
}

function decodeSegwitSignature(signature: string): { sig: Uint8Array; pubkey: Uint8Array } {
  const raw = decodeBase64(signature);
  if (!raw.length) throw new Error('Empty segwit signature');
  const scriptBytes = raw.slice(1);
  const ops = Script.decode(Uint8Array.from(scriptBytes));
  if (ops.length !== 2) {
    throw new Error('Invalid segwit signature witness');
  }
  const sig = ops[0];
  const pubkey = ops[1];
  if (!(sig instanceof Uint8Array || Array.isArray(sig)) || !(pubkey instanceof Uint8Array || Array.isArray(pubkey))) {
    throw new Error('Malformed segwit witness');
  }
  const sigBytes = new Uint8Array(sig as Uint8Array);
  const sighashByte = sigBytes[sigBytes.length - 1];
  let trimmedSig = sigBytes;
  if ([0x01, 0x02, 0x03, 0x81, 0x82, 0x83].includes(sighashByte)) {
    trimmedSig = sigBytes.slice(0, -1);
  }
  return {
    sig: trimmedSig,
    pubkey: new Uint8Array(pubkey as Uint8Array),
  };
}

function txidBytes(txRaw: Uint8Array): Uint8Array {
  const hash = doubleSha256(txRaw);
  const reversed = Uint8Array.from(hash);
  for (let i = 0, j = reversed.length - 1; i < j; i++, j--) {
    const tmp = reversed[i];
    reversed[i] = reversed[j];
    reversed[j] = tmp;
  }
  return reversed;
}

export function verifySiwbSignature(address: string, signature: string, message: string): boolean {
  const network = isTestnet(address) ? TEST_NETWORK : NETWORK;
  const decoded = Address(network).decode(address);
  const outputScript = OutScript.encode(decoded);
  const messageHash = bip322Hash(message);
  console.debug('[siwb] verify start', {
    address,
    addressType: decoded.type,
    signatureLength: signature.length,
    network: network.bech32,
    outputScript: Buffer.from(outputScript).toString('hex'),
    signatureBase64: signature
  });
  const txToSpend = buildTxToSpend(messageHash, outputScript);
  const spendHashLE = txidBytes(txToSpend);

  const tx = new Transaction({
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
    version: 0,
    lockTime: 0
  });
  tx.addInput({
    witnessUtxo: { script: outputScript, amount: 0n },
    ...(decoded.type === 'tr' ? { tapInternalKey: decoded.pubkey } : {}),
    txid: spendHashLE,
    index: 0,
    sequence: 0
  });
  tx.addOutput({
    amount: 0n,
    script: Script.encode([OP.RETURN])
  });

  if (decoded.type === 'tr') {
    const schnorrSig = decodeTaprootSignature(signature);
    console.debug('[siwb] taproot witness parsed', { schnorrSigHex: Buffer.from(schnorrSig).toString('hex') });
    const prevScripts = [outputScript];
    const amounts = [0n];
    const sighash = tx.preimageWitnessV1(0, prevScripts, SigHash.DEFAULT, amounts);
    console.debug('[siwb] taproot sighash', { sighash: Buffer.from(sighash).toString('hex') });
    const ok = schnorr.verify(schnorrSig, sighash, decoded.pubkey);
    if (!ok) throw new Error('Taproot signature mismatch');
    console.debug('[siwb] taproot verification ok');
    return true;
  }

  if (decoded.type === 'wpkh') {
    const { sig, pubkey } = decodeSegwitSignature(signature);
    const prevScript = OutScript.encode(decoded);
    const sighash = tx.preimageWitnessV0(0, prevScript, SigHash.ALL, 0n);
    console.debug('[siwb] segwit sighash', { sighash: Buffer.from(sighash).toString('hex') });
    const parsedSig = secp256k1.Signature.fromDER(sig);
    const ok = secp256k1.verify(parsedSig, sighash, pubkey);
    if (!ok) throw new Error('Segwit signature mismatch');
    console.debug('[siwb] segwit verification ok');
    return true;
  }

  throw new Error('Unsupported address type for SIWB');
}
