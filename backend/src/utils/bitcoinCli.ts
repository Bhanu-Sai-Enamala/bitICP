import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export interface CliOptions {
  wallet?: string;
}

function buildCliArgs(args: string[], wallet?: string): string[] {
  const cliArgs: string[] = [];
  if (config.bitcoinNetworkFlag) {
    cliArgs.push(config.bitcoinNetworkFlag);
  }
  if (wallet) {
    cliArgs.push(`-rpcwallet=${wallet}`);
  }
  cliArgs.push(...args);
  return cliArgs;
}

async function execCli(cliArgs: string[]): Promise<string> {
  const cmdString = [config.bitcoinCliPath, ...cliArgs].join(' ');
  console.info('[bitcoin-cli] executing', cmdString);
  try {
    const { stdout } = await execFileAsync(config.bitcoinCliPath, cliArgs, {
      encoding: 'utf8',
      env: process.env
    });
    return stdout.trim();
  } catch (error: any) {
    const stdout = error?.stdout?.trim();
    const stderr = error?.stderr?.trim();
    const message =
      `${stderr || stdout || error?.message || 'bitcoin-cli failed'}\ncmd: ${cmdString}`;
    const err = new Error(message);
    (err as any).stdout = stdout;
    (err as any).stderr = stderr;
    throw err;
  }
}

function needsWalletRecovery(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('requested wallet does not exist') ||
    lower.includes('wallet file verification failed') ||
    lower.includes('invalid wallet specified') ||
    lower.includes('wallet is not loaded') ||
    lower.includes('wallet does not exist') ||
    lower.includes('wallet file not found')
  );
}

async function recoverWallet(wallet: string): Promise<void> {
  console.warn('[bitcoin-cli] attempting wallet recovery', { wallet });
  try {
    await execCli(buildCliArgs(['loadwallet', wallet]));
    console.info('[bitcoin-cli] wallet loaded automatically', { wallet });
    return;
  } catch (error: any) {
    const message = (error?.message ?? '').toLowerCase();
    if (
      message.includes('duplicate -wallet filename specified') ||
      message.includes('already loaded')
    ) {
      console.info('[bitcoin-cli] wallet already loaded', { wallet });
      return;
    }
    if (needsWalletRecovery(message)) {
      await execCli(
        buildCliArgs(
          ['createwallet', wallet, 'true', 'true', '', 'false', 'true', 'false'],
          undefined
        )
      );
      console.info('[bitcoin-cli] wallet created automatically', { wallet });
      await execCli(buildCliArgs(['rescanblockchain'], wallet));
      console.info('[bitcoin-cli] rescan completed for wallet', { wallet });
      return;
    }
    throw error;
  }
}

async function runCliRaw(
  args: string[],
  { wallet }: CliOptions = {},
  retry = true
): Promise<string> {
  const cliArgs = buildCliArgs(args, wallet);
  try {
    return await execCli(cliArgs);
  } catch (error: any) {
    const message = error?.message ?? '';
    if (wallet && retry && needsWalletRecovery(message)) {
      await recoverWallet(wallet);
      return runCliRaw(args, { wallet }, false);
    }
    throw error;
  }
}

export async function runCliJson<T>(
  args: string[],
  options: CliOptions = {}
): Promise<T> {
  const output = await runCliRaw(args, options);
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new Error(`Failed to parse bitcoin-cli JSON output: ${output}`);
  }
}

export { runCliRaw };
