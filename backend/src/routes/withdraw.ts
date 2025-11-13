import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import {
  prepareWithdraw,
  requestProtocolSignature,
  finalizeWithdrawPsbt
} from '../services/withdrawService.js';

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
  burnMetadata: z.string().optional(),
});

router.post('/prepare', async (req, res) => {
  const parsed = prepareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }
  try {
    const result = await prepareWithdraw(parsed.data.vaultId, parsed.data.burnMetadata);
    res.json(result);
  } catch (error: any) {
    console.error('[withdraw:prepare] error', { message: error?.message });
    res.status(500).json({ error: 'WITHDRAW_PREPARE_FAILED', message: error?.message });
  }
});

const finalizeSchema = z.object({
  vaultId: z.string().min(1),
  psbt: z.string().min(1),
  protocolSignature: z
    .string()
    .regex(/^[0-9a-fA-F]+$/, 'protocolSignature must be a hex string')
    .optional(),
  broadcast: z.boolean().optional().default(true)
});

router.post('/finalize', async (req, res) => {
  const parsed = finalizeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }

  const { vaultId, psbt, protocolSignature, broadcast } = parsed.data;
  console.info('[withdraw] finalize request', {
    vaultId,
    psbtLength: psbt.length,
    psbt,
    hasProtocolSignature: Boolean(protocolSignature),
    broadcast
  });
  try {
    if (!protocolSignature) {
      const prompt = await requestProtocolSignature(vaultId, psbt);
      return res.status(202).json({
        status: 'SIGNATURE_REQUIRED',
        ...prompt
      });
    }

    const result = await finalizeWithdrawPsbt(vaultId, psbt, protocolSignature, broadcast);
    return res.json({
      status: 'FINALIZED',
      ...result
    });
  } catch (error: any) {
    console.error('[withdraw:finalize] error', { message: error?.message });
    res.status(500).json({ error: 'WITHDRAW_FINALIZE_FAILED', message: error?.message });
  }
});

export default router;
