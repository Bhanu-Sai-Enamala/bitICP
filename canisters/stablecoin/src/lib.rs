use candid::{CandidType, Func, Nat};
use ic_cdk::api::management_canister::http_request::{
    http_request, CanisterHttpRequestArgument, HttpHeader, HttpMethod, HttpResponse,
    TransformArgs, TransformContext, TransformFunc,
};
use ic_cdk::api::time;
use ic_cdk::caller;
use ic_cdk::storage::{stable_restore, stable_save};
use ic_cdk_macros::{init, post_upgrade, pre_upgrade, query, update};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;

const HTTP_CYCLES_COST: u128 = 2_000_000_000_000; // 2T cycles (~0.2T min) per request baseline

#[derive(Clone, Default, CandidType, Deserialize, Serialize)]
struct BackendConfig {
    base_url: String,
    api_key: Option<String>,
}

thread_local! {
    static SETTINGS: RefCell<BackendConfig> = RefCell::new(BackendConfig::default());
}

#[init]
fn init() {
    ic_cdk::println!("stablecoin canister initialized at {}", time());
}

#[pre_upgrade]
fn pre_upgrade() {
    let config = SETTINGS.with(|settings| settings.borrow().clone());
    stable_save((config,)).expect("failed to save settings");
}

#[post_upgrade]
fn post_upgrade() {
    if let Ok((config,)) = stable_restore::<(BackendConfig,)>() {
        SETTINGS.with(|settings| *settings.borrow_mut() = config);
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
    SETTINGS.with(|settings| settings.borrow().clone())
}

#[update]
fn set_backend_config(base_url: String, api_key: Option<String>) {
    if !base_url.starts_with("https://") {
        ic_cdk::trap("backend base URL must start with https://");
    }

    SETTINGS.with(|settings| {
        let mut cfg = settings.borrow_mut();
        cfg.base_url = base_url;
        cfg.api_key = api_key;
    });
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
#[serde(rename_all = "camelCase")]
struct BackendChangeOutput {
    address: String,
   amount_btc: String,
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackendMintResult {
    wallet: String,
    vault_address: String,
    descriptor: String,
    original_psbt: String,
    patched_psbt: String,
    raw_transaction_hex: String,
    inputs: Vec<BackendInputRef>,
    change_output: Option<BackendChangeOutput>,
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
    ordinals_sats: Option<u64>,
    fee_recipient_sats: Option<u64>,
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

impl From<BuildPsbtRequest> for BackendBuildPsbtRequest {
    fn from(value: BuildPsbtRequest) -> Self {
        Self {
            rune: value.rune,
            fee_rate: value.fee_rate,
            fee_recipient: value.fee_recipient,
            ordinals: value.ordinals.into(),
            payment: value.payment.into(),
            amounts: value.amounts.map(Into::into),
        }
    }
}

#[derive(Clone, CandidType, Deserialize, Serialize)]
struct MintResponse {
    rune: String,
    fee_rate: f64,
    result: BackendMintResult,
}

impl From<BackendMintResponse> for MintResponse {
    fn from(resp: BackendMintResponse) -> Self {
        MintResponse {
            rune: resp.rune,
            fee_rate: resp.fee_rate,
            result: resp.result,
        }
    }
}

#[update]
async fn build_psbt(request: BuildPsbtRequest) -> Result<MintResponse, String> {
  let config = SETTINGS.with(|settings| settings.borrow().clone());
  if config.base_url.is_empty() {
    return Err("backend_not_configured".into());
  }

  ic_cdk::println!(
    "[build_psbt] preparing request -> base_url: {}, rune: {}, fee_rate: {}",
    config.base_url,
    request.rune,
    request.fee_rate
  );

  let backend_request: BackendBuildPsbtRequest = request.into();
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
  let args = CanisterHttpRequestArgument {
    url,
    method: HttpMethod::POST,
    body: Some(body),
    max_response_bytes: Some(2_000_000),
        headers,
        transform: Some(TransformContext {
            function: TransformFunc(Func {
                principal: ic_cdk::id(),
                method: "transform_http_response".into(),
            }),
            context: vec![],
        }),
    };

  let (response,) = http_request(args, HTTP_CYCLES_COST)
    .await
    .map_err(|(code, msg)| format!("http_request error: {:?}: {}", code, msg))?;

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
