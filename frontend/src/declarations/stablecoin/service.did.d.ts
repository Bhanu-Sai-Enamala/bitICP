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
export interface VaultSummary {
  'vault_id' : string,
  'vault_address' : string,
  'collateral_sats' : bigint,
  'protocol_public_key' : string,
  'created_at' : bigint,
  'rune' : string,
  'fee_rate' : number,
  'ordinals_address' : string,
  'payment_address' : string,
  'txid' : [] | [string],
}
export interface MintResult {
  'wallet' : string,
  'vault_address' : string,
  'vault_id' : string,
  'protocol_public_key' : string,
  'protocol_chain_code' : string,
  'descriptor' : string,
  'original_psbt' : string,
  'patched_psbt' : string,
  'raw_transaction_hex' : string,
  'inputs' : Array<InputRef>,
  'change_output' : [] | [ChangeOutput],
  'collateral_sats' : bigint,
  'rune' : string,
  'fee_rate' : number,
  'ordinals_address' : string,
  'payment_address' : string,
}
export interface _SERVICE {
  'build_psbt' : ActorMethod<
    [BuildPsbtRequest],
    { 'Ok' : MintResponse } |
      { 'Err' : string }
  >,
  'list_user_vaults' : ActorMethod<
    [string],
    { 'Ok' : Array<VaultSummary> } |
      { 'Err' : string }
  >,
  'get_backend_config' : ActorMethod<[], BackendConfig>,
  'health' : ActorMethod<[], string>,
  'ping' : ActorMethod<[], string>,
  'set_backend_config' : ActorMethod<[string, [] | [string]], undefined>,
  'version' : ActorMethod<[], string>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
