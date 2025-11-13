use candid::{CandidType, Func, Nat, Principal};
use ic_cdk::api::call::RejectionCode;
use ic_cdk::api::management_canister::http_request::{
    http_request, CanisterHttpRequestArgument, HttpHeader, HttpMethod, HttpResponse, TransformArgs,
    TransformContext, TransformFunc,
};
use ic_cdk::api::time;
use ic_cdk::caller;
use ic_cdk::storage::{stable_restore, stable_save};
use ic_cdk_macros::{init, post_upgrade, pre_upgrade, query, update};
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::cell::RefCell;
use std::fmt::Write as FmtWrite;
// Using explicit Candid-compatible types (avoid depending on ic-cdk internal aliases)

const HTTP_CYCLES_COST: u128 = 2_000_000_000_000; // 2T cycles (~0.2T min) per request baseline
const BACKEND_HTTP_MAX_RETRIES: u8 = 2;
const XRC_DEFAULT_CYCLES_BUDGET: u128 = 1_000_000_000_000; // start generous; trim after measuring
const COLLATERAL_FALLBACK_PRICE_USD: f64 = 100_734.10; // Local dev fallback BTC/USD price
const SCHNORR_PUBLIC_KEY_CYCLES: u128 = 5_000_000_000; // empirical local budget; adjust after benchmarking
const SCHNORR_KEY_ALGORITHM: &str = "bip340secp256k1";
// Local replica exposes keys named `dfx_test_key` for ECDSA/Schnorr.
// Use this for local dev; swap to `key_1` (or production name) when moving to mainnet.
const SCHNORR_KEY_NAME: &str = "dfx_test_key";
const PROTOCOL_DOMAIN_LABEL: &[u8] = b"usdb";
const PROTOCOL_ROLE_LABEL: &[u8] = b"proto";

#[derive(Clone, Default, CandidType, Deserialize, Serialize)]
struct BackendConfig {
    base_url: String,
    api_key: Option<String>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct CollateralParams {
    /// ratio in basis points (e.g., 13_000 = 130%)
    ratio_bps: u16,
    /// mint amount in USD cents (e.g., 2_000 = $20)
    usd_cents: u32,
}

impl Default for CollateralParams {
    fn default() -> Self {
        Self {
            ratio_bps: 13_000,
            usd_cents: 2_000,
        }
    }
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct Settings {
    backend: BackendConfig,
    /// Optional XRC canister id. When None, price querying is disabled.
    xrc_canister_id: Option<Principal>,
    /// Cycles budget to attach to each XRC call
    xrc_cycles_budget: u128,
    collateral: CollateralParams,
    next_vault_id: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            backend: BackendConfig::default(),
            xrc_canister_id: None,
            xrc_cycles_budget: XRC_DEFAULT_CYCLES_BUDGET,
            collateral: CollateralParams::default(),
            next_vault_id: 1,
        }
    }
}

thread_local! {
    static SETTINGS: RefCell<Settings> = RefCell::new(Settings::default());
}

#[init]
fn init() {
    ic_cdk::println!("stablecoin canister initialized at {}", time());
}

#[pre_upgrade]
fn pre_upgrade() {
    let cfg = SETTINGS.with(|s| s.borrow().clone());
    stable_save((cfg,)).expect("failed to save settings");
}

#[post_upgrade]
fn post_upgrade() {
    // Try restore new layout first; fall back to legacy BackendConfig-only
    if let Ok((cfg,)) = stable_restore::<(Settings,)>() {
        SETTINGS.with(|s| *s.borrow_mut() = cfg);
        return;
    }
    if let Ok((legacy_backend,)) = stable_restore::<(BackendConfig,)>() {
        SETTINGS.with(|s| {
            let mut tmp = Settings::default();
            tmp.backend = legacy_backend;
            *s.borrow_mut() = tmp;
        });
    }
}

#[query(name = "version")]
fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[query(name = "health")]
fn health() -> String {
    "ok".to_string()
}

#[update(name = "ping")]
fn ping() -> String {
    format!("pong from {:?}", caller())
}

#[query]
fn get_backend_config() -> BackendConfig {
    SETTINGS.with(|settings| settings.borrow().backend.clone())
}

#[update]
fn set_backend_config(base_url: String, api_key: Option<String>) {
    if !base_url.starts_with("https://") {
        ic_cdk::trap("backend base URL must start with https://");
    }

    SETTINGS.with(|settings| {
        let mut st = settings.borrow_mut();
        st.backend.base_url = base_url;
        st.backend.api_key = api_key;
    });
}

// ===== XRC bindings (minimal) =====

#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
enum XrcAssetClass {
    Cryptocurrency,
    FiatCurrency,
}

