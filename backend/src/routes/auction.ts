import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { prepareAuctionClaim, finalizeAuctionClaim } from '../services/auctionService.js';

const router = Router();

router.use((req, res, next) => {
  if (config.apiKey) {
    const provided = req.header('x-api-key');
    if (!provided || provided !== config.apiKey) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
  }
  next();
});

const prepareSchema = z.object({
  vaultId: z.string().min(1),
  claimPriceSats: z.number().int().positive(),
  burnMetadata: z.string().min(1),
  feeRate: z.number().positive(),
  ordinals: z.object({
    address: z.string().min(1),
    addressType: z.string().min(1),
    publicKey: z.string().min(64)
  }),
  payment: z.object({
    address: z.string().min(1),
    addressType: z.string().min(1),
    publicKey: z.string().min(64)
  })
});

router.post('/prepare', async (req, res) => {
  const parsed = prepareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }
  try {
    const result = await prepareAuctionClaim(parsed.data);
    res.json(result);
  } catch (error: any) {
    console.error('[auction:prepare] error', { message: error?.message });
    res.status(500).json({ error: 'AUCTION_PREPARE_FAILED', message: error?.message });
  }
});

const finalizeSchema = z.object({
  vaultId: z.string().min(1),
  psbt: z.string().min(1),
  claimantPaymentAddress: z.string().min(1),
  oracleSignature: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, 'oracleSignature must be hex')
    .optional(),
  liquidationSignature: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, 'liquidationSignature must be hex')
    .optional()
});

router.post('/finalize', async (req, res) => {
  const parsed = finalizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }
  try {
    const result = await finalizeAuctionClaim(parsed.data);
    if (result.status === 'SIGNATURE_REQUIRED') {
      return res.status(202).json(result);
    }
    res.json(result);
  } catch (error: any) {
    console.error('[auction:finalize] error', { message: error?.message });
    res.status(500).json({ error: 'AUCTION_FINALIZE_FAILED', message: error?.message });
  }
});

export default router;
