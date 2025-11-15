import { useCallback, useEffect, useMemo, useState } from 'react';
import { stablecoinActor } from './ic';
import {
  connectXverse,
  disconnectXverse,
  signPsbtWithXverse,
  type XverseConnection
} from './xverse';

type StablecoinActor = Awaited<ReturnType<typeof stablecoinActor>>;

interface BuildPsbtOk {
  Ok: {
    result: {
      vault_address: string;
      vault_id: string;
      protocol_public_key: string;
      protocol_chain_code: string;
      descriptor: string;
      original_psbt: string;
      patched_psbt: string;
      raw_transaction_hex: string;
      inputs: Array<{ txid: string; vout: number }>;
      change_output: [{ address: string; amount_btc: string }] | [];
      wallet: string;
      collateral_sats: bigint;
      rune: string;
      fee_rate: number;
      ordinals_address: string;
      payment_address: string;
    };
  };
}
type BuildPsbtResult = BuildPsbtOk | { Err: string };

interface VaultMeta {
  vaultId: string;
  protocolPublicKey: string;
  protocolChainCode: string;
  vaultAddress: string;
  descriptor: string;
  collateralSats: number;
  rune: string;
  feeRate: number;
  ordinalsAddress: string;
  paymentAddress: string;
}

type CandidOpt<T> = [] | [T];

interface VaultSummary {
  vault_id: string;
  vault_address: string;
  collateral_sats: bigint;
  locked_collateral_btc: number;
  protocol_public_key: string;
  created_at: bigint;
  rune: string;
  fee_rate: number;
  ordinals_address: string;
  payment_address: string;
  txid: CandidOpt<string>;
  withdraw_txid: CandidOpt<string>;
  confirmations: number;
  min_confirmations: number;
  withdrawable: boolean;
  last_btc_price_usd: CandidOpt<number>;
  collateral_ratio_bps: CandidOpt<number>;
  mint_tokens: CandidOpt<number>;
  mint_usd_cents: CandidOpt<bigint>;
  health: CandidOpt<string>;
}

type VaultHealth = 'pending' | 'confirmed' | 'at_risk';

interface UiVault {
  id: string;
  rune: string;
  createdAtMs: number;
  collateralSats: number;
  lockedCollateralBtc: number;
  protocolPublicKey: string;
  ordinalsAddress: string;
  paymentAddress: string;
  vaultAddress: string;
  feeRate: number;
  confirmations: number;
  minConfirmations: number;
  withdrawable: boolean;
  health: VaultHealth;
  lastPriceUsd?: number;
  collateralRatioPercent?: number;
  mintTokens?: number;
  mintUsd?: number;
  mintTxId?: string;
  withdrawTxId?: string;
}

interface WithdrawInputRef {
  txid: string;
  vout: number;
  value: number;
}

interface WithdrawPrepareOk {
  vault_id: string;
  psbt: string;
  burn_metadata: string;
  inputs: WithdrawInputRef[];
  ordinals_address: string;
  payment_address: string;
  vault_address: string;
}

interface WithdrawFinalizeOk {
  vault_id: string;
  txid: [string] | [];
  hex: string;
}

interface CollateralPreview {
  price: number;
  sats: bigint;
  ratio_bps: number;
  usd_cents: number;
  using_fallback_price: boolean;
}

const DEFAULT_ORDINALS_ADDRESS =
  'tb1peexgh8rs0gnndfcq2z5atf4pqg3sv6zkd3f0h53hgcp78hwd0cqsuaz2w6';
const DEFAULT_ORDINALS_PUBKEY =
  'aa915ec4a01945574f6b7e914274926cbfd4680908eb5e42d5d15b01a3dd4547';
const DEFAULT_PAYMENT_ADDRESS = 'tb1qnk9h7jygqjvd2sa20dskvl3vzl6r9hl5lm3ytd';
const DEFAULT_PAYMENT_PUBKEY =
  '0273c48193af1d474ed2d332c1e75292b19deafce27963f0139998b9a8c1ebf15c';
const DEFAULT_FEE_RECIPIENT = 'tb1pkde3l5fzut4n5h9m2jqfzwtn7q3j0eywl98h0rvg5swlvpra5wnqul27y2';
const BACKEND_API_KEY = import.meta.env.VITE_BACKEND_API_KEY ?? '';
const MEMPOOL_BASE_URL = 'https://mempool.space/testnet4/tx/';
const SATS_PER_BTC = 100_000_000;
const DEFAULT_FEE_SATS = Number(import.meta.env.VITE_DEFAULT_FEE_SATS ?? 1000);
const LIQUIDATION_RATIO_BPS = 11200;
const DEFAULT_CONFIRMATION_TARGET = Number(
  import.meta.env.VITE_VAULT_MIN_CONFIRMATIONS ?? 6
);
const FIXED_MINT_TOKENS = 10;
const TARGET_COLLATERAL_RATIO = 130;
const RUNE_SYMBOL = 'USDBZ';

const formatNumber = (
  value?: number | null,
  options: Intl.NumberFormatOptions = {}
): string => {
  if (value == null || Number.isNaN(value)) return '--';
  return value.toLocaleString(undefined, options);
};

