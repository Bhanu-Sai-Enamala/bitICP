import { Actor, HttpAgent } from "@dfinity/agent";

// Imports and re-exports candid interface
// Use service.did.js which is what `dfx generate` emitted in this setup
import { idlFactory } from './service.did.js';
export { idlFactory } from './service.did.js';
// CANISTER_ID sourced from Vite env (browser) or process.env (Node)
const viteCanisterId = typeof import.meta !== 'undefined' ? import.meta.env?.VITE_CANISTER_ID_STABLECOIN : undefined;
export const canisterId = viteCanisterId ?? (typeof process !== 'undefined' ? process.env.CANISTER_ID_STABLECOIN : undefined);

/**
 * @deprecated since dfx 0.11.1
 * Do not import from `.dfx`, instead switch to using `dfx generate` to generate your JS interface.
 * @param {string | import("@dfinity/principal").Principal} canisterId Canister ID of Agent
 * @param {{agentOptions?: import("@dfinity/agent").HttpAgentOptions; actorOptions?: import("@dfinity/agent").ActorConfig} | { agent?: import("@dfinity/agent").Agent; actorOptions?: import("@dfinity/agent").ActorConfig }} [options]
 * @return {import("@dfinity/agent").ActorSubclass<import("./service.did.js")._SERVICE>}
 */
export const createActor = (canisterId, options = {}) => {
  console.warn(`Deprecation warning: you are currently importing code from .dfx. Going forward, refactor to use the dfx generate command for JavaScript bindings.

See https://internetcomputer.org/docs/current/developer-docs/updates/release-notes/ for migration instructions`);
  const agent = options.agent || new HttpAgent({ ...options.agentOptions });

  // Detect network in both Vite (browser) and Node
  const isIcNetwork = (() => {
    if (typeof import.meta !== 'undefined' && import.meta.env) {
      return import.meta.env.VITE_DFX_NETWORK === 'ic';
    }
    if (typeof process !== 'undefined' && process.env) {
      return process.env.DFX_NETWORK === 'ic';
    }
    return false;
  })();

  // Fetch root key for certificate validation during local development
  if (!isIcNetwork) {
    agent.fetchRootKey().catch(err => {
      console.warn("Unable to fetch root key. Check to ensure that your local replica is running");
      console.error(err);
    });
  }

  // Creates an actor with using the candid interface and the HttpAgent
  return Actor.createActor(idlFactory, {
    agent,
    canisterId,
    ...(options ? options.actorOptions : {}),
  });
};
  
/**
 * A ready-to-use agent for the stablecoin canister
 * @type {import("@dfinity/agent").ActorSubclass<import("./service.did.js")._SERVICE>}
 */
export const stablecoin = createActor(canisterId);
