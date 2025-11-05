import ids from './declarations/canister_ids.local.json';

type IdMap = Record<string, Record<string, string>>;

export async function getCanisterId(name: string, network: string = 'local'): Promise<string> {
  const map = ids as IdMap;
  const entry = map[name];
  if (!entry) {
    throw new Error(`Missing canister id entry for ${name}`);
  }
  const id = entry[network] ?? entry.local;
  if (!id) {
    throw new Error(`Missing canister id for ${name} on network ${network}`);
  }
  return id;
}