const formatBtc = (value?: number | null, digits = 8) =>
  formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });

const formatUsd = (value?: number | null, digits = 0) =>
  formatNumber(value, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });

function truncate(addr?: string, size = 4) {
  if (!addr) return '';
  if (addr.length <= size * 2 + 1) return addr;
  return `${addr.slice(0, size)}…${addr.slice(-size)}`;
}

const unwrapOpt = <T,>(value: CandidOpt<T> | undefined): T | undefined =>
  value && value.length ? value[0] : undefined;

const toVaultHealth = (value?: string): VaultHealth => {
  if (value === 'at_risk') return 'at_risk';
  if (value === 'confirmed') return 'confirmed';
  return 'pending';
};

const mapVaultSummary = (vault: VaultSummary): UiVault => {
  const mintTokens = unwrapOpt(vault.mint_tokens);
  const mintUsdCents = unwrapOpt(vault.mint_usd_cents);
  const mintUsd = mintUsdCents != null ? Number(mintUsdCents) / 100 : undefined;
  const ratioBps = unwrapOpt(vault.collateral_ratio_bps);
  const collateralRatioPercent = ratioBps != null ? ratioBps / 100 : undefined;
  const lastPriceUsd = unwrapOpt(vault.last_btc_price_usd);
  const lockedCollateral =
    Number.isFinite(vault.locked_collateral_btc) && vault.locked_collateral_btc > 0
      ? vault.locked_collateral_btc
      : Number(vault.collateral_sats ?? 0n) / SATS_PER_BTC;
  const healthSource =
    unwrapOpt(vault.health) ?? (vault.withdrawable ? 'confirmed' : 'pending');
  return {
    id: vault.vault_id,
    rune: vault.rune,
    createdAtMs: Number(vault.created_at ?? 0n),
    collateralSats: Number(vault.collateral_sats ?? 0n),
    lockedCollateralBtc: lockedCollateral,
    protocolPublicKey: vault.protocol_public_key,
    ordinalsAddress: vault.ordinals_address,
    paymentAddress: vault.payment_address,
    vaultAddress: vault.vault_address,
    feeRate: vault.fee_rate,
    confirmations: vault.confirmations ?? 0,
    minConfirmations: vault.min_confirmations ?? 0,
    withdrawable: Boolean(vault.withdrawable),
    health: toVaultHealth(healthSource),
    lastPriceUsd,
    collateralRatioPercent,
    mintTokens: mintTokens ?? undefined,
    mintUsd,
    mintTxId: unwrapOpt(vault.txid) ?? undefined,
    withdrawTxId: unwrapOpt(vault.withdraw_txid) ?? undefined
  };
};

