import { runCliJson } from '../utils/bitcoinCli.js';
import { getBtcPriceUsd } from './priceService.js';
import { config, SATS_PER_BTC } from '../config.js';
import { vaultStore, type VaultRecord, type VaultHealthStatus } from './vaultStore.js';

interface BitcoinTxInfo {
  confirmations?: number;
  blockhash?: string;
  in_active_chain?: boolean;
}

function determineHealth(ratioBps?: number, withdrawable?: boolean): VaultHealthStatus {
  if (ratioBps !== undefined && ratioBps < config.healthAtRiskRatioBps) {
    return 'at_risk';
  }
  if (withdrawable) {
    return 'confirmed';
  }
  return 'pending';
}

export async function refreshVaultHealth(record: VaultRecord): Promise<VaultRecord> {
  if (!record.txid) {
    return record;
  }

  let confirmations = record.confirmations ?? 0;
  try {
    const txInfo = await runCliJson<BitcoinTxInfo>(['getrawtransaction', record.txid, 'true']);
    confirmations = txInfo.confirmations ?? (txInfo.blockhash ? 1 : 0);
  } catch (error) {
    console.warn('[vaultHealth] gettransaction failed', {
      vaultId: record.vaultId,
      message: (error as Error)?.message
    });
    confirmations = 0;
  }

  const { price } = await getBtcPriceUsd();
  const collateralBtc = record.collateralSats / SATS_PER_BTC;
  const collateralUsd = collateralBtc * price;
  const mintedUsd = record.metadata.mintUsdCents / 100;
  const collateralRatioBps =
    mintedUsd > 0 ? Math.round((collateralUsd / mintedUsd) * 10_000) : undefined;
  const withdrawable = confirmations >= record.minConfirmations;
  const health = determineHealth(collateralRatioBps, withdrawable);

  const updated =
    (await vaultStore.updateVault(record.vaultId, {
      confirmations,
      withdrawable,
      lastBtcPriceUsd: price,
      collateralRatioBps,
      health,
      lastHealthCheck: Date.now()
    })) ?? record;
  return updated;
}

export async function refreshVaults(records: VaultRecord[]): Promise<VaultRecord[]> {
  const refreshed: VaultRecord[] = [];
  for (const record of records) {
    refreshed.push(await refreshVaultHealth(record));
  }
  return refreshed;
}
