export interface AddressBinding {
  address: string;
  addressType: string;
  publicKey: string;
}

export interface MintRequestBody {
  rune: string;
  feeRate: number;
  feeRecipient: string;
  ordinals: AddressBinding;
  payment: AddressBinding;
  vaultId: string;
  protocolPublicKey: string;
  protocolChainCode: string;
  oraclePublicKey: string;
  oracleChainCode: string;
  liquidationPublicKey: string;
  liquidationChainCode: string;
  amounts?: Partial<MintOutputAmounts>;
  inputsOverride?: Array<{ txid: string; vout: number }>;
  outputsOverrideJson?: string;
}

export interface MintOutputAmounts {
  ordinalsSats: number;
  feeRecipientSats: number;
  vaultSats: number;
}

export interface MintPsbtResult {
  wallet: string;
  vaultAddress: string;
  vaultId: string;
  protocolPublicKey: string;
  protocolChainCode: string;
  oraclePublicKey: string;
  oracleChainCode: string;
  liquidationPublicKey: string;
  liquidationChainCode: string;
  descriptor: string;
  originalPsbt: string;
  patchedPsbt: string;
  rawTransactionHex: string;
  inputs: Array<{ txid: string; vout: number }>;
  changeOutput?: { address: string; amountBtc: string };
  collateralSats: number;
  rune: string;
  feeRate: number;
  ordinalsAddress: string;
  paymentAddress: string;
}

export interface AuctionPrepareRequest {
  vaultId: string;
  claimPriceSats: number;
  burnMetadata: string;
  feeRate: number;
  ordinals: AddressBinding;
  payment: AddressBinding;
}

export interface AuctionPrepareResponse {
  vaultId: string;
  psbt: string;
  burnMetadata: string;
  claimPriceSats: number;
  ordinalsAddress: string;
  paymentAddress: string;
  mintTxId: string;
  runeTxId: string;
  inputs: Array<{ txid: string; vout: number }>;
}

export interface AuctionFinalizeRequest {
  vaultId: string;
  psbt: string;
  claimantPaymentAddress: string;
  oracleSignature?: string;
  liquidationSignature?: string;
}
