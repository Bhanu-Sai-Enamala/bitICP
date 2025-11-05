import { request, RpcErrorCode, AddressPurpose } from 'sats-connect';

export type WalletPurpose = 'payment' | 'ordinals' | 'stacks' | 'spark' | 'starknet';

export interface WalletAddress {
  address: string;
  publicKey: string;
  purpose: WalletPurpose;
  addressType: string;
  network?: string;
}

export interface XverseConnection {
  addresses: WalletAddress[];
  walletType?: string;
  network?: Record<string, { name: string }>;
}

function log(...args: unknown[]) {
  console.debug('[xverse]', ...args);
}

// --- network preset (env-driven) ---
const RAW = (import.meta.env.VITE_XVERSE_NETWORK ?? 'testnet').toLowerCase();
const IS_MAINNET = RAW === 'mainnet';
const NETWORK_NAME = IS_MAINNET ? 'Mainnet' : 'Testnet4';

// Optional: quick provider presence check (helps surface “nothing happens” cases)
function providerHint() {
  const w = window as any;
  const hasLegacy =
    !!w?.XverseProviders?.BitcoinProvider || !!w?.xverseProviders?.bitcoin || !!w?.BitcoinProvider || !!w?.bitcoin;
  log('provider presence', { hasLegacy, satsConnectInjected: !!w?.__SATS_CONNECT__ });
}

export async function connectXverse(): Promise<XverseConnection> {
  providerHint();

  log('connect (sats-connect)', { NETWORK_NAME });

  const res = await request('wallet_connect', {
    addresses: [AddressPurpose.Payment, AddressPurpose.Ordinals],
    message: 'Connect ICP BTC Stablecoin dapp to your Xverse wallet.',
    network: NETWORK_NAME, // sats-connect core expects a BitcoinNetworkType string
  });

  if (res.status === 'error') {
    log('wallet_connect error', res.error);
    if (res.error.code === RpcErrorCode.USER_REJECTION) {
      throw new Error('Connection request rejected by user.');
    }
    throw new Error(res.error.message ?? 'Failed to connect to Xverse.');
  }

  const addrs = res.result?.addresses ?? [];
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new Error('Xverse did not return any addresses.');
  }

  log('wallet_connect success', { count: addrs.length, network: res.result?.network, walletType: res.result?.walletType });

  return {
    addresses: addrs.map((a: any) => ({
      address: a.address,
      publicKey: a.publicKey ?? '',
      purpose: (a.purpose as WalletPurpose) ?? 'payment',
      addressType: a.addressType ?? '',
    })),
    walletType: res.result?.walletType,
    network: res.result?.network,
  };
}

export async function disconnectXverse(): Promise<void> {
  try {
    await request('wallet_disconnect', null);
    log('wallet_disconnect success');
  } catch (e) {
    log('wallet_disconnect error', e);
  }
}

type SignOpts = {
  signInputs?: Record<string, number[]>;
  broadcast?: boolean;
  autoFinalize?: boolean;
};

export async function signPsbtWithXverse(psbtBase64: string, opts: SignOpts = {}): Promise<string> {
  const { signInputs, broadcast = false, autoFinalize = false } = opts;
  log('signPsbt (sats-connect) →', {
    psbtLength: psbtBase64?.length,
    inputs: signInputs,
    broadcast,
    autoFinalize,
    NETWORK_NAME,
  });

  const res = await request('signPsbt', {
    psbt: psbtBase64,
    signInputs,
    broadcast,
  });

  if (res.status === 'error') {
    log('signPsbt error', res.error);
    if (res.error.code === RpcErrorCode.USER_REJECTION) {
      throw new Error('Signing request rejected by user.');
    }
    throw new Error(res.error.message ?? 'Xverse did not sign the PSBT.');
  }

  const signed =
    res.result?.signedPsbtBase64 ??
    res.result?.psbt ??
    res.result?.signedPsbt ??
    null;

  log('signPsbt success', { hasSigned: !!signed, len: signed?.length, txid: res.result?.txid });

  if (!signed) throw new Error('Xverse did not return a signed PSBT.');
  return signed;
}
