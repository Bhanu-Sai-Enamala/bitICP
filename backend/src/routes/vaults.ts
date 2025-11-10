import { Router } from 'express';
import { config } from '../config.js';
import { vaultStore } from '../services/vaultStore.js';

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

router.get('/', async (req, res) => {
  const payment = String(req.query.payment ?? '').trim();
  if (!payment) {
    return res.status(400).json({ error: 'MISSING_PAYMENT' });
  }

  try {
    const entries = await vaultStore.listVaultsByPayment(payment);
    res.json({ paymentAddress: payment, vaults: entries });
  } catch (error: any) {
    console.error('[vaults:list] failed', { message: error?.message });
    res.status(500).json({ error: 'VAULT_LIST_FAILED', message: error?.message });
  }
});

export default router;
