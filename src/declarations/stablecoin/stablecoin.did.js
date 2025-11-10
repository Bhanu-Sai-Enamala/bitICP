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
  const BuildPsbtRequest = IDL.Record({
    'ordinals' : AddressBinding,
    'fee_recipient' : IDL.Text,
    'rune' : IDL.Text,
    'amounts' : IDL.Opt(AmountOverrides),
    'fee_rate' : IDL.Float64,
    'payment' : AddressBinding,
  });
  const ChangeOutput = IDL.Record({
    'amount_btc' : IDL.Text,
    'address' : IDL.Text,
  });
  const InputRef = IDL.Record({ 'txid' : IDL.Text, 'vout' : IDL.Nat32 });
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
  const BackendConfig = IDL.Record({
    'base_url' : IDL.Text,
    'api_key' : IDL.Opt(IDL.Text),
  });
  const VaultSummary = IDL.Record({
    'ordinals_address' : IDL.Text,
    'rune' : IDL.Text,
    'txid' : IDL.Opt(IDL.Text),
    'protocol_public_key' : IDL.Text,
    'vault_id' : IDL.Text,
    'created_at' : IDL.Nat64,
    'vault_address' : IDL.Text,
    'fee_rate' : IDL.Float64,
    'collateral_sats' : IDL.Nat64,
    'payment_address' : IDL.Text,
  });
  return IDL.Service({
    'build_psbt' : IDL.Func(
        [BuildPsbtRequest],
        [IDL.Variant({ 'Ok' : MintResponse, 'Err' : IDL.Text })],
        [],
      ),
    'get_backend_config' : IDL.Func([], [BackendConfig], ['query']),
    'health' : IDL.Func([], [IDL.Text], ['query']),
    'list_user_vaults' : IDL.Func(
        [IDL.Text],
        [IDL.Variant({ 'Ok' : IDL.Vec(VaultSummary), 'Err' : IDL.Text })],
        [],
      ),
    'ping' : IDL.Func([], [IDL.Text], []),
    'set_backend_config' : IDL.Func([IDL.Text, IDL.Opt(IDL.Text)], [], []),
    'version' : IDL.Func([], [IDL.Text], ['query']),
  });
};
export const init = ({ IDL }) => { return []; };
