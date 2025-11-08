import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

export interface CliOptions {
  wallet?: string;
}

async function runCliRaw(
  args: string[],
  { wallet }: CliOptions = {}
): Promise<string> {
  const cliArgs: string[] = [];
  if (config.bitcoinNetworkFlag) {
    cliArgs.push(config.bitcoinNetworkFlag);
  }
  if (wallet) {
    cliArgs.push(`-rpcwallet=${wallet}`);
  }
  cliArgs.push(...args);

  try {
    const { stdout } = await execFileAsync(config.bitcoinCliPath, cliArgs, {
      encoding: 'utf8',
      env: process.env
    });
    return stdout.trim();
  } catch (error: any) {
    const stdout = error?.stdout?.trim();
    const stderr = error?.stderr?.trim();
    const message = `${stderr || stdout || error?.message || 'bitcoin-cli failed'}\ncmd: ${[config.bitcoinCliPath, ...cliArgs].join(' ')}`;
    const err = new Error(message);
    (err as any).stdout = stdout;
    (err as any).stderr = stderr;
    throw err;
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
