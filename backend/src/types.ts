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
  amounts?: Partial<MintOutputAmounts>;
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
  descriptor: string;
  originalPsbt: string;
  patchedPsbt: string;
  rawTransactionHex: string;
  inputs: Array<{ txid: string; vout: number }>;
  changeOutput?: { address: string; amountBtc: string };
}
