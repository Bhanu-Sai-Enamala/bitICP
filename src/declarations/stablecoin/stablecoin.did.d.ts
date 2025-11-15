import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export interface AddressBinding {
  'public_key' : string,
  'address_type' : string,
  'address' : string,
}
export interface AmountOverrides {
  'ordinals_sats' : [] | [bigint],
  'vault_sats' : [] | [bigint],
  'fee_recipient_sats' : [] | [bigint],
}
export interface BackendConfig {
  'base_url' : string,
  'api_key' : [] | [string],
}
export interface CollateralPreview {
  'price' : number,
  'sats' : bigint,
  'ratio_bps' : number,
  'usd_cents' : number,
  'using_fallback_price' : boolean,
}
export interface BuildPsbtRequest {
  'ordinals' : AddressBinding,
  'fee_recipient' : string,
  'rune' : string,
  'amounts' : [] | [AmountOverrides],
  'fee_rate' : number,
  'payment' : AddressBinding,
}
export interface ChangeOutput { 'amount_btc' : string, 'address' : string }
export interface InputRef { 'txid' : string, 'vout' : number }
export interface MintResponse {
  'result' : MintResult,
  'rune' : string,
  'fee_rate' : number,
}
export interface MintResult {
  'change_output' : [] | [ChangeOutput],
  'raw_transaction_hex' : string,
  'ordinals_address' : string,
  'rune' : string,
  'protocol_public_key' : string,
  'vault_id' : string,
  'descriptor' : string,
  'vault_address' : string,
  'fee_rate' : number,
  'inputs' : Array<InputRef>,
  'wallet' : string,
  'original_psbt' : string,
  'collateral_sats' : bigint,
  'payment_address' : string,
  'protocol_chain_code' : string,
  'patched_psbt' : string,
}
export interface VaultSummary {
  'withdraw_txid' : [] | [string],
  'ordinals_address' : string,
  'rune' : string,
  'txid' : [] | [string],
  'protocol_public_key' : string,
  'vault_id' : string,
  'created_at' : bigint,
  'vault_address' : string,
  'fee_rate' : number,
  'collateral_sats' : bigint,
  'locked_collateral_btc' : number,
  'payment_address' : string,
  'confirmations' : number,
  'min_confirmations' : number,
  'withdrawable' : boolean,
  'last_btc_price_usd' : [] | [number],
  'collateral_ratio_bps' : [] | [number],
  'mint_tokens' : [] | [number],
  'mint_usd_cents' : [] | [bigint],
  'health' : [] | [string],
}
export interface WithdrawFinalizeRequest {
  'vault_id' : string,
  'signed_psbt' : string,
  'broadcast' : [] | [boolean],
}
export interface WithdrawFinalizeResponse {
  'hex' : string,
  'txid' : [] | [string],
  'vault_id' : string,
}
export interface WithdrawInput {
  'value' : number,
  'txid' : string,
  'vout' : number,
}
export interface WithdrawPrepareResponse {
  'ordinals_address' : string,
  'psbt' : string,
  'burn_metadata' : string,
  'vault_id' : string,
  'vault_address' : string,
  'inputs' : Array<WithdrawInput>,
  'payment_address' : string,
}
export interface WithdrawSignRequest {
  'sighash' : Uint8Array | number[],
  'vault_id' : string,
  'merkle_root' : [] | [Uint8Array | number[]],
  'tapleaf_hash' : Uint8Array | number[],
  'control_block' : Uint8Array | number[],
}
export interface WithdrawSignResponse { 'signature' : Uint8Array | number[] }
export interface _SERVICE {
  'build_psbt' : ActorMethod<
    [BuildPsbtRequest],
    { 'Ok' : MintResponse } |
      { 'Err' : string }
  >,
  'finalize_withdraw' : ActorMethod<
    [WithdrawFinalizeRequest],
    { 'Ok' : WithdrawFinalizeResponse } |
      { 'Err' : string }
  >,
  'get_backend_config' : ActorMethod<[], BackendConfig>,
  'get_collateral_preview' : ActorMethod<
    [],
    { 'Ok' : CollateralPreview } |
      { 'Err' : string }
  >,
  'health' : ActorMethod<[], string>,
  'list_user_vaults' : ActorMethod<
    [string],
    { 'Ok' : Array<VaultSummary> } |
      { 'Err' : string }
  >,
  'ping' : ActorMethod<[], string>,
  'prepare_withdraw' : ActorMethod<
    [string],
    { 'Ok' : WithdrawPrepareResponse } |
      { 'Err' : string }
  >,
  'set_backend_config' : ActorMethod<[string, [] | [string]], undefined>,
  'sign_withdraw' : ActorMethod<
    [WithdrawSignRequest],
    { 'Ok' : WithdrawSignResponse } |
      { 'Err' : string }
  >,
  'version' : ActorMethod<[], string>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
