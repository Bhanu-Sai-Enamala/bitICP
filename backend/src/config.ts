import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath, override: true });

const env = process.env;

export const SATS_PER_BTC = 100_000_000;

function satsEnv(key: string, fallback: number): number {
  const value = env[key];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: Number(env.PORT ?? 3001),
  bitcoinCliPath: env.BITCOIN_CLI_PATH ?? 'bitcoin-cli',
  bitcoinNetworkFlag: env.BITCOIN_NETWORK_FLAG ?? '-testnet4',
  mintRunestoneData: (env.MINT_RUNESTONE_DATA ?? '148aca0514ad01').toLowerCase(),
  guardianPublicKey:
    env.SERVER_GUARDIAN_KEY ??
    '03b24f7ae21c41df53bb95f138440c1b396404f1da2aa824821720d223685ed7f1',
  // Optional legacy vault keys used for a tapscript leaf until we move them to t‑Sigs
  vaultKeys: [
    env.SERVER_VAULT_KEY_A ??
      '0265f4ca4c628565963028803861eef79ff19f49223822e9bdfc49532148e79363',
    env.SERVER_VAULT_KEY_B ??
      '03cb4d09e437d2a3497d6507fe62f66f668c9c647d4ea9ffb02c8845c5c53ce663'
  ],
  apiKey: env.API_KEY,
  vaultDbPath: env.VAULT_DB_PATH ?? path.resolve(__dirname, '../data/vaults.json'),
  feeRecipientAddress:
    env.FEE_RECIPIENT_ADDRESS ??
    'tb1pkde3l5fzut4n5h9m2jqfzwtn7q3j0eywl98h0rvg5swlvpra5wnqul27y2',
  defaults: {
    ordinalsSats: satsEnv('DEFAULT_ORDINALS_SATS', 1000),
    feeRecipientSats: satsEnv('DEFAULT_FEE_RECIPIENT_SATS', 1000),
    vaultSats: satsEnv('DEFAULT_VAULT_SATS', 1000)
  },
  fallbackBtcPriceUsd: Number(env.FALLBACK_BTC_PRICE_USD ?? 100_734.1),
  vaultMinConfirmations: Number(env.VAULT_MIN_CONFIRMATIONS ?? 6),
  healthAtRiskRatioBps: Number(env.HEALTH_AT_RISK_RATIO_BPS ?? 15000)
};

export function satsToBtcString(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(8);
}
