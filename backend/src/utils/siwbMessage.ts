import { concatBytes, hash160, sha256, NETWORK, TEST_NETWORK } from '@scure/btc-signer/utils';
import { Address } from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { Buffer } from 'node:buffer';

const encoder = new TextEncoder();
const MESSAGE_PREFIX = encoder.encode('\u0018Bitcoin Signed Message:\n');

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

function bitcoinMessageHash(message: string): Uint8Array {
  const messageBytes = encoder.encode(message);
  const buffer = concatBytes(MESSAGE_PREFIX, encodeVarInt(messageBytes.length), messageBytes);
  return sha256(sha256(buffer));
}

function networkForAddress(address: string) {
  return address.toLowerCase().startsWith('bc') ? NETWORK : TEST_NETWORK;
}

function decodeSignature(signatureBase64: string) {
  const raw = Buffer.from(signatureBase64, 'base64');
  if (raw.length === 65) {
    const header = raw[0];
    if (header >= 27 && header <= 34) {
      const recovery = (header - 27) & 3;
      const compressed = !!((header - 27) & 4);
      const compact = raw.subarray(1);
      return { recovery, compressed, compact };
    }
    // Fallback for header defaults (e.g. 0x01 when wallet strips format byte)
    const recovery = 0;
    const compressed = true;
    const compact = raw.subarray(1);
    return { recovery, compressed, compact };
  }
  const compact = raw.subarray(0, 64);
  const recovery = 0;
  const compressed = true;
  return { recovery, compressed, compact };
}

export function verifyPaymentMessage(
  address: string,
  signatureBase64: string,
  message: string
): boolean {
  const network = networkForAddress(address);
  const decoded = Address(network).decode(address);
  if (decoded.type !== 'wpkh' && decoded.type !== 'pkh') {
    throw new Error('Unsupported address type for ECDSA verification');
  }
  const { recovery, compressed, compact } = decodeSignature(signatureBase64);
  const msgHash = bitcoinMessageHash(message);
  const sig = secp256k1.Signature.fromCompact(compact).addRecoveryBit(recovery);
  const pubkey = sig.recoverPublicKey(msgHash).toRawBytes(compressed);
  const derivedHash = hash160(pubkey);
  if (decoded.type === 'wpkh') {
    return Buffer.from(derivedHash).equals(Buffer.from(decoded.hash));
  }
  if (decoded.type === 'pkh') {
    return Buffer.from(derivedHash).equals(Buffer.from(decoded.hash));
  }
  return false;
}