#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
struct XrcAsset {
    symbol: String,
    class: XrcAssetClass,
}

#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
struct XrcGetExchangeRateRequest {
    base_asset: XrcAsset,
    quote_asset: XrcAsset,
    timestamp: Option<u64>,
}

#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
struct XrcExchangeRateMetadata {
    decimals: u32,
    base_asset_num_received_rates: u64,
    base_asset_num_queried_sources: u64,
    quote_asset_num_received_rates: u64,
    quote_asset_num_queried_sources: u64,
    standard_deviation: u64,
    forex_timestamp: Option<u64>,
}

#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
struct XrcExchangeRate {
    base_asset: XrcAsset,
    quote_asset: XrcAsset,
    timestamp: u64,
    rate: u64,
    metadata: XrcExchangeRateMetadata,
}

#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
enum XrcExchangeRateError {
    AnonymousPrincipalNotAllowed,
    Pending,
    CryptoBaseAssetNotFound,
    CryptoQuoteAssetNotFound,
    StablecoinRateNotFound,
    StablecoinRateTooFewRates,
    StablecoinRateZeroRate,
    ForexInvalidTimestamp,
    ForexBaseAssetNotFound,
    ForexQuoteAssetNotFound,
    ForexAssetsNotFound,
    RateLimited,
    NotEnoughCycles,
    FailedToAcceptCycles,
    InconsistentRatesReceived,
    Other { code: u32, description: String },
}

#[derive(Clone, Debug, CandidType, Deserialize, Serialize)]
enum XrcGetExchangeRateResult {
    Ok(XrcExchangeRate),
    Err(XrcExchangeRateError),
}

async fn xrc_btc_usd_price() -> Result<f64, String> {
    let (xrc_id, budget) = SETTINGS.with(|s| {
        let st = s.borrow();
        (st.xrc_canister_id, st.xrc_cycles_budget)
    });
    let xrc_id = xrc_id.ok_or_else(|| "xrc_not_configured".to_string())?;
    let req = XrcGetExchangeRateRequest {
        base_asset: XrcAsset {
            symbol: "BTC".into(),
            class: XrcAssetClass::Cryptocurrency,
        },
        quote_asset: XrcAsset {
            symbol: "USD".into(),
            class: XrcAssetClass::FiatCurrency,
        },
        timestamp: None,
    };
    let (result,): (XrcGetExchangeRateResult,) =
        ic_cdk::api::call::call_with_payment128(xrc_id, "get_exchange_rate", (req,), budget)
            .await
            .map_err(|(code, msg)| format!("xrc_call_error {:?}: {}", code, msg))?;

    match result {
        XrcGetExchangeRateResult::Ok(rate) => {
            let price = (rate.rate as f64) / 10f64.powi(rate.metadata.decimals as i32);
            if price <= 0.0 {
                return Err("price_unavailable".into());
            }
            Ok(price)
        }
        XrcGetExchangeRateResult::Err(err) => Err(format!("xrc_returned_error: {:?}", err)),
    }
}

#[update]
fn set_xrc_config(xrc_id: Principal) {
    SETTINGS.with(|s| s.borrow_mut().xrc_canister_id = Some(xrc_id));
}

#[update]
fn set_collateral_params(ratio_bps: u16, usd_cents: u32) {
    SETTINGS.with(|s| {
        let mut st = s.borrow_mut();
        st.collateral.ratio_bps = ratio_bps;
        st.collateral.usd_cents = usd_cents;
    });
}

#[derive(CandidType, Deserialize, Serialize)]
struct CollateralPreview {
    price: f64,
    sats: u64,
    ratio_bps: u16,
    usd_cents: u32,
}

