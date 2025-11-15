export const idlFactory = ({ IDL }) => {
  const AddressBinding = IDL.Record({
    'public_key' : IDL.Text,
    'address_type' : IDL.Text,
    'address' : IDL.Text,
  });
  const AmountOverrides = IDL.Record({
    'ordinals_sats' : IDL.Opt(IDL.Nat64),
    'vault_sats' : IDL.Opt(IDL.Nat64),
    'fee_recipient_sats' : IDL.Opt(IDL.Nat64),
  });
  const InputRef = IDL.Record({ 'txid' : IDL.Text, 'vout' : IDL.Nat32 });
  const BuildPsbtRequest = IDL.Record({
    'ordinals' : AddressBinding,
    'fee_recipient' : IDL.Text,
    'rune' : IDL.Text,
    'amounts' : IDL.Opt(AmountOverrides),
    'fee_rate' : IDL.Float64,
    'inputs_override' : IDL.Opt(IDL.Vec(InputRef)),
    'payment' : AddressBinding,
    'outputs_override_json' : IDL.Opt(IDL.Text),
  });
  const ChangeOutput = IDL.Record({
    'amount_btc' : IDL.Text,
    'address' : IDL.Text,
  });
  const MintResult = IDL.Record({
    'change_output' : IDL.Opt(ChangeOutput),
    'raw_transaction_hex' : IDL.Text,
    'ordinals_address' : IDL.Text,
    'rune' : IDL.Text,
    'protocol_public_key' : IDL.Text,
    'vault_id' : IDL.Text,
    'descriptor' : IDL.Text,
    'vault_address' : IDL.Text,
    'fee_rate' : IDL.Float64,
    'inputs' : IDL.Vec(InputRef),
    'wallet' : IDL.Text,
    'original_psbt' : IDL.Text,
    'collateral_sats' : IDL.Nat64,
    'payment_address' : IDL.Text,
    'protocol_chain_code' : IDL.Text,
    'patched_psbt' : IDL.Text,
  });
  const MintResponse = IDL.Record({
    'result' : MintResult,
    'rune' : IDL.Text,
    'fee_rate' : IDL.Float64,
  });
  const FinalizeMintRequest = IDL.Record({
    'vault_id' : IDL.Text,
    'signed_psbt' : IDL.Text,
  });
  const FinalizeMintResponse = IDL.Record({
    'hex' : IDL.Text,
    'txid' : IDL.Opt(IDL.Text),
    'vault_id' : IDL.Text,
  });
  const WithdrawFinalizeRequest = IDL.Record({
    'vault_id' : IDL.Text,
    'signed_psbt' : IDL.Text,
    'broadcast' : IDL.Opt(IDL.Bool),
  });
  const WithdrawFinalizeResponse = IDL.Record({
    'hex' : IDL.Text,
    'txid' : IDL.Opt(IDL.Text),
    'vault_id' : IDL.Text,
  });
  const BackendConfig = IDL.Record({
    'base_url' : IDL.Text,
    'api_key' : IDL.Opt(IDL.Text),
    'rune_op_return_hex' : IDL.Text,
    'ordinals_sats' : IDL.Nat64,
    'fee_recipient_address' : IDL.Text,
    'fee_recipient_sats' : IDL.Nat64,
  });
  const CollateralPreview = IDL.Record({
    'using_fallback_price' : IDL.Bool,
    'sats' : IDL.Nat64,
    'ratio_bps' : IDL.Nat16,
    'usd_cents' : IDL.Nat32,
    'price' : IDL.Float64,
  });
  const VaultSummary = IDL.Record({
    'confirmations' : IDL.Nat32,
    'last_btc_price_usd' : IDL.Opt(IDL.Float64),
    'mint_usd_cents' : IDL.Opt(IDL.Nat64),
    'withdraw_txid' : IDL.Opt(IDL.Text),
    'locked_collateral_btc' : IDL.Float64,
    'ordinals_address' : IDL.Text,
    'rune' : IDL.Text,
    'mint_tokens' : IDL.Opt(IDL.Float64),
    'txid' : IDL.Opt(IDL.Text),
    'protocol_public_key' : IDL.Text,
    'vault_id' : IDL.Text,
    'created_at' : IDL.Nat64,
    'vault_address' : IDL.Text,
    'fee_rate' : IDL.Float64,
    'withdrawable' : IDL.Bool,
    'min_confirmations' : IDL.Nat32,
    'collateral_sats' : IDL.Nat64,
    'payment_address' : IDL.Text,
    'collateral_ratio_bps' : IDL.Opt(IDL.Nat32),
    'health' : IDL.Opt(IDL.Text),
  });
  const WithdrawInput = IDL.Record({
    'value' : IDL.Float64,
    'txid' : IDL.Text,
    'vout' : IDL.Nat32,
  });
  const WithdrawPrepareResponse = IDL.Record({
    'ordinals_address' : IDL.Text,
    'psbt' : IDL.Text,
    'burn_metadata' : IDL.Text,
    'vault_id' : IDL.Text,
    'vault_address' : IDL.Text,
    'inputs' : IDL.Vec(WithdrawInput),
    'payment_address' : IDL.Text,
  });
  const WithdrawSignRequest = IDL.Record({
    'sighash' : IDL.Vec(IDL.Nat8),
    'vault_id' : IDL.Text,
    'merkle_root' : IDL.Opt(IDL.Vec(IDL.Nat8)),
    'tapleaf_hash' : IDL.Vec(IDL.Nat8),
    'control_block' : IDL.Vec(IDL.Nat8),
  });
  const WithdrawSignResponse = IDL.Record({ 'signature' : IDL.Vec(IDL.Nat8) });
  return IDL.Service({
    'build_psbt' : IDL.Func(
        [BuildPsbtRequest],
        [IDL.Variant({ 'Ok' : MintResponse, 'Err' : IDL.Text })],
        [],
      ),
    'finalize_mint' : IDL.Func(
        [FinalizeMintRequest],
        [IDL.Variant({ 'Ok' : FinalizeMintResponse, 'Err' : IDL.Text })],
        [],
      ),
    'finalize_withdraw' : IDL.Func(
        [WithdrawFinalizeRequest],
        [IDL.Variant({ 'Ok' : WithdrawFinalizeResponse, 'Err' : IDL.Text })],
        [],
      ),
    'get_backend_config' : IDL.Func([], [BackendConfig], ['query']),
    'get_collateral_preview' : IDL.Func(
        [],
        [IDL.Variant({ 'Ok' : CollateralPreview, 'Err' : IDL.Text })],
        [],
      ),
    'health' : IDL.Func([], [IDL.Text], ['query']),
    'list_user_vaults' : IDL.Func(
        [IDL.Text],
        [IDL.Variant({ 'Ok' : IDL.Vec(VaultSummary), 'Err' : IDL.Text })],
        [],
      ),
    'ping' : IDL.Func([], [IDL.Text], []),
    'prepare_withdraw' : IDL.Func(
        [IDL.Text],
        [IDL.Variant({ 'Ok' : WithdrawPrepareResponse, 'Err' : IDL.Text })],
        [],
      ),
    'set_backend_config' : IDL.Func([IDL.Text, IDL.Opt(IDL.Text)], [], []),
    'set_fee_config' : IDL.Func(
        [IDL.Nat64, IDL.Nat64, IDL.Text, IDL.Text],
        [],
        [],
      ),
    'set_protocol_keys' : IDL.Func([IDL.Text, IDL.Text, IDL.Text], [], []),
    'set_schnorr_key' : IDL.Func(
        [IDL.Text],
        [IDL.Variant({ 'Ok' : IDL.Null, 'Err' : IDL.Text })],
        [],
      ),
    'sign_withdraw' : IDL.Func(
        [WithdrawSignRequest],
        [IDL.Variant({ 'Ok' : WithdrawSignResponse, 'Err' : IDL.Text })],
        [],
      ),
    'version' : IDL.Func([], [IDL.Text], ['query']),
  });
};
export const init = ({ IDL }) => { return []; };
