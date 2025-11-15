import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, SATS_PER_BTC } from '../config.js';

export interface VaultRecordMetadata {
  rune: string;
  feeRate: number;
  ordinalsAddress: string;
  paymentAddress: string;
  mintTokens: number;
  mintUsdCents: number;
}

export type VaultHealthStatus = 'pending' | 'confirmed' | 'at_risk';

export interface VaultRecord {
  vaultId: string;
  protocolPublicKey: string;
  protocolChainCode: string;
  vaultAddress: string;
  descriptor: string;
  metadata: VaultRecordMetadata;
  createdAt: number;
  collateralSats: number;
  lockedCollateralBtc: number;
  minConfirmations: number;
  confirmations: number;
  withdrawable: boolean;
  lastBtcPriceUsd?: number;
  collateralRatioBps?: number;
  health?: VaultHealthStatus;
  lastHealthCheck?: number;
  txid?: string;
  withdrawTxId?: string;
}

class VaultStore {
  private readonly filePath: string;
  private readonly records = new Map<string, VaultRecord>();
  private ready: Promise<void>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      const blob = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(blob) as VaultRecord[];
      parsed
        .map((record) => this.normalize(record))
        .forEach((record) => this.records.set(record.vaultId, record));
      console.info('[vaultStore] bootstrap complete', { file: this.filePath, count: parsed.length });
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        await fsp.writeFile(this.filePath, '[]', 'utf8');
        console.info('[vaultStore] initialized empty store', { file: this.filePath });
      } else {
        console.warn('[vaultStore] failed to read existing file, resetting', {
          file: this.filePath,
          message: error?.message
        });
        await fsp.writeFile(this.filePath, '[]', 'utf8');
      }
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify(Array.from(this.records.values()), null, 2);
    await fsp.writeFile(this.filePath, payload, 'utf8');
  }

  private normalize(record: VaultRecord): VaultRecord {
    const legacyMeta = record.metadata ?? {
      rune: 'UNKNOWN',
      feeRate: 0,
      ordinalsAddress: '',
      paymentAddress: ''
    };
    const metadata: VaultRecordMetadata = {
      rune: legacyMeta.rune,
      feeRate: legacyMeta.feeRate,
      ordinalsAddress: legacyMeta.ordinalsAddress,
      paymentAddress: legacyMeta.paymentAddress,
      mintTokens: legacyMeta.mintTokens ?? 0,
      mintUsdCents: legacyMeta.mintUsdCents ?? 0
    };
    return {
      ...record,
      metadata,
      collateralSats: record.collateralSats ?? 0,
      lockedCollateralBtc:
        record.lockedCollateralBtc ?? (record.collateralSats ?? 0) / SATS_PER_BTC,
      minConfirmations: record.minConfirmations ?? config.vaultMinConfirmations,
      confirmations: record.confirmations ?? 0,
      withdrawable: record.withdrawable ?? false
    };
  }

  async recordVault(record: Omit<VaultRecord, 'createdAt'>): Promise<void> {
    await this.ready;
    const enriched: VaultRecord = this.normalize({ ...record, createdAt: Date.now() } as VaultRecord);
    this.records.set(record.vaultId, enriched);
    await this.persist();
    console.info('[vaultStore] recorded vault', {
      vaultId: record.vaultId,
      address: record.vaultAddress,
      protocolKey: record.protocolPublicKey
    });
  }

  async getVault(vaultId: string): Promise<VaultRecord | undefined> {
    await this.ready;
    return this.records.get(vaultId);
  }

  async listVaults(): Promise<VaultRecord[]> {
    await this.ready;
    return Array.from(this.records.values());
  }

  async listVaultsByPayment(paymentAddress: string): Promise<VaultRecord[]> {
    await this.ready;
    const needle = paymentAddress.toLowerCase();
    return Array.from(this.records.values())
      .filter((record) => record.metadata.paymentAddress.toLowerCase() === needle)
      .filter((record) => Boolean(record.txid))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async setTxId(vaultId: string, txid: string): Promise<void> {
    await this.ready;
    const found = this.records.get(vaultId);
    if (!found) return;
    this.records.set(vaultId, { ...found, txid });
    await this.persist();
    console.info('[vaultStore] txid recorded', { vaultId, txid });
  }

  async setWithdrawTxId(vaultId: string, txid: string): Promise<void> {
    await this.ready;
    const found = this.records.get(vaultId);
    if (!found) return;
    this.records.set(vaultId, { ...found, withdrawTxId: txid, withdrawable: false });
    await this.persist();
    console.info('[vaultStore] withdraw txid recorded', { vaultId, txid });
  }

  async updateVault(vaultId: string, patch: Partial<VaultRecord>): Promise<VaultRecord | undefined> {
    await this.ready;
    const found = this.records.get(vaultId);
    if (!found) return undefined;
    const merged = this.normalize({ ...found, ...patch } as VaultRecord);
    this.records.set(vaultId, merged);
    await this.persist();
    return merged;
  }
}

export const vaultStore = new VaultStore(config.vaultDbPath);