#[update]
async fn get_collateral_preview() -> Result<CollateralPreview, String> {
    let price = xrc_btc_usd_price().await?;
    let (ratio_bps, usd_cents) = SETTINGS.with(|s| {
        let st = s.borrow();
        (st.collateral.ratio_bps, st.collateral.usd_cents)
    });
    let sats = compute_target_collateral_sats(price, ratio_bps, usd_cents);
    Ok(CollateralPreview {
        price,
        sats,
        ratio_bps,
        usd_cents,
    })
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct AddressBinding {
    address: String,
    address_type: String,
    public_key: String,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct AmountOverrides {
    ordinals_sats: Option<u64>,
    fee_recipient_sats: Option<u64>,
    vault_sats: Option<u64>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
enum SignatureAlgorithm {
    #[serde(rename = "ed25519")]
    Ed25519,
    #[serde(rename = "bip340secp256k1")]
    Bip340Secp256k1,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct SchnorrKeyId {
    name: String,
    algorithm: SignatureAlgorithm,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct SchnorrPublicKeyRequest {
    key_id: SchnorrKeyId,
    derivation_path: Vec<Vec<u8>>,
    canister_id: Option<Principal>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct SchnorrPublicKeyResponse {
    public_key: Vec<u8>,
    chain_code: Vec<u8>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
enum SignWithSchnorrAux {
    #[serde(rename = "bip341")]
    Bip341(SignWithBip341Aux),
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct SignWithBip341Aux {
    merkle_root_hash: ByteBuf,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct SignWithSchnorrArgument {
    message: ByteBuf,
    derivation_path: Vec<Vec<u8>>,
    key_id: SchnorrKeyId,
    aux: Option<SignWithSchnorrAux>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct SignWithSchnorrResponse {
    signature: Vec<u8>,
}

#[derive(Clone)]
struct DerivedProtocolKey {
    vault_id: u64,
    public_key_hex: String,
    chain_code_hex: String,
}

fn next_vault_id() -> u64 {
    SETTINGS.with(|s| {
        let mut st = s.borrow_mut();
        let now = ic_cdk::api::time().max(1);
        if now > st.next_vault_id {
            st.next_vault_id = now;
        }
        let id = st.next_vault_id;
        st.next_vault_id = st.next_vault_id.wrapping_add(1).max(1);
        id
    })
}

fn protocol_derivation_path(vault_id: u64) -> Vec<Vec<u8>> {
    vec![
        PROTOCOL_DOMAIN_LABEL.to_vec(),
        PROTOCOL_ROLE_LABEL.to_vec(),
        vault_id.to_be_bytes().to_vec(),
    ]
}

fn schnorr_key_id() -> SchnorrKeyId {
    SchnorrKeyId {
        name: SCHNORR_KEY_NAME.to_string(),
        algorithm: SignatureAlgorithm::Bip340Secp256k1,
    }
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = FmtWrite::write_fmt(&mut out, format_args!("{:02x}", byte));
    }
    out
}

fn from_hex(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("hex_string_length_must_be_even".into());
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    for idx in (0..bytes.len()).step_by(2) {
        let hi = (bytes[idx] as char)
            .to_digit(16)
            .ok_or("invalid_hex_character")?;
        let lo = (bytes[idx + 1] as char)
            .to_digit(16)
            .ok_or("invalid_hex_character")?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

fn to_array_32(bytes: &[u8]) -> Result<[u8; 32], String> {
    bytes
        .try_into()
        .map_err(|_| "expected_32_byte_value".into())
}

fn to_array_64(bytes: &[u8]) -> Result<[u8; 64], String> {
    bytes
        .try_into()
        .map_err(|_| "expected_64_byte_value".into())
}

async fn derive_protocol_key(vault_id: u64) -> Result<DerivedProtocolKey, String> {
    let derivation_path = protocol_derivation_path(vault_id);
    ic_cdk::println!(
        "[tsig] deriving protocol key -> vault_id={}, path_len={}",
        vault_id,
        derivation_path.len()
    );
    let arg = SchnorrPublicKeyRequest {
        derivation_path,
        key_id: schnorr_key_id(),
        canister_id: None,
    };
    let (response,): (SchnorrPublicKeyResponse,) = ic_cdk::api::call::call_with_payment128(
        Principal::management_canister(),
        "schnorr_public_key",
        (arg,),
        SCHNORR_PUBLIC_KEY_CYCLES,
    )
    .await
    .map_err(|(code, msg)| format!("schnorr_public_key error {:?}: {}", code, msg))?;
    let mut pubkey = response.public_key.clone();
    // Accept either x-only 32B (expected) or compressed 33B and convert to x-only.
    if pubkey.len() == 33 && (pubkey[0] == 0x02 || pubkey[0] == 0x03) {
        ic_cdk::println!("[tsig] schnorr_public_key returned 33B compressed; converting to x-only");
        pubkey = pubkey[1..].to_vec();
    }
    if pubkey.len() != 32 {
        ic_cdk::println!(
            "[tsig] invalid pubkey length: {} (hex={})",
            pubkey.len(),
            to_hex(&pubkey)
        );
        return Err("invalid_protocol_pubkey_length".into());
    }
    let public_key_hex = to_hex(&pubkey);
    let chain_code_hex = to_hex(&response.chain_code);
    ic_cdk::println!(
        "[tsig] derived protocol key ok -> vault_id={}, pub={}",
        vault_id,
        public_key_hex
    );
    Ok(DerivedProtocolKey {
        vault_id,
        public_key_hex,
        chain_code_hex,
    })
}

fn compute_target_collateral_sats(price: f64, ratio_bps: u16, usd_cents: u32) -> u64 {
    let usd = (usd_cents as f64) / 100.0;
    let ratio = (ratio_bps as f64) / 10_000.0;
    ((usd * ratio / price) * 100_000_000f64).ceil() as u64
}

fn should_retry_backend(code: &RejectionCode, msg: &str) -> bool {
    matches!(code, RejectionCode::SysFatal | RejectionCode::SysTransient)
        || msg.to_ascii_lowercase().contains("timeout")
}

async fn backend_http_request(
    url: String,
    method: HttpMethod,
    body: Option<Vec<u8>>,
    headers: Vec<HttpHeader>,
) -> Result<HttpResponse, String> {
    let mut attempt: u8 = 0;
    loop {
        let body_clone = body.as_ref().map(|b| b.clone());
        let args = CanisterHttpRequestArgument {
            url: url.clone(),
            method: method.clone(),
            body: body_clone,
            max_response_bytes: Some(2_000_000),
            headers: headers.clone(),
            transform: Some(TransformContext {
                function: TransformFunc(Func {
                    principal: ic_cdk::id(),
                    method: "transform_http_response".into(),
                }),
                context: vec![],
            }),
        };

        match http_request(args, HTTP_CYCLES_COST).await {
            Ok((resp,)) => return Ok(resp),
            Err((code, msg)) => {
                if attempt >= BACKEND_HTTP_MAX_RETRIES || !should_retry_backend(&code, &msg) {
                    return Err(format!("http_request error {:?}: {}", code, msg));
                }
                attempt += 1;
                ic_cdk::println!(
                    "[backend_http_request] retry {}/{} after error {:?}: {}",
                    attempt,
                    BACKEND_HTTP_MAX_RETRIES,
                    code,
                    msg
                );
                continue;
            }
        }
    }
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct BuildPsbtRequest {
    rune: String,
    fee_rate: f64,
    fee_recipient: String,
    ordinals: AddressBinding,
    payment: AddressBinding,
    amounts: Option<AmountOverrides>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendInputRef {
    txid: String,
    vout: u32,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct InputRef {
    txid: String,
    vout: u32,
}

impl From<BackendInputRef> for InputRef {
    fn from(value: BackendInputRef) -> Self {
        Self {
            txid: value.txid,
            vout: value.vout,
        }
    }
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendChangeOutput {
    address: String,
    amount_btc: Option<String>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct ChangeOutput {
    address: String,
    amount_btc: String,
}

impl From<BackendChangeOutput> for ChangeOutput {
    fn from(value: BackendChangeOutput) -> Self {
        Self {
            address: value.address,
            amount_btc: value.amount_btc.unwrap_or_else(|| "0".to_string()),
        }
    }
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendMintResult {
    wallet: String,
    vault_address: String,
    vault_id: String,
    protocol_public_key: String,
    protocol_chain_code: String,
    descriptor: String,
    original_psbt: String,
    patched_psbt: String,
    raw_transaction_hex: String,
    inputs: Vec<InputRef>,
    change_output: Option<BackendChangeOutput>,
    collateral_sats: u64,
    rune: String,
    fee_rate: f64,
    ordinals_address: String,
    payment_address: String,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendVaultMetadata {
    rune: String,
    fee_rate: f64,
    ordinals_address: String,
    payment_address: String,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendVaultRecord {
    vault_id: String,
    protocol_public_key: String,
    protocol_chain_code: String,
    vault_address: String,
    descriptor: String,
    collateral_sats: u64,
    created_at: u64,
    metadata: BackendVaultMetadata,
    txid: Option<String>,
    withdraw_tx_id: Option<String>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendVaultListResponse {
    payment_address: String,
    vaults: Vec<BackendVaultRecord>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendWithdrawInput {
    txid: String,
    vout: u32,
    value: f64,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendWithdrawPreparePayload {
    psbt: String,
    burn_metadata: String,
    inputs: Vec<BackendWithdrawInput>,
    vault_id: String,
    ordinals_address: String,
    payment_address: String,
    vault_address: String,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendWithdrawSignatureRequired {
    status: String,
    vault_id: String,
    tapleaf_hash: String,
    control_block: String,
    sighash: String,
    merkle_root: String,
    leaf_script: String,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendWithdrawFinalizeSuccess {
    status: String,
    vault_id: String,
    psbt: String,
    hex: String,
    txid: Option<String>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct VaultSummary {
    vault_id: String,
    vault_address: String,
    collateral_sats: u64,
    protocol_public_key: String,
    created_at: u64,
    rune: String,
    fee_rate: f64,
    ordinals_address: String,
    payment_address: String,
    txid: Option<String>,
    withdraw_txid: Option<String>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct WithdrawInput {
    txid: String,
    vout: u32,
    value: f64,
}

impl From<BackendWithdrawInput> for WithdrawInput {
    fn from(value: BackendWithdrawInput) -> Self {
        Self {
            txid: value.txid,
            vout: value.vout,
            value: value.value,
        }
    }
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct WithdrawPrepareResponse {
    vault_id: String,
    psbt: String,
    burn_metadata: String,
    inputs: Vec<WithdrawInput>,
    ordinals_address: String,
    payment_address: String,
    vault_address: String,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct WithdrawFinalizeRequest {
    vault_id: String,
    signed_psbt: String,
    broadcast: Option<bool>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct WithdrawFinalizeResponse {
    vault_id: String,
    txid: Option<String>,
    hex: String,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendMintResponse {
    rune: String,
    fee_rate: f64,
    result: BackendMintResult,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendAddressBinding {
    address: String,
    address_type: String,
    public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendAmountOverrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    ordinals_sats: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fee_recipient_sats: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vault_sats: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendBuildPsbtRequest {
    rune: String,
    fee_rate: f64,
    fee_recipient: String,
    ordinals: BackendAddressBinding,
    payment: BackendAddressBinding,
    amounts: Option<BackendAmountOverrides>,
    vault_id: String,
    protocol_public_key: String,
    protocol_chain_code: String,
}

impl From<AddressBinding> for BackendAddressBinding {
    fn from(value: AddressBinding) -> Self {
        Self {
            address: value.address,
            address_type: value.address_type,
            public_key: value.public_key,
        }
    }
}

impl From<AmountOverrides> for BackendAmountOverrides {
    fn from(value: AmountOverrides) -> Self {
        Self {
            ordinals_sats: value.ordinals_sats,
            fee_recipient_sats: value.fee_recipient_sats,
            vault_sats: value.vault_sats,
        }
    }
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct MintResult {
    wallet: String,
    vault_address: String,
    vault_id: String,
    protocol_public_key: String,
    protocol_chain_code: String,
    descriptor: String,
    original_psbt: String,
    patched_psbt: String,
    raw_transaction_hex: String,
    inputs: Vec<InputRef>,
    change_output: Option<ChangeOutput>,
    collateral_sats: u64,
    rune: String,
    fee_rate: f64,
    ordinals_address: String,
    payment_address: String,
}

impl From<BackendMintResult> for MintResult {
    fn from(value: BackendMintResult) -> Self {
        Self {
            wallet: value.wallet,
            vault_address: value.vault_address,
            vault_id: value.vault_id,
            protocol_public_key: value.protocol_public_key,
            protocol_chain_code: value.protocol_chain_code,
            descriptor: value.descriptor,
            original_psbt: value.original_psbt,
            patched_psbt: value.patched_psbt,
            raw_transaction_hex: value.raw_transaction_hex,
            inputs: value.inputs.into_iter().map(InputRef::from).collect(),
            change_output: value.change_output.map(ChangeOutput::from),
            collateral_sats: value.collateral_sats,
            rune: value.rune,
            fee_rate: value.fee_rate,
            ordinals_address: value.ordinals_address,
            payment_address: value.payment_address,
        }
    }
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct MintResponse {
    rune: String,
    fee_rate: f64,
    result: MintResult,
}

impl From<BackendMintResponse> for MintResponse {
    fn from(resp: BackendMintResponse) -> Self {
        MintResponse {
            rune: resp.rune,
            fee_rate: resp.fee_rate,
            result: MintResult::from(resp.result),
        }
    }
}

#[update]
async fn build_psbt(request: BuildPsbtRequest) -> Result<MintResponse, String> {
    let settings = SETTINGS.with(|s| s.borrow().clone());
    let config = settings.backend.clone();
    if config.base_url.is_empty() {
        return Err("backend_not_configured".into());
    }

    ic_cdk::println!(
        "[build_psbt] preparing request -> base_url: {}, rune: {}, fee_rate: {}",
        config.base_url,
        request.rune,
        request.fee_rate
    );

    // Compute dynamic collateral from XRC
    let dynamic_vault_sats = match xrc_btc_usd_price().await {
        Ok(price) => {
            let sats = compute_target_collateral_sats(
                price,
                settings.collateral.ratio_bps,
                settings.collateral.usd_cents,
            );
            ic_cdk::println!(
                "[build_psbt] xrc collateral -> price={}, sats={}",
                price,
                sats
            );
            Some(sats)
        }
        Err(e) => {
            ic_cdk::println!(
                "[build_psbt] xrc price unavailable, trying fallbacks: {}",
                e
            );
            None
        }
    };

    // Merge amounts override
    let mut backend_amounts: Option<BackendAmountOverrides> =
        request.amounts.clone().map(|a| BackendAmountOverrides {
            ordinals_sats: a.ordinals_sats,
            fee_recipient_sats: a.fee_recipient_sats,
            vault_sats: a.vault_sats,
        });

    let user_override_vault = backend_amounts.as_ref().and_then(|a| a.vault_sats);
    let selected_vault_sats = if let Some(vs) = dynamic_vault_sats {
        Some(vs)
    } else if let Some(vs) = user_override_vault {
        ic_cdk::println!(
            "[build_psbt] using user-provided vault_sats override: {}",
            vs
        );
        Some(vs)
    } else {
        let fallback_sats = compute_target_collateral_sats(
            COLLATERAL_FALLBACK_PRICE_USD,
            settings.collateral.ratio_bps,
            settings.collateral.usd_cents,
        );
        ic_cdk::println!(
            "[build_psbt] no XRC price or override; fallback price {} -> vault_sats={}",
            COLLATERAL_FALLBACK_PRICE_USD,
            fallback_sats
        );
        Some(fallback_sats)
    };

    if let Some(vs) = selected_vault_sats {
        backend_amounts
            .get_or_insert(BackendAmountOverrides {
                ordinals_sats: None,
                fee_recipient_sats: None,
                vault_sats: None,
            })
            .vault_sats = Some(vs);
    } else {
        return Err("vault_sats_unavailable".into());
    }

    let vault_id = next_vault_id();
    let protocol_key = derive_protocol_key(vault_id).await?;
    ic_cdk::println!(
        "[build_psbt] new vault assignment -> vault_id={}, protocol_pub={}",
        vault_id,
        protocol_key.public_key_hex
    );

    let backend_request = BackendBuildPsbtRequest {
        rune: request.rune,
        fee_rate: request.fee_rate,
        fee_recipient: request.fee_recipient,
        ordinals: request.ordinals.into(),
        payment: request.payment.into(),
        amounts: backend_amounts,
        vault_id: vault_id.to_string(),
        protocol_public_key: protocol_key.public_key_hex.clone(),
        protocol_chain_code: protocol_key.chain_code_hex.clone(),
    };
    let body = serde_json::to_vec(&backend_request).map_err(|err| err.to_string())?;
    let mut headers = vec![HttpHeader {
        name: "Content-Type".into(),
        value: "application/json".into(),
    }];

    if let Some(api_key) = config.api_key {
        headers.push(HttpHeader {
            name: "x-api-key".into(),
            value: api_key,
        });
    }

    let url = format!("{}/mint/build-psbt", config.base_url.trim_end_matches('/'));
    let response = backend_http_request(url, HttpMethod::POST, Some(body), headers.clone()).await?;

    ic_cdk::println!(
        "[build_psbt] received response status {:?}, body_len={}",
        response.status,
        response.body.len()
    );

    if response.status >= Nat::from(400u32) {
        return Err(format!("backend responded with status {}", response.status));
    }

    let parsed: BackendMintResponse = serde_json::from_slice(&response.body)
        .map_err(|err| format!("invalid backend json: {}", err))?;

    ic_cdk::println!(
        "[build_psbt] success -> wallet: {}, vault: {}, inputs: {}",
        parsed.result.wallet,
        parsed.result.vault_address,
        parsed.result.inputs.len()
    );

    Ok(MintResponse::from(parsed))
}

#[update]
async fn prepare_withdraw(vault_id: String) -> Result<WithdrawPrepareResponse, String> {
    let settings = SETTINGS.with(|s| s.borrow().clone());
    let config = settings.backend;
    if config.base_url.is_empty() {
        return Err("backend_not_configured".into());
    }
    let mut headers = vec![HttpHeader {
        name: "Content-Type".into(),
        value: "application/json".into(),
    }];
    if let Some(api_key) = config.api_key.clone() {
        headers.push(HttpHeader {
            name: "x-api-key".into(),
            value: api_key,
        });
    }
    let body = serde_json::to_vec(&serde_json::json!({ "vaultId": vault_id }))
        .map_err(|err| err.to_string())?;
    let url = format!("{}/withdraw/prepare", config.base_url.trim_end_matches('/'));
    let response = backend_http_request(url, HttpMethod::POST, Some(body), headers).await?;
    if response.status >= Nat::from(400u32) {
        return Err(format!("backend responded with status {}", response.status));
    }
    let parsed: BackendWithdrawPreparePayload = serde_json::from_slice(&response.body)
        .map_err(|err| format!("invalid backend json: {}", err))?;
    Ok(WithdrawPrepareResponse {
        vault_id: parsed.vault_id,
        psbt: parsed.psbt,
        burn_metadata: parsed.burn_metadata,
        inputs: parsed.inputs.into_iter().map(WithdrawInput::from).collect(),
        ordinals_address: parsed.ordinals_address,
        payment_address: parsed.payment_address,
        vault_address: parsed.vault_address,
    })
}

#[update]
async fn finalize_withdraw(
    request: WithdrawFinalizeRequest,
) -> Result<WithdrawFinalizeResponse, String> {
    let settings = SETTINGS.with(|s| s.borrow().clone());
    let config = settings.backend;
    if config.base_url.is_empty() {
        return Err("backend_not_configured".into());
    }
    let mut headers = vec![HttpHeader {
        name: "Content-Type".into(),
        value: "application/json".into(),
    }];
    if let Some(api_key) = config.api_key.clone() {
        headers.push(HttpHeader {
            name: "x-api-key".into(),
            value: api_key,
        });
    }
    let endpoint = format!(
        "{}/withdraw/finalize",
        config.base_url.trim_end_matches('/')
    );
    let mut payload = serde_json::json!({
        "vaultId": request.vault_id,
        "psbt": request.signed_psbt,
        "broadcast": request.broadcast.unwrap_or(true),
    });
    let mut response = backend_http_request(
        endpoint.clone(),
        HttpMethod::POST,
        Some(serde_json::to_vec(&payload).map_err(|err| err.to_string())?),
        headers.clone(),
    )
    .await?;
    if response.status == Nat::from(202u32) {
        let prompt: BackendWithdrawSignatureRequired = serde_json::from_slice(&response.body)
            .map_err(|err| format!("invalid backend json: {}", err))?;
        let vault_numeric: u64 = prompt.vault_id.parse().map_err(|_| "invalid_vault_id")?;
        let sighash_vec = from_hex(&prompt.sighash)?;
        let sighash = to_array_32(&sighash_vec)?;
        if !prompt.merkle_root.is_empty() {
            ic_cdk::println!(
                "[finalize_withdraw] ignoring merkle_root from backend prompt (vault_id={})",
                prompt.vault_id
            );
        }
        let signature = sign_protocol_withdraw(vault_numeric, sighash).await?;
        if let Some(obj) = payload.as_object_mut() {
            obj.insert(
                "protocolSignature".to_string(),
                serde_json::Value::String(to_hex(&signature)),
            );
        }
        response = backend_http_request(
            endpoint,
            HttpMethod::POST,
            Some(serde_json::to_vec(&payload).map_err(|err| err.to_string())?),
            headers,
        )
        .await?;
    }
    if response.status >= Nat::from(400u32) {
        return Err(format!("backend responded with status {}", response.status));
    }
    let parsed: BackendWithdrawFinalizeSuccess = serde_json::from_slice(&response.body)
        .map_err(|err| format!("invalid backend json: {}", err))?;
    Ok(WithdrawFinalizeResponse {
        vault_id: parsed.vault_id,
        txid: parsed.txid,
        hex: parsed.hex,
    })
}

#[update]
async fn sign_withdraw(request: WithdrawSignRequest) -> Result<WithdrawSignResponse, String> {
    let vault_id: u64 = request.vault_id.parse().map_err(|_| "invalid_vault_id")?;
    if request.tapleaf_hash.len() != 32 {
        return Err("invalid_tapleaf_hash_length".into());
    }
    let merkle_root = request
        .merkle_root
        .as_ref()
        .filter(|bytes| !bytes.is_empty())
        .map(|bytes| {
            if bytes.len() != 32 {
                Err::<[u8; 32], String>("invalid_merkle_root_length".into())
            } else {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(bytes);
                Ok(arr)
            }
        })
        .transpose()?;
    let sighash = decode_digest(&request.sighash, "sighash")?;
    if merkle_root.is_some() {
        ic_cdk::println!(
            "[sign_withdraw] ignoring merkle_root for script-path signature (vault_id={})",
            vault_id
        );
    }
    let signature = sign_protocol_withdraw(vault_id, sighash).await?;
    Ok(WithdrawSignResponse { signature })
}

#[update]
async fn debug_protocol_pubkey(vault_id: u64) -> Result<String, String> {
    let k = derive_protocol_key(vault_id).await?;
    Ok(k.public_key_hex)
}

#[query]
async fn debug_self_verify(
    vault_id: u64,
    sighash_hex: String,
    sig_hex: String,
) -> Result<bool, String> {
    use k256::schnorr::{signature::Verifier, Signature, VerifyingKey};

    let pub_hex = debug_protocol_pubkey(vault_id).await?;
    let msg = from_hex(&sighash_hex)?;
    if msg.len() != 32 {
        return Err("sighash must be 32 bytes".into());
    }
    let sig = from_hex(&sig_hex)?;
    let pk_bytes = from_hex(&pub_hex)?;

    let pk_arr = to_array_32(&pk_bytes)?;
    let msg_arr = to_array_32(&msg)?;
    let sig_arr = to_array_64(&sig)?;

    let pk = VerifyingKey::from_bytes(&pk_arr).map_err(|_| "bad pubkey")?;
    let signature = Signature::try_from(&sig_arr[..]).map_err(|_| "bad sig")?;
    Ok(pk.verify(&msg_arr, &signature).is_ok())
}

fn decode_digest(bytes: &[u8], field: &str) -> Result<[u8; 32], String> {
    if bytes.len() == 32 {
        let mut arr = [0u8; 32];
        arr.copy_from_slice(bytes);
        return Ok(arr);
    }
    if bytes.len() == 64 {
        let as_str = std::str::from_utf8(bytes).map_err(|_| format!("{}_invalid_utf8", field))?;
        let decoded = from_hex(as_str)?;
        if decoded.len() != 32 {
            return Err(format!("{}_invalid_length", field));
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(&decoded);
        return Ok(arr);
    }
    Err(format!("{}_invalid_length", field))
}

#[update]
async fn list_user_vaults(payment_address: String) -> Result<Vec<VaultSummary>, String> {
    let settings = SETTINGS.with(|s| s.borrow().clone());
    let config = settings.backend;
    if config.base_url.is_empty() {
        return Err("backend_not_configured".into());
    }

    if payment_address.trim().is_empty() {
        return Err("missing_payment_address".into());
    }

    let mut headers = vec![];
    if let Some(api_key) = config.api_key.clone() {
        headers.push(HttpHeader {
            name: "x-api-key".into(),
            value: api_key,
        });
    }

    let url = format!(
        "{}/vaults?payment={}",
        config.base_url.trim_end_matches('/'),
        payment_address
    );

    let response = backend_http_request(url, HttpMethod::GET, None, headers).await?;
    if response.status >= Nat::from(400u32) {
        return Err(format!("backend responded with status {}", response.status));
    }

    let parsed: BackendVaultListResponse = serde_json::from_slice(&response.body)
        .map_err(|err| format!("invalid backend json: {}", err))?;

    let mut summaries: Vec<VaultSummary> = parsed
        .vaults
        .into_iter()
        .map(|record| VaultSummary {
            vault_id: record.vault_id,
            vault_address: record.vault_address,
            collateral_sats: record.collateral_sats,
            protocol_public_key: record.protocol_public_key,
            created_at: record.created_at,
            rune: record.metadata.rune,
            fee_rate: record.metadata.fee_rate,
            ordinals_address: record.metadata.ordinals_address,
            payment_address: record.metadata.payment_address,
            txid: record.txid,
            withdraw_txid: record.withdraw_tx_id,
        })
        .collect();

    summaries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(summaries)
}

#[query]
fn transform_http_response(args: TransformArgs) -> HttpResponse {
    HttpResponse {
        status: args.response.status,
        headers: vec![],
        body: args.response.body,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn basic() {
        assert_eq!(2 + 2, 4);
    }
}
#[derive(Clone, CandidType, Deserialize, Serialize)]
struct WithdrawSignRequest {
    vault_id: String,
    tapleaf_hash: Vec<u8>,
    control_block: Vec<u8>,
    sighash: Vec<u8>,
    merkle_root: Option<Vec<u8>>,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct WithdrawSignResponse {
    signature: Vec<u8>,
}
async fn sign_protocol_withdraw(vault_id: u64, msg_hash: [u8; 32]) -> Result<Vec<u8>, String> {
    let derived = derive_protocol_key(vault_id).await?;
    ic_cdk::println!(
        "[sign_protocol_withdraw] signing vault_id={} using protocol_pub={}",
        vault_id,
        derived.public_key_hex
    );
    let arg = SignWithSchnorrArgument {
        message: ByteBuf::from(msg_hash.to_vec()),
        derivation_path: protocol_derivation_path(vault_id),
        key_id: schnorr_key_id(),
        aux: None,
    };
    let (response,): (SignWithSchnorrResponse,) = ic_cdk::api::call::call_with_payment128(
        Principal::management_canister(),
        "sign_with_schnorr",
        (arg,),
        SCHNORR_PUBLIC_KEY_CYCLES,
    )
    .await
    .map_err(|(code, msg)| format!("sign_with_schnorr error {:?}: {}", code, msg))?;
    if response.signature.len() != 64 {
        return Err("invalid_protocol_signature_length".into());
    }
    Ok(response.signature)
}
