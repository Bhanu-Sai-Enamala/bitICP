import { Router } from 'express';
import { z } from 'zod';
import { buildMintPsbt } from '../services/mintService.js';
import { MintRequestBody } from '../types.js';
import { config } from '../config.js';
import { runCliJson, runCliRaw } from '../utils/bitcoinCli.js';

const router = Router();

const hexCompressed33 = /^[0-9a-fA-F]{66}$/; // 33-byte compressed (02/03 + 32 bytes)
const hexXOnly32 = /^[0-9a-fA-F]{64}$/;      // 32-byte x-only (taproot internal key)
const hexChainCode32 = /^[0-9a-fA-F]{64}$/;  // 32-byte chain code

const addressBindingSchema = z
  .object({
    address: z.string().min(1),
    addressType: z.string().min(1),
    publicKey: z.string().min(64)
  })
  .superRefine((v, ctx) => {
    const t = v.addressType.toLowerCase();
    if (t === 'p2tr') {
      if (!hexXOnly32.test(v.publicKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'expected 32-byte x-only pubkey for p2tr'
        });
      }
    } else {
      if (!hexCompressed33.test(v.publicKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'expected 33-byte compressed pubkey'
        });
      }
    }
  });

const mintRequestSchema = z.object({
  rune: z.string().min(1),
  feeRate: z.number().positive(),
  feeRecipient: z.string().min(1),
  ordinals: addressBindingSchema,
  payment: addressBindingSchema,
  vaultId: z.string().regex(/^[0-9]+$/, 'vaultId must be a decimal string'),
  protocolPublicKey: z
    .string()
    .regex(hexXOnly32, 'protocolPublicKey must be 32-byte x-only hex')
    .transform((v) => v.toLowerCase()),
  protocolChainCode: z
    .string()
    .regex(hexChainCode32, 'protocolChainCode must be 32-byte hex')
    .transform((v) => v.toLowerCase()),
  amounts: z
    .object({
      ordinalsSats: z.number().int().positive(),
      feeRecipientSats: z.number().int().positive(),
      vaultSats: z.number().int().positive()
    })
    .partial()
    .nullish()
});

router.use((req, res, next) => {
  if (config.apiKey) {
    const provided = req.header('x-api-key');
    if (!provided || provided !== config.apiKey) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
  }
  next();
});

router.post('/build-psbt', async (req, res) => {
  const parseResult = mintRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    console.warn('[mint:build-psbt] validation failure', parseResult.error.format());
    return res.status(400).json({
      error: 'INVALID_REQUEST',
      details: parseResult.error.flatten()
    });
  }

  try {
    const parsed = parseResult.data;
    const payload: MintRequestBody = {
      ...parsed,
      amounts: parsed.amounts ?? undefined
    };
    console.info('[mint:build-psbt] request accepted', {
      rune: payload.rune,
      feeRate: payload.feeRate,
      ordinalsAddress: payload.ordinals.address,
      paymentAddress: payload.payment.address,
      amountsProvided: Boolean(payload.amounts),
      vaultId: payload.vaultId
    });
    const result = await buildMintPsbt(payload);
    console.info('[mint:build-psbt] psbt built', {
      wallet: result.wallet,
      vaultAddress: result.vaultAddress,
      inputs: result.inputs.length
    });
    res.json({
      rune: payload.rune,
      feeRate: payload.feeRate,
      result
    });
  } catch (error: any) {
    console.error('[mint:build-psbt] error', {
      message: error?.message,
      stdout: error?.stdout,
      stderr: error?.stderr
    });
    res.status(500).json({
      error: 'BITCOIN_CLI_ERROR',
      message: error?.message,
      stdout: error?.stdout,
      stderr: error?.stderr
    });
  }
});

export default router;

// --- finalize & broadcast ---
const finalizeVaultSchema = z.object({
  vaultAddress: z.string().min(1),
  protocolPublicKey: z.string().min(1),
  protocolChainCode: z.string().min(1),
  descriptor: z.string().min(1),
  collateralSats: z.number().int().nonnegative(),
  rune: z.string().min(1),
  feeRate: z.number().positive(),
  ordinalsAddress: z.string().min(1),
  paymentAddress: z.string().min(1),
  mintTokens: z.number().positive(),
  mintUsdCents: z.number().int().positive(),
  btcPriceUsd: z.number().positive(),
});

const finalizeSchema = z.object({
  wallet: z.string().min(1),
  psbt: z.string().min(1), // base64
  vaultId: z.string().min(1),
  broadcast: z.boolean().optional().default(true),
  vault: finalizeVaultSchema.optional(),
});

router.post('/finalize', async (req, res) => {
  const parsed = finalizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }
  const { wallet, psbt, vaultId, broadcast, vault } = parsed.data;
  try {
    // Try JSON style first
    let hex: string | undefined;
    let complete = false;
    try {
      const j = await runCliJson<{ psbt: string; hex: string; complete: boolean }>(
        ['finalizepsbt', psbt],
        { wallet }
      );
      hex = j.hex;
      complete = j.complete;
    } catch (_e) {
      // Fallback: extract=true returns hex string in some versions
      const out = await runCliRaw(['finalizepsbt', psbt, 'true'], { wallet });
      hex = out.trim();
      complete = true;
    }

    if (!hex || !complete) {
      return res.status(400).json({ error: 'FINALIZE_INCOMPLETE', complete, hex });
    }

    let txid: string | undefined;
    try {
      const decoded = await runCliJson<{ txid: string }>(['decoderawtransaction', hex]);
      txid = decoded.txid;
    } catch (error: any) {
      console.warn('[mint:finalize] decoderawtransaction failed', {
        message: error?.message
      });
    }

    res.json({ vaultId, hex, complete, txid: txid ?? null });
  } catch (error: any) {
    console.error('[mint:finalize] error', { message: error?.message, stdout: error?.stdout, stderr: error?.stderr });
    res.status(500).json({ error: 'FINALIZE_FAILED', message: error?.message, stdout: error?.stdout, stderr: error?.stderr });
  }
});
