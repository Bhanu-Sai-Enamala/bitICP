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

type RecoveryHint = { recovery: number; compressed: boolean };

function decodeSignature(signatureBase64: string): { compact: Uint8Array; hints: RecoveryHint[] } {
  const raw = Buffer.from(signatureBase64, 'base64');
  if (raw.length < 64) {
    throw new Error('Invalid signature length');
  }
  let header: number | undefined;
  let compact: Uint8Array;
  if (raw.length >= 65) {
    header = raw[raw.length - 65];
    compact = raw.subarray(raw.length - 64);
  } else {
    compact = raw;
  }

  const hints: RecoveryHint[] = [];
  if (header !== undefined) {
    const value = header - 27;
    if (value >= 0 && value <= 15) {
      const recovery = value & 3;
      const compressed = !!(value & 4);
      hints.push({ recovery, compressed });
    }
  }
  if (!hints.length) {
    for (let recovery = 0; recovery < 4; recovery += 1) {
      hints.push({ recovery, compressed: true });
      hints.push({ recovery, compressed: false });
    }
  }
  return { compact, hints };
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
  const msgHash = bitcoinMessageHash(message);
  const { compact, hints } = decodeSignature(signatureBase64);
  for (const hint of hints) {
    try {
      const sig = secp256k1.Signature.fromCompact(compact).addRecoveryBit(hint.recovery);
      const pubkey = sig.recoverPublicKey(msgHash).toRawBytes(hint.compressed);
      const derivedHash = hash160(pubkey);
      if (decoded.type === 'wpkh' || decoded.type === 'pkh') {
        if (Buffer.from(derivedHash).equals(Buffer.from(decoded.hash))) {
          return true;
        }
      }
    } catch {
      continue;
    }
  }
  return false;
}
