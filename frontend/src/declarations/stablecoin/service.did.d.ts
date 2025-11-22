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
  'rune_op_return_hex' : string,
  'ordinals_sats' : bigint,
  'fee_recipient_address' : string,
  'fee_recipient_sats' : bigint,
}
export interface BuildPsbtRequest {
  'ordinals' : AddressBinding,
  'fee_recipient' : string,
  'rune' : string,
  'amounts' : [] | [AmountOverrides],
  'fee_rate' : number,
  'inputs_override' : [] | [Array<InputRef>],
  'payment' : AddressBinding,
  'outputs_override_json' : [] | [string],
}
export interface ChangeOutput { 'amount_btc' : string, 'address' : string }
export interface CollateralPreview {
  'using_fallback_price' : boolean,
  'sats' : bigint,
  'ratio_bps' : number,
  'usd_cents' : number,
  'price' : number,
}
export interface FinalizeMintRequest {
  'vault_id' : string,
  'signed_psbt' : string,
}
export interface FinalizeMintResponse {
  'hex' : string,
  'txid' : [] | [string],
  'vault_id' : string,
}
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
  'oracle_public_key' : string,
  'oracle_chain_code' : string,
  'liquidation_public_key' : string,
  'liquidation_chain_code' : string,
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
  'confirmations' : number,
  'last_btc_price_usd' : [] | [number],
  'mint_usd_cents' : [] | [bigint],
  'withdraw_txid' : [] | [string],
  'locked_collateral_btc' : number,
  'ordinals_address' : string,
  'rune' : string,
  'mint_tokens' : [] | [number],
  'txid' : [] | [string],
  'protocol_public_key' : string,
  'vault_id' : string,
  'created_at' : bigint,
  'vault_address' : string,
  'fee_rate' : number,
  'withdrawable' : boolean,
  'min_confirmations' : number,
  'collateral_sats' : bigint,
  'payment_address' : string,
  'collateral_ratio_bps' : [] | [number],
  'health' : [] | [string],
}
export interface AuctionSummary {
  'claim_price_sats' : bigint,
  'treasury_deadline' : bigint,
  'started_at' : bigint,
  'offer_ratio_bps' : number,
  'payment_address' : string,
  'claimed' : boolean,
  'ordinals_address' : string,
  'vault_id' : string,
  'vault_address' : string,
}
export interface AuctionClaimRequest {
  'vault_id' : string,
  'ordinals' : AddressBinding,
  'payment' : AddressBinding,
}
export interface AuctionClaimResponse {
  'vault_id' : string,
  'psbt' : string,
  'burn_metadata' : string,
  'claim_price_sats' : bigint,
  'ordinals_address' : string,
  'payment_address' : string,
}
export interface AuctionFinalizeRequest {
  'vault_id' : string,
  'psbt' : string,
  'claimant_payment_address' : string,
}
export interface AuctionFinalizeResponse {
  'vault_id' : string,
  'txid' : [] | [string],
  'hex' : string,
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
export interface DebugUtxo {
  'value_sats' : bigint,
  'txid' : string,
  'vout' : number,
}
export interface _SERVICE {
  'build_psbt' : ActorMethod<
    [BuildPsbtRequest],
    { 'Ok' : MintResponse } |
      { 'Err' : string }
  >,
  'debug_get_utxos' : ActorMethod<
    [string],
    { 'Ok' : Array<DebugUtxo> } |
      { 'Err' : string }
  >,
  'finalize_mint' : ActorMethod<
    [FinalizeMintRequest],
    { 'Ok' : FinalizeMintResponse } |
      { 'Err' : string }
  >,
  'finalize_withdraw' : ActorMethod<
    [WithdrawFinalizeRequest],
    { 'Ok' : WithdrawFinalizeResponse } |
      { 'Err' : string }
  >,
  'debug_get_utxos' : ActorMethod<
    [string],
    { 'Ok' : Array<DebugUtxo> } |
      { 'Err' : string }
  >,
  'force_start_auction' : ActorMethod<
    [string],
    { 'Ok' : AuctionSummary } |
      { 'Err' : string }
  >,
  'prepare_auction_claim' : ActorMethod<
    [AuctionClaimRequest],
    { 'Ok' : AuctionClaimResponse } |
      { 'Err' : string }
  >,
  'finalize_auction_claim' : ActorMethod<
    [AuctionFinalizeRequest],
    { 'Ok' : AuctionFinalizeResponse } |
      { 'Err' : string }
  >,
  'get_backend_config' : ActorMethod<[], BackendConfig>,
  'get_collateral_preview' : ActorMethod<
    [],
    { 'Ok' : CollateralPreview } |
      { 'Err' : string }
  >,
  'health' : ActorMethod<[], string>,
  'list_auctions' : ActorMethod<[], Array<AuctionSummary>>,
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
  'set_backend_broadcast_mode' : ActorMethod<[boolean, boolean], undefined>,
  'set_auction_timer_enabled' : ActorMethod<[boolean], undefined>,
  'set_fee_config' : ActorMethod<[bigint, bigint, string, string], undefined>,
  'set_local_testing_mode' : ActorMethod<[boolean], undefined>,
  'get_auction_timer_enabled' : ActorMethod<[], boolean>,
  'set_oracle_price_mode' : ActorMethod<[boolean], undefined>,
  'set_protocol_keys' : ActorMethod<[string, string, string], undefined>,
  'set_schnorr_key' : ActorMethod<
    [string],
    { 'Ok' : null } |
      { 'Err' : string }
  >,
  'set_xrc_config' : ActorMethod<[Principal], undefined>,
  'sign_withdraw' : ActorMethod<
    [WithdrawSignRequest],
    { 'Ok' : WithdrawSignResponse } |
      { 'Err' : string }
  >,
  'version' : ActorMethod<[], string>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
