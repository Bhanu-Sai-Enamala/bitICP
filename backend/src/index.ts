import express, { type NextFunction, type Request, type Response } from 'express';
import morgan from 'morgan';
import { config } from './config.js';
import mintRouter from './routes/mint.js';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', network: config.bitcoinNetworkFlag });
});

app.use('/mint', mintRouter);

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'UNHANDLED', message: err?.message ?? 'Unknown error' });
});

app.listen(config.port, () => {
  console.log(`Backend listening on port ${config.port}`);
});
