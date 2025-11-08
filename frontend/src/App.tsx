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
    };
  };
}
type BuildPsbtResult = BuildPsbtOk | { Err: string };

interface VaultMeta {
  vaultId: string;
  protocolPublicKey: string;
  protocolChainCode: string;
  vaultAddress: string;
}

const DEFAULT_ORDINALS_ADDRESS =
  'tb1peexgh8rs0gnndfcq2z5atf4pqg3sv6zkd3f0h53hgcp78hwd0cqsuaz2w6';
const DEFAULT_ORDINALS_PUBKEY =
  'aa915ec4a01945574f6b7e914274926cbfd4680908eb5e42d5d15b01a3dd4547';
const DEFAULT_PAYMENT_ADDRESS = 'tb1qnk9h7jygqjvd2sa20dskvl3vzl6r9hl5lm3ytd';
const DEFAULT_PAYMENT_PUBKEY =
  '0273c48193af1d474ed2d332c1e75292b19deafce27963f0139998b9a8c1ebf15c';
const DEFAULT_FEE_RECIPIENT = 'tb1pkde3l5fzut4n5h9m2jqfzwtn7q3j0eywl98h0rvg5swlvpra5wnqul27y2';

function truncate(addr?: string, size = 4) {
  if (!addr) return '';
  if (addr.length <= size * 2 + 1) return addr;
  return `${addr.slice(0, size)}…${addr.slice(-size)}`;
}

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

  const [ordinalsAddress, setOrdinalsAddress] = useState(DEFAULT_ORDINALS_ADDRESS);
  const [ordinalsPubKey, setOrdinalsPubKey] = useState(DEFAULT_ORDINALS_PUBKEY);
  const [paymentAddress, setPaymentAddress] = useState(DEFAULT_PAYMENT_ADDRESS);
  const [paymentPubKey, setPaymentPubKey] = useState(DEFAULT_PAYMENT_PUBKEY);

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

  const buildPsbt = useCallback(async () => {
    if (!actor) {
      throw new Error('Canister actor not ready');
    }

    const response = (await actor.build_psbt({
      rune: 'FOOLBYTHEDAY',
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
      vaultAddress: result.vault_address
    });
    const psbt = result.patched_psbt;
    setPsbtBase64(psbt);
    setMintInputCount(result.inputs.length);
    console.info('[frontend] received psbt', result);
    return psbt;
  }, [actor, ordinalsAddress, ordinalsPubKey, paymentAddress, paymentPubKey]);

  const handleBuildPsbt = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    setMintInputCount(0);
    setVaultMeta(null);
    setPsbtBase64(undefined);
    try {
      await buildPsbt();
    } catch (e) {
      console.error('[frontend] build psbt failed', e);
      setError((e as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, [buildPsbt]);

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

  const canSign = useMemo(
    () => Boolean(psbtBase64 && paymentAccount && mintInputCount > 0),
    [psbtBase64, paymentAccount, mintInputCount]
  );

  const handleSign = useCallback(async () => {
    if (!psbtBase64) {
      setError('Build a PSBT first.');
      return;
    }
    if (!paymentAccount) {
      setError('Connect Xverse first.');
      return;
    }
    setError(undefined);
    try {
      const signed = await signPsbtWithXverse(psbtBase64, {
        signInputs: {
          [paymentAccount.address]: Array.from({ length: mintInputCount }, (_, i) => i)
        },
        autoFinalize: false,
        broadcast: false
      });
      console.log('[frontend] signed psbt', signed);
      alert('Signed PSBT logged to console');
    } catch (e) {
      console.error('[frontend] signing failed', e);
      setError((e as Error).message);
    }
  }, [psbtBase64, paymentAccount, mintInputCount]);

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
          <span className="muted">{backendUrl ? new URL(backendUrl).host : 'not set'}</span>
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
              <div className="tab active">Mint</div>
              <div className="tab">Withdraw</div>
            </nav>
          </div>
          <div className="card-body">
            <div className="section-title">Mint Inputs</div>
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

            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn btn-primary" disabled={isLoading} onClick={handleBuildPsbt}>
                {isLoading ? 'Building…' : 'Build PSBT'}
              </button>
              <button className="btn btn-outline" disabled={!canSign} onClick={handleSign}>
                Sign with Xverse
              </button>
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

            {error && (
              <div className="error" style={{ marginTop: 14 }}>Error: {error}</div>
            )}
          </div>
        </section>

        <aside className="card">
          <div className="card-header">
            <div className="section-title">Notes</div>
          </div>
          <div className="card-body">
            <ul className="muted" style={{ lineHeight: 1.6 }}>
              <li>Connect Xverse on Testnet4, then mint a PSBT.</li>
              <li>We include a deterministic runestone patch for mint transactions.</li>
              <li>Signing remains in-wallet; we only display the signed PSBT locally.</li>
            </ul>
          </div>
        </aside>
      </div>
    </div>
  );
}
