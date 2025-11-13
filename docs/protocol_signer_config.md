## Protocol signer configuration

To keep protocol signatures stable across redeploys, record the exact
configuration used for deriving Schnorr keys:

- **Management canister ID:** `aaaaa-aa`
- **Management key name:** `dfx_test_key`

Vault IDs are now generated from the current IC timestamp, so even after a
redeploy the next minted vault receives a new, globally unique identifier.
There is no need to restore the old counter; just redeploy and continue minting.

If you ever point the canister at a different management canister ID
(`for_test_only_change_management_canister_id`) or choose a different key name,
update the values here so you can reapply them immediately after redeploying.
