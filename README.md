# BTC Stablecoin on ICP — Monorepo Scaffold

This repository is a monorepo for building a BTC‑backed stablecoin on the Internet Computer (ICP). It includes:

- `canisters/` — Rust canisters (backend)
- `frontend/` — Vite + React + TypeScript app (frontend)
- `dfx.json` — ICP canister configuration
- `scripts/` — helper scripts (builds, etc.)

## Structure

```
.
├─ canisters/
│  ├─ Cargo.toml                  # Rust workspace for canisters
│  └─ stablecoin/
│     ├─ Cargo.toml               # Canister crate manifest
│     ├─ src/lib.rs               # Minimal canister: health/version/ping
│     └─ stablecoin.did           # Candid interface
├─ frontend/
│  ├─ package.json
│  ├─ index.html
│  ├─ tsconfig.json
│  ├─ vite.config.ts
│  └─ src/
│     ├─ main.tsx
│     └─ App.tsx
├─ scripts/
│  └─ build_rust_canister.sh      # Cargo build to wasm + optional optimize
├─ dfx.json
└─ .gitignore
```

## Getting Started

Prerequisites:

- Node.js 18+ and npm
- Rust toolchain with `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- `dfx` CLI
- Optional: `ic-cdk-optimizer` for smaller wasm

Install frontend deps:

```
npm install --prefix frontend
```

Build canisters and frontend:

```
dfx start --background
dfx deploy
```

Alternatively, build the canister directly:

```
bash scripts/build_rust_canister.sh stablecoin
```

## Next Steps

- Define token state, mint/redeem logic, and BTC integration
- Add candid methods for transfers, allowances, and supply queries
- Introduce oracle/bridge canister(s) for BTC price and proofing
- Wire the frontend to the canister with `@dfinity/agent` flows

Open an issue or tell me what code to add next, and I’ll extend this scaffold accordingly.

## Hackathon Coupon Request

- Hackathon: ICP Bitcoin DeFi Hackathon (Encode Club)
- Hackathon Link: https://www.encodeclub.com/my-programmes/icp-bitcoin-defi-hackathon
- Project: BTC Stablecoin on ICP (ICPbitfi)
- Team: BhanuSai
- Contact: bhanusai2607@gmail.com
- Request: 10T free cycles to deploy canisters for hackathon development and testing.
- Usage Plan:
  - Deploy Rust canister `stablecoin` to local and shared test subnets
  - Iterate on token logic (mint/redeem/transfer) and BTC integration canisters
  - Host the `frontend` asset canister for user testing and demos
- Notes: This repository is public and created specifically for the hackathon.

Deployment steps (local):
- `rustup target add wasm32-unknown-unknown`
- `npm install --prefix frontend`
- `dfx start --background && dfx deploy`

If approved, we will use the coupon to cover canister cycles during development, testing, and the demo period, and will share a live canister ID in the project README.

## Backend: Local Bitcoin Testnet4 Mint Service

To mirror the existing non-ICP flow locally, the repo now includes `backend/`, a TypeScript + Express service that shells out to your `bitcoin-cli -testnet4` node. Use it to exercise the mint PSBT flow before wiring the ICP canisters.

### Requirements

- `bitcoind -testnet4` running with RPC enabled and synced
- CLI access via `bitcoin-cli -testnet4 ...`
- Node.js 18+

### Setup & Run

```
cp backend/.env.example backend/.env   # adjust CLI path, fee defaults, keys if needed
npm install --prefix backend
# IMPORTANT: set API_KEY and (optionally) override FEE_RECIPIENT_ADDRESS in backend/.env
npm run dev --prefix backend            # or npm run build && npm start --prefix backend
```

The service listens on `http://localhost:3001` by default (`PORT` in `.env`).

### Vault key records (Taproot)

- Each mint call now includes `vaultId`, `protocolPublicKey`, and `protocolChainCode` supplied by the stablecoin canister’s threshold Schnorr API.
- The backend persists these entries to `backend/data/vaults.json` (override with `VAULT_DB_PATH` in `.env`) so you can audit which Taproot key/address backs every vault.
- Console logs echo the derived Taproot address and vault ID to simplify debugging while we stand up the withdraw flow.

### Endpoint: `POST /mint/build-psbt`

Request body (same shape used in the non-ICP flow):

```
{
  "rune": "FOOLBYTHEDAY",
  "feeRate": 12.0,
  "feeRecipient": "tb1pkde3l5fzut4n5h9m2jqfzwtn7q3j0eywl98h0rvg5swlvpra5wnqul27y2",
  "vaultId": "12345",
  "protocolPublicKey": "c97a2f0d8f56f9596fcd2c802b93db27f0c844700c5dfa4d499e2f6f92daad07",
  "protocolChainCode": "be6cdd9b5d42fcbc84751c9627c6908b9557b84dff65ff94da6f54b2f1eaa040",
  "ordinals": {
    "address": "tb1peexgh8rs0gnndfcq2z5atf4pqg3sv6zkd3f0h53hgcp78hwd0cqsuaz2w6",
    "addressType": "p2tr",
    "publicKey": "aa915ec4a01945574f6b7e914274926cbfd4680908eb5e42d5d15b01a3dd4547"
  },
  "payment": {
    "address": "tb1qnk9h7jygqjvd2sa20dskvl3vzl6r9hl5lm3ytd",
    "addressType": "p2wpkh",
    "publicKey": "0273c48193af1d474ed2d332c1e75292b19deafce27963f0139998b9a8c1ebf15c"
  }
}
```

