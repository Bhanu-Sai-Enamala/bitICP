# bUSD Stablecoin on ICP

bUSD is our Encode Club Bitcoin DeFi submission: a BTC-collateralized stablecoin that runs on the Internet Computer. The repo bundles the Rust canister, TypeScript backend, and a Vite + React frontend so you can either jump straight into the hosted dapp or tinker locally.

## Try It Fast

1. **Hosted app (recommended).** Hit `https://2e36g-4qaaa-aaaae-acxka-cai.icp0.io/#/app` and interact with the live stablecoin canister (`hnpl7-tyaaa-aaaae-acvnq-cai`) plus our managed backend (`https://api.hulubastian.online`).
2. **Local frontend, same backend.**
   ```bash
   cd frontend
   npm install
   cp .env.ic.example .env       # already points to the deployed canister + backend
   npm run dev                   # http://localhost:5173
   ```
   Hot reload locally, but every action still talks to the canister + backend we deployed for the hackathon.

## Docs & Demo
- **Deck / Docs:** https://drive.google.com/file/d/1VqzZs7xeaZTOuaGb5_M5gragmb2JGHch/view (also in `Documentation/bUSD_ICP_Bitcoin_Native_Stablecoin_docs.pdf`)
- **Demo video:** https://drive.google.com/file/d/1R_EjoS82Nnik87fNPnUVruHGluhRzwk8/view?usp=sharing

## Quick Facts

- **Stablecoin canister:** `hnpl7-tyaaa-aaaae-acvnq-cai`
- **Frontend asset canister:** `2e36g-4qaaa-aaaae-acxka-cai`
- **Hosted backend:** `https://api.hulubastian.online` (`x-api-key` already baked into `.env.ic.example`)
- **Token symbol:** `USDBZ` (demo ticker representing the bUSD stablecoin for hackathon purposes)

## Hackathon Notes

- **Event:** ICP Bitcoin DeFi Hackathon — Encode Club
- **Project:** bUSD Stablecoin (BTC-backed, liquidation-aware vaults)
- **Team:** BhanuSai (bhanusai2607@gmail.com)
- **Demo:** Hosted frontend (above) or `npm run dev --prefix frontend` pointing at the live stack

Questions or ideas? Open an issue with reproduction steps and we’ll help you dig in.

## Features
- **BTC-Native Collateral** — All mint, withdraw, and auction logic occur directly on Bitcoin using Taproot scripts.
- **Threshold-Secured** — Protocol keys come from ICP’s chain-key Schnorr signing API (key_1), no private keys stored.
- **Atomic Minting & Redeeming** — Every operation is a single Bitcoin transaction; no intermediaries or partial states.
- **On-Chain Liquidation Engine** — Vault health tracked in real-time using XRC; auctions trigger automatically under 112%.
- **SIWB + Watch-Only Architecture** — Frontend authenticates via Xverse, backend preloads deterministic vault wallets.

## System Architecture (High-Level)
User (Xverse Wallet)
        |
        v
Frontend Canister (assets)
        |
        v
Stablecoin Canister (Rust)
 - vault state machine
 - XRC oracle
 - ICP schnorr key_1
 - HTTPS outcalls → backend
        |
        v
Backend (Node + Bitcoin Core testnet4)
 - PSBT builder
 - descriptor wallets
 - broadcaster
        |
        v
Bitcoin Network (UTXOs)

## How It Works
Users connect via SIWB, the stablecoin canister pulls BTC/USD price from XRC, derives protocol/oracle/liquidation keys via ICP chain-key schnorr, and sends a signed payload to the backend to build a deterministic PSBT. The user signs in Xverse; the canister adds its threshold signature and broadcasts through ICP’s native Bitcoin API. Vault health is monitored every 60 seconds, and auctions execute automatically if collateral falls below 112%.

## Developer Commands
```bash
# install deps
npm install --prefix frontend

# local frontend
npm run dev --prefix frontend
```

## Demo Video
https://drive.google.com/file/d/1R_EjoS82Nnik87fNPnUVruHGluhRzwk8/view?usp=sharing