export default function App() {
  const [actor, setActor] = useState<StablecoinActor | null>(null);
  const [backendUrl, setBackendUrl] = useState<string>();
  const [health, setHealth] = useState<string>();
  const [xverseConnection, setXverseConnection] = useState<XverseConnection | null>(null);
  const [psbtBase64, setPsbtBase64] = useState<string>();
  const [mintInputCount, setMintInputCount] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [vaultMeta, setVaultMeta] = useState<VaultMeta | null>(null);
  const [preview, setPreview] = useState<CollateralPreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);

  const [ordinalsAddress, setOrdinalsAddress] = useState(DEFAULT_ORDINALS_ADDRESS);
  const [ordinalsPubKey, setOrdinalsPubKey] = useState(DEFAULT_ORDINALS_PUBKEY);
  const [paymentAddress, setPaymentAddress] = useState(DEFAULT_PAYMENT_ADDRESS);
  const [paymentPubKey, setPaymentPubKey] = useState(DEFAULT_PAYMENT_PUBKEY);
  const [vaults, setVaults] = useState<UiVault[]>([]);
  const [isVaultsLoading, setIsVaultsLoading] = useState(false);
  const [infoMessage, setInfoMessage] = useState<string>();
  const [activeTab, setActiveTab] = useState<'mint' | 'withdraw'>('mint');
  const [pendingWithdraw, setPendingWithdraw] = useState<{
    vaultId: string;
    psbt: string;
    inputCount: number;
  } | null>(null);
  const [isWithdrawLoading, setIsWithdrawLoading] = useState(false);
  const [withdrawInfo, setWithdrawInfo] = useState<string>();
  const [withdrawError, setWithdrawError] = useState<string>();
  const [showWithdrawnVaults, setShowWithdrawnVaults] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const sc = await stablecoinActor();
        setActor(sc);
        const config = await sc.get_backend_config();
        setBackendUrl(config.base_url);
        setHealth('ok');
      } catch (e) {
        console.error('[frontend] failed to init actor', e);
        setHealth('error');
        setError((e as Error).message);
      }
    })();
  }, []);

  const refreshPreview = useCallback(async () => {
    if (!actor) return;
    setIsPreviewLoading(true);
    try {
      const response = await actor.get_collateral_preview();
      if ('Ok' in response) {
        setPreview(response.Ok);
      } else {
        console.warn('[frontend] collateral preview error', response.Err);
      }
    } catch (e) {
      console.error('[frontend] failed to fetch collateral preview', e);
    } finally {
      setIsPreviewLoading(false);
    }
  }, [actor]);

  useEffect(() => {
    if (!actor) return;
    refreshPreview();
  }, [actor, refreshPreview]);

  const buildPsbt = useCallback(async () => {
    if (!actor) {
      throw new Error('Canister actor not ready');
    }

    const response = (await actor.build_psbt({
      rune: 'USDBZ•STABLECOIN',
      fee_rate: 12,
      fee_recipient: DEFAULT_FEE_RECIPIENT,
      ordinals: {
        address: ordinalsAddress,
        address_type: 'p2tr',
        public_key: ordinalsPubKey
      },
      payment: {
        address: paymentAddress,
        address_type: 'p2wpkh',
        public_key: paymentPubKey
      },
      amounts: []
    })) as BuildPsbtResult;

    if ('Err' in response) {
      console.debug('[frontend] build_psbt error', response.Err);
      throw new Error(response.Err);
    }

    const result = response.Ok.result;
    console.debug('[frontend] build_psbt success', {
      vault: result.vault_address,
      vaultId: result.vault_id,
      inputs: result.inputs.length,
      wallet: result.wallet
    });
    setVaultMeta({
      vaultId: result.vault_id,
      protocolPublicKey: result.protocol_public_key,
      protocolChainCode: result.protocol_chain_code,
      vaultAddress: result.vault_address,
      descriptor: result.descriptor,
      collateralSats: Number(result.collateral_sats),
      rune: result.rune,
      feeRate: result.fee_rate,
      ordinalsAddress: result.ordinals_address,
      paymentAddress: result.payment_address,
    });
    const psbt = result.patched_psbt;
    setPsbtBase64(psbt);
    setMintInputCount(result.inputs.length);
    console.info('[frontend] received psbt', result);
    return { psbt, inputCount: result.inputs.length };
  }, [actor, ordinalsAddress, ordinalsPubKey, paymentAddress, paymentPubKey]);

  const handleConnectXverse = useCallback(async () => {
    setError(undefined);
    try {
      const connection = await connectXverse();
      setXverseConnection(connection);

      const paymentAcc = connection.addresses.find((entry) => entry.purpose === 'payment');
      if (paymentAcc) {
        setPaymentAddress(paymentAcc.address);
        if (paymentAcc.publicKey) {
          setPaymentPubKey(paymentAcc.publicKey);
        }
      }

      const ordinalsAcc = connection.addresses.find((entry) => entry.purpose === 'ordinals');
      if (ordinalsAcc) {
        setOrdinalsAddress(ordinalsAcc.address);
        if (ordinalsAcc.publicKey) {
          setOrdinalsPubKey(ordinalsAcc.publicKey);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const handleDisconnectXverse = useCallback(async () => {
    try {
      await disconnectXverse();
    } finally {
      setXverseConnection(null);
      setPendingWithdraw(null);
      setWithdrawInfo(undefined);
      setWithdrawError(undefined);
    }
  }, []);

  const paymentAccount = useMemo(
    () => xverseConnection?.addresses?.find((entry) => entry.purpose === 'payment'),
    [xverseConnection]
  );
  const ordinalsAccount = useMemo(
    () => xverseConnection?.addresses?.find((entry) => entry.purpose === 'ordinals'),
    [xverseConnection]
  );

  const loadVaults = useCallback(
    async (address: string) => {
      if (!actor) {
        setVaults([]);
        return;
      }
      const trimmed = address.trim();
      if (!trimmed) {
        setVaults([]);
        return;
      }
      setIsVaultsLoading(true);
      try {
        const response = await actor.list_user_vaults(trimmed);
        if ('Ok' in response) {
          const mapped = response.Ok.map((entry) => mapVaultSummary(entry));
          setVaults(mapped);
        } else {
          console.warn('[frontend] list_user_vaults error', response.Err);
        }
      } catch (e) {
        console.error('[frontend] list_user_vaults failed', e);
      } finally {
        setIsVaultsLoading(false);
      }
    },
    [actor]
  );

  const watchAddress = useMemo(
    () => paymentAccount?.address ?? paymentAddress,
    [paymentAccount?.address, paymentAddress]
  );

  useEffect(() => {
    if (!actor) {
      setVaults([]);
      return;
    }
    const target = watchAddress?.trim();
    if (!target) {
      setVaults([]);
      return;
    }
    loadVaults(target);
  }, [actor, watchAddress, loadVaults]);

  useEffect(() => {
    setPendingWithdraw(null);
    setWithdrawInfo(undefined);
    setWithdrawError(undefined);
  }, [paymentAccount?.address]);

  const collateralBtc = useMemo(
    () => (preview ? Number(preview.sats) / SATS_PER_BTC : null),
    [preview]
  );
  const collateralRatio = useMemo(
    () => (preview ? preview.ratio_bps / 100 : null),
    [preview]
  );
  const mintFeeBtc = DEFAULT_FEE_SATS / SATS_PER_BTC;
  const liquidationPrice = useMemo(() => {
    if (!preview || preview.ratio_bps === 0) return null;
    return preview.price * (LIQUIDATION_RATIO_BPS / preview.ratio_bps);
  }, [preview]);
  const minBalanceBtc = collateralBtc != null ? collateralBtc + mintFeeBtc : null;
  const tokensDisplay = formatNumber(FIXED_MINT_TOKENS, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
  const ratioDisplay = collateralRatio != null
    ? `${formatNumber(collateralRatio, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}%`
    : '--';
  const usingFallbackPrice = preview?.using_fallback_price ?? false;
  const priceDisplay = formatUsd(preview?.price);
  const liquidationDisplay = formatUsd(liquidationPrice);
  const feeDisplay = `${formatBtc(mintFeeBtc)} BTC`;
  const minBalanceDisplay = minBalanceBtc != null ? `${formatBtc(minBalanceBtc)} BTC` : '--';
  const mintedButtonLabel = `Mint ${tokensDisplay} ${RUNE_SYMBOL}`;
  const collateralDisplayValue = formatBtc(collateralBtc);
  const priceDotClass = usingFallbackPrice ? 'status-dot fallback' : 'status-dot online';
  const mintPanelSubtitle = usingFallbackPrice
    ? 'BTC price unavailable. Showing fallback collateral values.'
    : 'Live collateral and fee requirements.';
  const backendHost = useMemo(() => {
    if (!backendUrl) return 'not set';
    try {
      return new URL(backendUrl).host;
    } catch {
      return backendUrl;
    }
  }, [backendUrl]);

  const sortedVaults = useMemo(
    () => [...vaults].sort((a, b) => a.createdAtMs - b.createdAtMs),
    [vaults]
  );
  const visibleVaults = useMemo(
    () => sortedVaults.filter((vault) => showWithdrawnVaults || !vault.withdrawTxId),
    [sortedVaults, showWithdrawnVaults]
  );
  const hiddenWithdrawnCount = useMemo(
    () => sortedVaults.filter((vault) => vault.withdrawTxId).length,
    [sortedVaults]
  );
  const deriveRatio = useCallback(
    (vault: UiVault): number | undefined => {
      const price = vault.lastPriceUsd ?? preview?.price;
      if (!price || FIXED_MINT_TOKENS <= 0) {
        return undefined;
      }
      return (vault.lockedCollateralBtc * price) / FIXED_MINT_TOKENS * 100;
    },
    [preview?.price]
  );
  const totalLockedBtc = useMemo(() => {
    return visibleVaults.reduce((sum, vault) => sum + (vault.lockedCollateralBtc ?? 0), 0);
  }, [visibleVaults]);
  const avgCollateralRatio = useMemo(() => {
    const ratios = visibleVaults
      .map((vault) => deriveRatio(vault))
      .filter((value): value is number => value != null);
    if (!ratios.length) return null;
    const total = ratios.reduce((sum, value) => sum + value, 0);
    return total / ratios.length;
  }, [visibleVaults, deriveRatio]);
  const latestVaultPrice = useMemo(() => {
    for (const vault of visibleVaults) {
      if (vault.lastPriceUsd != null) {
        return vault.lastPriceUsd;
      }
    }
    return preview?.price;
  }, [visibleVaults, preview?.price]);
  const atRiskCount = useMemo(
    () => visibleVaults.filter((vault) => vault.health === 'at_risk').length,
    [visibleVaults]
  );
  const withdrawReadyCount = useMemo(
    () => visibleVaults.filter((vault) => vault.withdrawable).length,
    [visibleVaults]
  );
  const confirmationRequirement = useMemo(() => {
    if (!visibleVaults.length) {
      return DEFAULT_CONFIRMATION_TARGET;
    }
    return visibleVaults.reduce(
      (max, vault) => Math.max(max, vault.minConfirmations ?? DEFAULT_CONFIRMATION_TARGET),
      0
    );
  }, [visibleVaults]);
  const totalLockedDisplay = formatBtc(totalLockedBtc);
  const avgCollateralDisplay =
    avgCollateralRatio != null
      ? `${formatNumber(avgCollateralRatio, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0
        })}%`
      : '--';
  const latestPriceDisplay =
    latestVaultPrice != null ? formatUsd(latestVaultPrice, 0) : '--';

  const finalizeSignedPsbt = useCallback(async (signedPsbt: string) => {
    if (!backendUrl) {
      throw new Error('Backend URL not available. Configure the canister backend first.');
    }
    if (!vaultMeta) {
      throw new Error('Missing vault metadata. Build another PSBT and try again.');
    }
    if (!preview) {
      throw new Error('Collateral preview unavailable. Refresh the page and try again.');
    }
    const base = backendUrl.trim().replace(/\/$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (BACKEND_API_KEY) {
      headers['x-api-key'] = BACKEND_API_KEY;
    }
    const vaultPayload = {
      vaultAddress: vaultMeta.vaultAddress,
      protocolPublicKey: vaultMeta.protocolPublicKey,
      protocolChainCode: vaultMeta.protocolChainCode,
      descriptor: vaultMeta.descriptor,
      collateralSats: vaultMeta.collateralSats,
      rune: vaultMeta.rune,
      feeRate: vaultMeta.feeRate,
      ordinalsAddress: vaultMeta.ordinalsAddress,
      paymentAddress: vaultMeta.paymentAddress,
      mintTokens: FIXED_MINT_TOKENS,
      mintUsdCents: FIXED_MINT_TOKENS * 100,
      btcPriceUsd: preview.price,
    };

    const response = await fetch(`${base}/mint/finalize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        wallet: paymentAddress,
        psbt: signedPsbt,
        vaultId: vaultMeta.vaultId,
        broadcast: true,
        vault: vaultPayload,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.message ?? payload?.error ?? 'Failed to finalize PSBT');
    }
    setInfoMessage(payload?.txid ? `Broadcasted TXID: ${payload.txid}` : 'PSBT finalized');
    if (paymentAccount) {
      await loadVaults(paymentAccount.address);
    }
  }, [backendUrl, paymentAddress, vaultMeta, paymentAccount, loadVaults, preview]);

  const handleSign = useCallback(async (psbtOverride?: string, inputOverride?: number) => {
    const psbtToSign = psbtOverride ?? psbtBase64;
    const inputsToSign = inputOverride ?? mintInputCount;
    if (!psbtToSign) {
      setError('Build a PSBT first.');
      return;
    }
    if (!paymentAccount) {
      setError('Connect Xverse first.');
      return;
    }
    setError(undefined);
    try {
      const signed = await signPsbtWithXverse(psbtToSign, {
        signInputs: {
          [paymentAccount.address]: Array.from({ length: inputsToSign }, (_, i) => i)
        },
        autoFinalize: false,
        broadcast: false
      });
      await finalizeSignedPsbt(signed);
    } catch (e) {
      console.error('[frontend] signing failed', e);
      setError((e as Error).message);
    }
  }, [psbtBase64, paymentAccount, mintInputCount, finalizeSignedPsbt]);

  const handleMintAndSign = useCallback(async () => {
    if (!paymentAccount) {
      setError('Connect Xverse first.');
      return;
    }
    setIsLoading(true);
    setError(undefined);
    setMintInputCount(0);
    setVaultMeta(null);
    setPsbtBase64(undefined);
    try {
      const built = await buildPsbt();
      setMintInputCount(built.inputCount);
      setPsbtBase64(built.psbt);
      await handleSign(built.psbt, built.inputCount);
    } catch (e) {
      console.error('[frontend] mint flow failed', e);
      setError((e as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [paymentAccount, buildPsbt, handleSign]);

  const handleSignWithdraw = useCallback(
    async (jobOverride?: { vaultId: string; psbt: string; inputCount: number }) => {
      if (!actor) {
        setWithdrawError('Prepare a withdraw PSBT first.');
        return;
      }
      const job = jobOverride ?? pendingWithdraw;
      if (!job) {
        setWithdrawError('Prepare a withdraw PSBT first.');
        return;
      }
      if (!paymentAccount || !ordinalsAccount) {
        setWithdrawError('Connect Xverse first to sign.');
        return;
      }
      setWithdrawError(undefined);
      setWithdrawInfo(undefined);
      setIsWithdrawLoading(true);
      try {
        const signInputs: Record<string, number[]> = {};
        signInputs[ordinalsAccount.address] = [0];
        const paymentIndex = job.inputCount > 1 ? 1 : 0;
        signInputs[paymentAccount.address] = [paymentIndex];

        const signed = await signPsbtWithXverse(job.psbt, {
          signInputs,
          autoFinalize: false,
          broadcast: false
        });

        const finalized = await actor.finalize_withdraw({
          vault_id: job.vaultId,
          signed_psbt: signed,
          broadcast: [true],
        });
        if ('Ok' in finalized) {
          const txid = finalized.Ok.txid?.[0];
          setWithdrawInfo(txid ? `Withdraw broadcast: ${txid}` : 'Withdraw finalized.');
          setPendingWithdraw(null);
          if (paymentAccount) {
            await loadVaults(paymentAccount.address);
          }
        } else {
          setWithdrawError(finalized.Err);
        }
      } catch (e) {
        setWithdrawError((e as Error).message);
      } finally {
        setIsWithdrawLoading(false);
      }
    },
    [actor, pendingWithdraw, ordinalsAccount, paymentAccount, loadVaults]
  );

  const handleWithdrawClick = useCallback(async (vault: UiVault) => {
    if (!actor) return;
    if (!paymentAccount || !ordinalsAccount) {
      setWithdrawError('Connect Xverse first to withdraw.');
      return;
    }
    if (!vault.mintTxId) {
      setWithdrawError('Vault transaction not yet broadcasted.');
      return;
    }
    if (!vault.withdrawable) {
      const remaining = Math.max(vault.minConfirmations - vault.confirmations, 0);
      setWithdrawError(
        `Vault ${vault.id} needs ${remaining} more confirmation${remaining === 1 ? '' : 's'} before withdrawing.`
      );
      return;
    }
    setWithdrawError(undefined);
    setWithdrawInfo(undefined);
    setIsWithdrawLoading(true);
    try {
      const response = await actor.prepare_withdraw(vault.id);
      if ('Ok' in response) {
        const result = response.Ok as WithdrawPrepareOk;
        const job = {
          vaultId: result.vault_id,
          psbt: result.psbt,
          inputCount: result.inputs.length
        };
        setPendingWithdraw(job);
        setWithdrawInfo('Withdraw PSBT ready. Signing with Xverse…');
        setActiveTab('withdraw');
        await handleSignWithdraw(job);
      } else {
        setWithdrawError(response.Err);
      }
    } catch (e) {
      setWithdrawError((e as Error).message);
    } finally {
      setIsWithdrawLoading(false);
    }
  }, [actor, ordinalsAccount, paymentAccount, handleSignWithdraw]);

  return (
    <div className="container">
      <header className="header">
        <div className="brand">
          <div className="logo" />
          <div>BTC Stablecoin</div>
        </div>
        <div className="statbar">
          <span className="pill">ICP • Bitcoin Integration</span>
          <span>Backend</span>
          <span className="muted">{backendHost}</span>
          <span className={health === 'ok' ? 'ok' : 'error'} style={{ padding: '4px 8px' }}>{health ?? 'loading'}</span>
        </div>
        <div className="wallet">
          {paymentAccount && <span className="muted mono">{truncate(paymentAccount.address, 6)}</span>}
          {!xverseConnection ? (
            <button className="btn btn-primary" onClick={handleConnectXverse}>Connect Xverse</button>
          ) : (
            <button className="btn btn-outline" onClick={handleDisconnectXverse}>Disconnect</button>
          )}
        </div>
      </header>

      <div className="banner">You are in Testnet4 mode</div>

      <div className="grid">
        <section className="card">
          <div className="card-header">
            <nav className="tabs">
              <button
                className={`tab ${activeTab === 'mint' ? 'active' : ''}`}
                onClick={() => setActiveTab('mint')}
              >
                Mint
              </button>
              <button
                className={`tab ${activeTab === 'withdraw' ? 'active' : ''}`}
                onClick={() => setActiveTab('withdraw')}
              >
                Withdraw
              </button>
            </nav>
          </div>
          {activeTab === 'mint' && (
          <div className="card-body">
            <div className="mint-panel">
              <div className="mint-panel-header">
                <div>
                  <div className="section-title" style={{ marginBottom: 4 }}>Mint Overview</div>
                  <div className="mint-panel-subtitle">{mintPanelSubtitle}</div>
                </div>
                <button
                  className="btn-icon"
                  onClick={refreshPreview}
                  disabled={!actor || isPreviewLoading}
                  title="Refresh preview"
                >
                  {isPreviewLoading ? '…' : '↺'}
                </button>
              </div>
              <div className="stat-cards">
                <div className="stat-card">
                  <div className="stat-label">Collateral Required</div>
                  <div className="stat-value">{collateralDisplayValue}</div>
                  <div className="stat-unit">BTC</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Tokens received per mint</div>
                  <div className="stat-value">{tokensDisplay}</div>
                  <div className="stat-unit">{RUNE_SYMBOL}</div>
                </div>
              </div>
              <div className="info-grid">
                <div className="info-row">
                  <span className="info-row-label">BTC Price</span>
                  <span className="info-row-value">
                    {priceDisplay}
                    <span className={priceDotClass} />
                  </span>
                </div>
                <div className="info-row">
                  <span className="info-row-label">Collateral Ratio</span>
                  <span className="info-row-value">{ratioDisplay}</span>
                </div>
                <div className="info-row">
                  <span className="info-row-label">Fee required to mint</span>
                  <span className="info-row-value">{feeDisplay}</span>
                </div>
                <div className="info-row">
                  <span className="info-row-label">Liquidation Price</span>
                  <span className="info-row-value">{liquidationDisplay}</span>
                </div>
              </div>
              <div className="alert-min">
                <span className="dot" />
                Min Balance required is {minBalanceDisplay}
              </div>
              <div className="mint-actions">
              <button
                className="btn btn-primary"
                disabled={isLoading || !paymentAccount}
                onClick={handleMintAndSign}
              >
                {isLoading ? 'Processing…' : mintedButtonLabel}
              </button>
              <a
                className="link-secondary"
                href="#"
                onClick={(e) => e.preventDefault()}
              >
                  Switch to Auction
                </a>
              </div>
            </div>

            <div className="divider" />
            <div className="section-title">Wallet Inputs</div>
            <div className="muted" style={{ marginBottom: 12 }}>Paste from Xverse or use your own keys.</div>
            <div className="field">
              <label className="label">Ordinals address</label>
              <input className="input mono" value={ordinalsAddress} onChange={(e) => setOrdinalsAddress(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Ordinals public key (x-only)</label>
              <input className="input mono" value={ordinalsPubKey} onChange={(e) => setOrdinalsPubKey(e.target.value)} />
            </div>
            <div className="row">
              <div className="field">
                <label className="label">Payment address</label>
                <input className="input mono" value={paymentAddress} onChange={(e) => setPaymentAddress(e.target.value)} />
              </div>
              <div className="field">
                <label className="label">Payment public key</label>
                <input className="input mono" value={paymentPubKey} onChange={(e) => setPaymentPubKey(e.target.value)} />
              </div>
            </div>

            {psbtBase64 && (
              <div style={{ marginTop: 14 }}>
                <div className="label" style={{ marginBottom: 6 }}>Latest PSBT (base64)</div>
                <pre className="codebox mono">{psbtBase64}</pre>
              </div>
            )}

            {vaultMeta && (
              <div style={{ marginTop: 14 }}>
                <div className="label" style={{ marginBottom: 6 }}>Vault allocation (taproot)</div>
                <div className="mono muted" style={{ wordBreak: 'break-all' }}>Vault ID: {vaultMeta.vaultId}</div>
                <div className="mono muted" style={{ wordBreak: 'break-all' }}>Vault address: {vaultMeta.vaultAddress}</div>
                <div className="mono muted" style={{ wordBreak: 'break-all' }}>Protocol key: {vaultMeta.protocolPublicKey}</div>
                <div className="mono muted" style={{ wordBreak: 'break-all' }}>Chain code: {vaultMeta.protocolChainCode}</div>
              </div>
            )}

            {infoMessage && (
              <div className="info" style={{ marginTop: 14 }}>{infoMessage}</div>
            )}

            {error && (
              <div className="error" style={{ marginTop: 14 }}>Error: {error}</div>
            )}
          </div>
          )}

          {activeTab === 'withdraw' && (
            <div className="card-body">
              <div className="withdraw-panel">
                <div className="withdraw-headline">
                  <div>
                    <div className="section-title" style={{ marginBottom: 4 }}>Vault Health</div>
                    <div className="muted">
                      Monitor collateral, confirmations, and health before unbinding BTC.
                    </div>
                  </div>
                  <div className="pill neon">
                    Requires {confirmationRequirement || DEFAULT_CONFIRMATION_TARGET}+ confirmations
                  </div>
                  {hiddenWithdrawnCount > 0 && (
                    <button
                      className="btn-pill"
                      onClick={() => setShowWithdrawnVaults((prev) => !prev)}
                    >
                      {showWithdrawnVaults
                        ? 'Hide older vaults'
                        : `Show older vaults (${hiddenWithdrawnCount})`}
                    </button>
                  )}
                </div>
                <div className="vault-stat-grid">
                  <div className="stat-card compact">
                    <div className="stat-label">Total locked</div>
                    <div className="stat-value">{totalLockedDisplay}</div>
                    <div className="stat-unit">BTC</div>
                  </div>
                  <div className="stat-card compact">
                    <div className="stat-label">Avg collateral ratio</div>
                    <div className="stat-value">{avgCollateralDisplay}</div>
                    <div className="stat-unit">target ≥ {TARGET_COLLATERAL_RATIO}%</div>
                  </div>
                  <div className="stat-card compact">
                    <div className="stat-label">Vaults ready</div>
                    <div className="stat-value">{withdrawReadyCount}</div>
                    <div className="stat-unit">of {visibleVaults.length}</div>
                  </div>
                  <div className="stat-card compact">
                    <div className="stat-label">Live BTC price</div>
                    <div className="stat-value">{latestPriceDisplay}</div>
                    <div className="stat-unit">
                      {atRiskCount > 0 ? `${atRiskCount} at risk` : 'all healthy'}
                    </div>
                  </div>
                </div>
              </div>
              {isVaultsLoading && <div className="muted">Loading vaults…</div>}
              {!isVaultsLoading && visibleVaults.length === 0 && (
                <div className="muted">
                  {hiddenWithdrawnCount > 0
                    ? 'All active vaults are already withdrawn. Show older vaults to review history.'
                    : 'No vaults yet. Mint to create your first one.'}
                </div>
              )}
              {!isVaultsLoading && visibleVaults.length > 0 && (
                <div className="vault-grid">
                  {visibleVaults.map((vault, index) => {
                    const mintedTokensLabel = `${FIXED_MINT_TOKENS} ${RUNE_SYMBOL}`;
                    const mintedUsdLabel = formatUsd(FIXED_MINT_TOKENS, 0);
                    const collateralDisplayVault = formatBtc(vault.lockedCollateralBtc);
                    const priceForVault = vault.lastPriceUsd ?? preview?.price;
                    const collateralUsdDisplay =
                      priceForVault != null
                        ? formatUsd(vault.lockedCollateralBtc * priceForVault, 0)
                        : '--';
                    const statusClass = `status-pill ${vault.health}`;
                    const statusLabel =
                      vault.health === 'at_risk'
                        ? 'At Risk'
                        : vault.health === 'confirmed'
                          ? 'Confirmed'
                          : 'Pending';
                    const confirmationsLabel = `${vault.confirmations}/${vault.minConfirmations}`;
                    const derivedRatio = deriveRatio(vault);
                    const ratioDisplayVault =
                      derivedRatio != null
                        ? `${formatNumber(derivedRatio, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 0
                          })}%`
                        : '--';
                    const remainingConf = Math.max(
                      vault.minConfirmations - vault.confirmations,
                      0
                    );
                    const confirmationPct =
                      vault.minConfirmations > 0
                        ? Math.min(vault.confirmations / vault.minConfirmations, 1)
                        : 0;
                    const isPendingSelection =
                      pendingWithdraw && pendingWithdraw.vaultId === vault.id;
                    const withdrawDisabled =
                      Boolean(vault.withdrawTxId) ||
                      isWithdrawLoading ||
                      (pendingWithdraw !== null && !isPendingSelection) ||
                      !vault.withdrawable;
                    const mintedTimestamp = new Date(vault.createdAtMs).toLocaleString();
                    return (
                      <div key={`${vault.id}-${vault.createdAtMs}`} className="vault-card">
                        <div className="vault-card-header">
                          <div>
                            <div className="vault-title">USDBZ Vault • {index + 1}</div>
                            <div className="vault-subtitle">{mintedTimestamp}</div>
                          </div>
                          <div className={statusClass}>{statusLabel}</div>
                        </div>
                        <div className="vault-metrics">
                          <div className="vault-metric">
                            <div className="vault-metric-label">Minted</div>
                            <div className="vault-metric-value">
                              {mintedTokensLabel} {RUNE_SYMBOL}
                            </div>
                            <div className="vault-metric-sub">{mintedUsdLabel}</div>
                          </div>
                          <div className="vault-metric">
                            <div className="vault-metric-label">Locked collateral</div>
                            <div className="vault-metric-value">{collateralDisplayVault}</div>
                            <div className="vault-metric-sub">{collateralUsdDisplay}</div>
                          </div>
                          <div className="vault-metric">
                            <div className="vault-metric-label">Collateral ratio</div>
                            <div className="vault-metric-value">{ratioDisplayVault}</div>
                            <div className="vault-metric-sub">Target ≥ {TARGET_COLLATERAL_RATIO}%</div>
                          </div>
                          <div className="vault-metric">
                            <div className="vault-metric-label">Confirmations</div>
                            <div className="vault-metric-value">{confirmationsLabel}</div>
                            <div className="vault-metric-sub">
                              {vault.withdrawable
                                ? 'Ready to withdraw'
                                : `${remainingConf} block${
                                    remainingConf === 1 ? '' : 's'
                                  } remaining`}
                            </div>
                          </div>
                        </div>
                        <div className="confirmation-bar">
                          <div
                            className="confirmation-bar-progress"
                            style={{ width: `${confirmationPct * 100}%` }}
                          />
                        </div>
                        <div className="vault-links">
                          <div className="vault-tx-row">
                            <span className="label">Mint TX</span>
                            {vault.mintTxId ? (
                              <a
                                href={`${MEMPOOL_BASE_URL}${vault.mintTxId}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {truncate(vault.mintTxId, 10)}
                              </a>
                            ) : (
                              <span className="muted">pending broadcast</span>
                            )}
                          </div>
                          <div className="vault-tx-row">
                            <span className="label">Withdraw TX</span>
                            {vault.withdrawTxId ? (
                              <a
                                href={`${MEMPOOL_BASE_URL}${vault.withdrawTxId}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {truncate(vault.withdrawTxId, 10)}
                              </a>
                            ) : (
                              <span className="muted">not started</span>
                            )}
                          </div>
                        </div>
                        <div className="vault-actions">
                          <button
                            className="btn btn-primary"
                            onClick={() => handleWithdrawClick(vault)}
                            disabled={withdrawDisabled}
                          >
                            {vault.withdrawTxId
                              ? 'Withdrawn'
                              : isPendingSelection
                                ? 'Awaiting signature'
                                : vault.withdrawable
                                  ? 'Withdraw'
                                  : 'Waiting confirmations'}
                          </button>
                          <div className="vault-meta">
                            <div>Vault: {truncate(vault.vaultAddress, 8)}</div>
                            <div>Protocol key: {truncate(vault.protocolPublicKey, 8)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {pendingWithdraw && (
                <div className="vault-card" style={{ marginTop: 16 }}>
                  <div className="vault-card-header">
                    <strong>Pending withdraw</strong>
                    <span>Vault #{pendingWithdraw.vaultId}</span>
                  </div>
                  <div className="muted" style={{ marginBottom: 8 }}>
                    PSBT prepared. Sign with Xverse to finalize.
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={handleSignWithdraw}
                    disabled={isWithdrawLoading}
                  >
                    {isWithdrawLoading ? 'Finalizing…' : 'Sign & Finalize'}
                  </button>
                  <div style={{ marginTop: 10 }}>
                    <div className="label" style={{ marginBottom: 6 }}>Withdraw PSBT (base64)</div>
                    <pre className="codebox mono">{pendingWithdraw.psbt}</pre>
                  </div>
                </div>
              )}
              {withdrawInfo && (
                <div className="info" style={{ marginTop: 14 }}>{withdrawInfo}</div>
              )}
              {withdrawError && (
                <div className="error" style={{ marginTop: 14 }}>{withdrawError}</div>
              )}
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