"vaultId", "protocolPublicKey", and "protocolChainCode" come from the stablecoin canister’s threshold-signature flow; when calling the backend manually you must supply realistic values from a recent canister response.

"`feeRecipient`" in the payload is ignored; the backend always uses the configured `FEE_RECIPIENT_ADDRESS` (defaults to `tb1pkde3l5fzut4n5h9m2jqfzwtn7q3j0eywl98h0rvg5swlvpra5wnqul27y2`).

Optional `amounts` override:

```
"amounts": {
  "ordinalsSats": 1000,
  "feeRecipientSats": 1000,
  "vaultSats": 1000
}
```

### Response

Successful responses contain the finalized PSBT and the intermediate artifacts:

```
{
  "rune": "FOOLBYTHEDAY",
  "feeRate": 12,
  "result": {
    "wallet": "tb1q...",
    "descriptor": "wsh(...#checksum)",
    "vaultAddress": "tb1p...",
    "inputs": [ { "txid": "...", "vout": 0 } ],
    "rawTransactionHex": "0200...",
    "originalPsbt": "cHNidP8BA...",
    "patchedPsbt": "cHNidP8BA...",
    "changeOutput": { "address": "tb1q...", "amountBtc": "0.00012345" }
  }
}
```

### What the service automates

1. Creates/loads a watch-only wallet named after the user payment address.
2. Builds the vault descriptor with guardian + user key, imports it, and derives the vault address.
3. Runs `walletcreatefundedpsbt` with watch-only inputs, change options, and fee rate.
4. Decodes the PSBT, recreates the raw transaction with the expected OP_RETURN + outputs, and patches the runestone payload (`096a07…` → `0a6a5d07…`).
5. Converts the edited raw transaction back to a PSBT, updates it with UTXO metadata, and returns it for the client (e.g., Xverse) to sign.

Once signed, you can broadcast manually (`bitcoin-cli -testnet4 sendrawtransaction <hex>`) or extend the backend with an upload endpoint.

### HTTPS Outcall Bridge to the Canister

ICP canisters can only make HTTPS outcalls, so expose the backend securely and tell the canister where to find it.

1. **Expose the backend with HTTPS**
   - Option A: `cloudflared tunnel --url http://localhost:3001`
   - Option B: `ngrok http 3001`
   - Copy the generated `https://` URL (e.g., `https://quick-btc.ngrok-free.app`).
2. **Set the API key**
   - In `backend/.env`, set `API_KEY=<strong-secret>` and restart the backend/tunnel.
3. **Configure the canister**
   - Start the replica: `dfx start --background`
   - Deploy/redeploy: `dfx deploy stablecoin`
   - Point the canister to the HTTPS proxy (example):  
     `dfx canister call stablecoin set_backend_config '("https://quick-btc.ngrok-free.app", opt "my-secret")'`
4. **Request a PSBT via the canister**
   - `dfx canister call stablecoin build_psbt '(record { rune="FOOLBYTHEDAY"; fee_rate=12; fee_recipient="tb1pk..."; ordinals=record { address="..."; address_type="p2tr"; public_key="..." }; payment=record { address="..."; address_type="p2wpkh"; public_key="..." }; amounts=null })'`
   - The response mirrors the backend output (PSBT, raw hex, inputs, change output, etc.).

> Local replica notes: HTTP outcalls require valid HTTPS certificates. Tunnels such as Cloudflare or Ngrok provide trusted certs for localhost services, whereas self-signed certs will be rejected.

## Troubleshooting Checklist

If the canister returns `variant { Err = "backend responded with status 400" }` or trapps while trying to decode the backend response, walk through these steps:

### 1. Confirm the backend works directly

Run a `curl` against the Cloudflare URL. If this works, the backend is healthy.

```bash
curl -sS \
  -H "x-api-key: <API_KEY>" \
  -H "content-type: application/json" \
  --data '{
    "rune": "FOOLBYTHEDAY",
    "feeRate": 12.0,
    "feeRecipient": "tb1pkde3l5fzut4n5h9m2jqfzwtn7q3j0eywl98h0rvg5swlvpra5wnqul27y2",
    "ordinals": {
      "address": "tb1peexgh8rs0gnndfcq2z5atf4pqg3sv6zkd3f0h53hgcp78hwd0cqsuaz2w6",
      "addressType": "p2tr",
      "publicKey": "aa915ec4a01945574f6b7e914274926cbfd4680908eb5e42d5d15b01a3dd4547"
    },
    "payment": {
      "address": "tb1qnk9h7jygqjvd2sa20dskvl3vzl6r9hl5lm3ytd",
      "addressType": "p2wpkh",
      "publicKey": "0273c48193af1d474ed2d332c1e75292b19deafce27963f0139998b9a8c1ebf15c"
    }
  }' \
  https://<your-tunnel>.trycloudflare.com/mint/build-psbt
```

