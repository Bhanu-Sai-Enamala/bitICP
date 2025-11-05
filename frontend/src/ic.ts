import { Actor, HttpAgent } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import { Buffer } from 'buffer';

import { idlFactory as stablecoinIdl } from './declarations/stablecoin';
import type { _SERVICE as StablecoinService } from './declarations/stablecoin';

import { getCanisterId } from './canisterIds';

const globalAny = globalThis as typeof globalThis & { global?: typeof globalThis; Buffer?: typeof Buffer };
if (typeof globalAny.global === 'undefined') {
  globalAny.global = globalAny;
}
if (typeof globalAny.Buffer === 'undefined') {
  globalAny.Buffer = Buffer;
}

const network = (import.meta.env.VITE_DFX_NETWORK ?? 'local') as 'local' | 'ic';
const host = import.meta.env.VITE_IC_HOST ?? 'http://127.0.0.1:4943';

async function createAgent() {
  const agent = new HttpAgent({ host });
  if (network === 'local') {
    await agent.fetchRootKey();
  }
  return agent;
}

export async function stablecoinActor() {
  const agent = await createAgent();
  const canisterId = await getCanisterId('stablecoin', network);
  return Actor.createActor<StablecoinService>(stablecoinIdl, {
    agent,
    canisterId: Principal.fromText(canisterId)
  });
}
