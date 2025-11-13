const { schnorr } = require('@noble/curves/secp256k1');

const hexToBytes = (h) => Uint8Array.from(h.match(/.{2}/g).map((b) => parseInt(b, 16)));

const sighash = '3dab265553e7fb101e9802f302cf96835903950a3d4357ffee733cd1fe320c9d';
const userSig = 'ee7db95a8cc9be75e3900eb18657b0af8e072a880bd8c11c59fb2e23aed3765301adb5460f432014574f12fc42b11c595602a0409dd95a0eb42fb73ea43818c3';
const protocolSig = '5aac7ea375740253c3d03975b8bba370813a619c4d11bfefbdc44e89eeaef8970b994efcf2277f062cccc3561f2e038ee72c3b97e962a6f64b314bc675a5fda7';
const userPub = '73c48193af1d474ed2d332c1e75292b19deafce27963f0139998b9a8c1ebf15c';
const protocolPub = '721a228a6524b6fbe79b1cc108989fd4f9a96cd9fdd6faaa5eb623a0d6a65575';

const msg = hexToBytes(sighash);

console.log({
  userOk: schnorr.verify(hexToBytes(userSig), msg, hexToBytes(userPub)),
  protocolOk: schnorr.verify(hexToBytes(protocolSig), msg, hexToBytes(protocolPub)),
});