### 2. Rebuild the canister after code changes

When the Rust canister source changes, rebuild it so the deployed Wasm understands the camelCase payload sent to the backend.

```bash
bash scripts/build_rust_canister.sh stablecoin
```

### 3. Reinstall the canister

Ensure `.dfx/local` exists and redeploy.

```bash
mkdir -p .dfx/local
dfx deploy stablecoin --mode reinstall --yes
```

If `dfx` cannot connect to the local replica, stop lingering processes:

```bash
dfx stop
killall pocket-ic ic-replica 2>/dev/null
dfx start --background --clean
```

### 4. Point to the correct tunnel

Cloudflare rotates URLs when you restart the tunnel, so reset the canister config.

```bash
dfx canister call stablecoin set_backend_config '("https://<new-tunnel>.trycloudflare.com", opt "<API_KEY>")'
```

### 5. If decode errors persist

The backend expects camelCase JSON. The canister handles this by converting the snake_case Candid payloads into camelCase before making the HTTPS outcall. If you still see errors mentioning `addressType`/`publicKey`, repeat steps 2–4 to ensure the latest Wasm was rebuilt and redeployed.

## Fresh Clone Walkthrough

If you’re setting up this project from scratch (or want to reproduce the full path), follow these steps in order:

1. **Clone the repo**  
   ```bash
   git clone https://github.com/<your-org>/ICPbitfi.git
   cd ICPbitfi
   ```

2. **Start Bitcoin Core (testnet4)**  
   Launch `bitcoind` with a config that enables RPC and sets the testnet4 parameters, for example:
```ini
# ~/Library/Application Support/Bitcoin/bitcoin.conf
[testnet4]
testnet4=1
server=1
rpcuser=admin
rpcpassword=pass123
rpcport=48332
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
```
Then run:
```bash
bitcoind -daemon
```

3. **Install backend dependencies**
   ```bash
   npm install --prefix backend
   ```

4. **Run the backend**
```bash
npm run dev --prefix backend
```

5. **Install & expose Cloudflare tunnel**

   - Install `cloudflared` if it is not already available on your machine:
     ```bash
     # macOS (Homebrew)
     brew install cloudflared

     # Debian / Ubuntu
     curl -LO https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
     sudo dpkg -i cloudflared-linux-amd64.deb
     ```
     > If Homebrew or dpkg are not options, grab the binary from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/.
   - Start a quick tunnel that proxies your local backend:
   ```bash
   cloudflared tunnel --url http://localhost:3001
   ```
   - Note the generated `https://` URL (it changes each run). Share this with anyone consuming the backend or copy it into the `set_backend_config` call below.
   > Optional: if you have a Cloudflare account and want a persistent subdomain, run `cloudflared login` once and create a named tunnel following the Cloudflare docs.

6. **Prepare the local DFX workspace**
```bash
rm -rf .dfx
mkdir -p .dfx/local
   dfx start --background --clean
   ```

7. **Build and deploy the canister**
   ```bash
   bash scripts/build_rust_canister.sh stablecoin
   dfx deploy stablecoin --mode reinstall --yes
   ```

8. **Configure the canister to talk to the backend**
   ```bash
   dfx canister call stablecoin set_backend_config \
     '("https://<your-tunnel>.trycloudflare.com", opt "<API_KEY>")'
   ```

9. **Request a PSBT via the canister**
   ```bash
   dfx canister call stablecoin build_psbt '(
     record {
       rune = "FOOLBYTHEDAY";
       fee_rate = 12.0;
       fee_recipient = "tb1pkde3l5fzut4n5h9m2jqfzwtn7q3j0eywl98h0rvg5swlvpra5wnqul27y2";
       ordinals = record {
         address = "tb1peexgh8rs0gnndfcq2z5atf4pqg3sv6zkd3f0h53hgcp78hwd0cqsuaz2w6";
         address_type = "p2tr";
         public_key = "aa915ec4a01945574f6b7e914274926cbfd4680908eb5e42d5d15b01a3dd4547";
       };
       payment = record {
         address = "tb1qnk9h7jygqjvd2sa20dskvl3vzl6r9hl5lm3ytd";
         address_type = "p2wpkh";
         public_key = "0273c48193af1d474ed2d332c1e75292b19deafce27963f0139998b9a8c1ebf15c";
       };
       amounts = null;
     }
   )'
   ```

If everything is configured correctly, this returns the same PSBT payload you get from the direct `curl` call. If it doesn’t, work through the troubleshooting checklist above (curl check, rebuild, redeploy, reset tunnel).
