import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { warmUserWallets } from '../services/mintService.js';
import { ensureWalletHasPaymentKey, verifyMessage } from '../utils/bitcoinCli.js';

const router = Router();

const challengeRequestSchema = z.object({
  ordinalsAddress: z.string().min(1),
  ordinalsPublicKey: z.string().regex(/^[0-9a-fA-F]{64}$/, 'ordinalsPublicKey must be 32-byte hex'),
  paymentAddress: z.string().min(1),
  paymentPublicKey: z.string().regex(/^[0-9a-fA-F]{66}$/, 'paymentPublicKey must be 33-byte compressed hex')
});

const verifyRequestSchema = z.object({
  challengeId: z.string().uuid(),
  signature: z.string().min(1)
});

type ChallengeRecord = z.infer<typeof challengeRequestSchema> & {
  id: string;
  issuedAt: number;
  expiresAt: number;
  message: string;
};

type SessionRecord = {
  token: string;
  ordinalsAddress: string;
  paymentAddress: string;
  createdAt: number;
  expiresAt: number;
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;

const challengeStore = new Map<string, ChallengeRecord>();
const sessionStore = new Map<string, SessionRecord>();

function cleanupExpired() {
  const now = Date.now();
  for (const [id, challenge] of challengeStore.entries()) {
    if (challenge.expiresAt <= now) {
      challengeStore.delete(id);
    }
  }
  for (const [token, session] of sessionStore.entries()) {
    if (session.expiresAt <= now) {
      sessionStore.delete(token);
    }
  }
}

router.post('/challenge', (req, res) => {
  const parsed = challengeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }
  cleanupExpired();
  const challengeId = crypto.randomUUID();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + CHALLENGE_TTL_MS;
  const message = [
    'Sign-In With Bitcoin',
    `Ordinals: ${parsed.data.ordinalsAddress}`,
    `Payment: ${parsed.data.paymentAddress}`,
    `Nonce: ${challengeId}`,
    `Issued-At: ${new Date(issuedAt).toISOString()}`
  ].join('\n');
  const record: ChallengeRecord = {
    ...parsed.data,
    id: challengeId,
    issuedAt,
    expiresAt,
    message
  };
  challengeStore.set(challengeId, record);
  res.json({
    challengeId,
    challenge: message,
    expiresAt
  });
});

router.post('/verify', async (req, res) => {
  const parsed = verifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'INVALID_REQUEST', details: parsed.error.flatten() });
  }
  cleanupExpired();
  const challenge = challengeStore.get(parsed.data.challengeId);
  if (!challenge) {
    return res.status(400).json({ error: 'CHALLENGE_NOT_FOUND' });
  }
  if (challenge.expiresAt <= Date.now()) {
    challengeStore.delete(parsed.data.challengeId);
    return res.status(400).json({ error: 'CHALLENGE_EXPIRED' });
  }
  try {
    await ensureWalletHasPaymentKey(config.siwbWallet, challenge.paymentPublicKey);
    const valid = await verifyMessage(
      config.siwbWallet,
      challenge.paymentAddress,
      parsed.data.signature,
      challenge.message
    ).catch((err: any) => {
      console.error('[auth:verify] verifymessage failed', err?.message ?? err);
      return false;
    });
    if (!valid) {
      console.warn('[auth:verify] invalid signature', {
        paymentAddress: challenge.paymentAddress
      });
      return res.status(400).json({ error: 'INVALID_SIGNATURE' });
    }
    challengeStore.delete(parsed.data.challengeId);
    const token = crypto.randomUUID();
    const createdAt = Date.now();
    const session: SessionRecord = {
      token,
      ordinalsAddress: challenge.ordinalsAddress,
      paymentAddress: challenge.paymentAddress,
      createdAt,
      expiresAt: createdAt + SESSION_TTL_MS
    };
    sessionStore.set(token, session);
    await warmUserWallets(
      challenge.paymentAddress,
      challenge.paymentPublicKey,
      challenge.ordinalsPublicKey
    );
    res.json({
      token,
      expiresAt: session.expiresAt,
      ordinalsAddress: challenge.ordinalsAddress,
      paymentAddress: challenge.paymentAddress
    });
  } catch (error: any) {
    console.error('[auth:verify] error', { message: error?.message });
    res.status(500).json({ error: 'VERIFY_FAILED', message: error?.message });
  }
});

router.get('/session/:token', (req, res) => {
  cleanupExpired();
  const session = sessionStore.get(req.params.token);
  if (!session) {
    return res.status(404).json({ error: 'SESSION_NOT_FOUND' });
  }
  res.json(session);
});

export default router;
