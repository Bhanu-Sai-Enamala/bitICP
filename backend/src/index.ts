import express, { type NextFunction, type Request, type Response } from 'express';
import morgan from 'morgan';
import { config } from './config.js';
import mintRouter from './routes/mint.js';
import vaultRouter from './routes/vaults.js';
import withdrawRouter from './routes/withdraw.js';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'content-type,x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', network: config.bitcoinNetworkFlag });
});

app.use('/mint', mintRouter);
app.use('/vaults', vaultRouter);
app.use('/withdraw', withdrawRouter);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'UNHANDLED', message: err?.message ?? 'Unknown error' });
});

app.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});
