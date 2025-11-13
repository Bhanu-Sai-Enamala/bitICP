import { schnorr } from '@noble/curves/secp256k1';

const hexToBytes = (h: string) =>
  Uint8Array.from(h.match(/.{2}/g)!.map((b) => parseInt(b, 16)));

const sighashHex = '3dab265553e7fb101e9802f302cf96835903950a3d4357ffee733cd1fe320c9d';

const userPubHex = '73c48193af1d474ed2d332c1e75292b19deafce27963f0139998b9a8c1ebf15c';
const protocolPubHex = '721a228a6524b6fbe79b1cc108989fd4f9a96cd9fdd6faaa5eb623a0d6a65575';

const userSigHex =
  '144cd53f27eb01e0b1434d301b3277ec7d5708f5beec9a1feb8693a16dc42505cf69ec35a7a4ee4762b01d75b37d26f76b48a9798ff4d99236ab9ab847299fe0';
const protocolSigHex =
  'd98b1d5328af0eb7874938193c1408ca79b7cd0e3844fbdfe29ba628c725a8308f0786a6ae5dfe158a26bb5140f3d13a64da01c1e3d2d836c7b229134274d6df';

const msg = hexToBytes(sighashHex);
const userPub = hexToBytes(userPubHex);
const protocolPub = hexToBytes(protocolPubHex);
const userSig = hexToBytes(userSigHex);
const protocolSig = hexToBytes(protocolSigHex);

const userOk = schnorr.verify(userSig, msg, userPub);
const protocolOk = schnorr.verify(protocolSig, msg, protocolPub);

console.log({ userOk, protocolOk });
