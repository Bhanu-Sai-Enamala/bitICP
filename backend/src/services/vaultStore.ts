import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

export interface VaultRecordMetadata {
  rune: string;
  feeRate: number;
  ordinalsAddress: string;
  paymentAddress: string;
}

export interface VaultRecord {
  vaultId: string;
  protocolPublicKey: string;
  protocolChainCode: string;
  vaultAddress: string;
  descriptor: string;
  metadata: VaultRecordMetadata;
  createdAt: number;
  collateralSats: number;
  txid?: string;
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
        .map((record) => ({ ...record, collateralSats: record.collateralSats ?? 0 }))
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

  async recordVault(record: Omit<VaultRecord, 'createdAt'>): Promise<void> {
    await this.ready;
    const enriched: VaultRecord = { ...record, createdAt: Date.now() };
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
}

export const vaultStore = new VaultStore(config.vaultDbPath);
