#!/usr/bin/env bash
set -euo pipefail

# Utility script to bootstrap a full local stack:
# 1. Stops any running dfx replica and starts a clean local replica.
# 2. Deploys the XRC canister (either by reusing an existing canister id or by
#    running `dfx deploy` inside a local XRC workspace).
# 3. Builds & deploys the stablecoin canister from this repo.
# 4. Configures the stablecoin canister with backend, fee, and protocol params.
#
# Configuration sources (evaluated in this order):
#   - Optional env file pointed to by LOCAL_STACK_ENV (default: scripts/local-stack.env)
#   - Environment variables already exported in the shell
# Required values:
#   LOCAL_BACKEND_URL (https URL that points to your backend)
#   LOCAL_FEE_RECIPIENT_ADDRESS (Bitcoin address used for fee output)
#   Either LOCAL_XRC_CANISTER_ID or LOCAL_XRC_WORKSPACE (path to cloned XRC repo)
#
# Optional values (with defaults shown):
#   LOCAL_BACKEND_API_KEY=""
#   LOCAL_ORDINALS_SATS=1000
#   LOCAL_FEE_RECIPIENT_SATS=1000
#   LOCAL_RUNE_OP_RETURN="00dde905020a00"
#   LOCAL_PROTOCOL_GUARDIAN_KEY (defaults to backend/.env example)
#   LOCAL_PROTOCOL_VAULT_KEY_A (defaults to backend/.env example)
#   LOCAL_PROTOCOL_VAULT_KEY_B (defaults to backend/.env example)
#   LOCAL_COLLATERAL_RATIO_BPS=13000
#   LOCAL_COLLATERAL_USD_CENTS=2000
#   LOCAL_BROADCAST_MINT=0   (set to 1 to have backend broadcast mints)
#   LOCAL_BROADCAST_WITHDRAW=0 (set to 1 to have backend broadcast withdraws)
#   DFX_NETWORK=local
#   XRC_DEPLOY_EXTRA_ARGS="" (passed to `dfx deploy` inside XRC workspace)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE_DEFAULT="${ROOT_DIR}/scripts/local-stack.env"
ENV_FILE="${LOCAL_STACK_ENV:-$ENV_FILE_DEFAULT}"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

DFX_NETWORK="${DFX_NETWORK:-local}"
BACKEND_URL="${LOCAL_BACKEND_URL:-${BACKEND_URL:-}}"
BACKEND_API_KEY="${LOCAL_BACKEND_API_KEY:-${BACKEND_API_KEY:-}}"
ORDINALS_SATS="${LOCAL_ORDINALS_SATS:-1000}"
FEE_RECIPIENT_SATS="${LOCAL_FEE_RECIPIENT_SATS:-1000}"
FEE_RECIPIENT_ADDRESS="${LOCAL_FEE_RECIPIENT_ADDRESS:-}"
RUNE_OP_RETURN="${LOCAL_RUNE_OP_RETURN:-14dde9051402}"
COLLATERAL_RATIO_BPS="${LOCAL_COLLATERAL_RATIO_BPS:-13000}"
COLLATERAL_USD_CENTS="${LOCAL_COLLATERAL_USD_CENTS:-2000}"
PROTOCOL_GUARDIAN_KEY="${LOCAL_PROTOCOL_GUARDIAN_KEY:-03b24f7ae21c41df53bb95f138440c1b396404f1da2aa824821720d223685ed7f1}"
PROTOCOL_VAULT_KEY_A="${LOCAL_PROTOCOL_VAULT_KEY_A:-0265f4ca4c628565963028803861eef79ff19f49223822e9bdfc49532148e79363}"
PROTOCOL_VAULT_KEY_B="${LOCAL_PROTOCOL_VAULT_KEY_B:-03cb4d09e437d2a3497d6507fe62f66f668c9c647d4ea9ffb02c8845c5c53ce663}"
BROADCAST_MINT="${LOCAL_BROADCAST_MINT:-0}"
BROADCAST_WITHDRAW="${LOCAL_BROADCAST_WITHDRAW:-0}"
XRC_CANISTER_ID="${LOCAL_XRC_CANISTER_ID:-${XRC_CANISTER_ID:-}}"
XRC_WORKSPACE="${LOCAL_XRC_WORKSPACE:-${XRC_WORKSPACE:-}}"
XRC_DEPLOY_EXTRA_ARGS="${XRC_DEPLOY_EXTRA_ARGS:-}"

log() {
  printf '[local-stack] %s\n' "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_nonempty() {
  local value="$1"
  local label="$2"
  if [[ -z "$value" ]]; then
    echo "Missing required value: $label" >&2
    exit 1
  }
}

bool_from_flag() {
  case "${1:-0}" in
    1|true|TRUE|yes|YES|on|ON) echo "true" ;;
    *) echo "false" ;;
  esac
}

wait_for_replica() {
  local retries=30
  for ((i=0; i<retries; i++)); do
    if dfx ping "$DFX_NETWORK" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "dfx replica did not become ready after $retries seconds" >&2
  exit 1
}

deploy_xrc_if_needed() {
  if [[ -n "$XRC_CANISTER_ID" ]]; then
    log "Using provided XRC canister id: $XRC_CANISTER_ID"
    return 0
  fi
  require_nonempty "$XRC_WORKSPACE" "LOCAL_XRC_WORKSPACE"
  if [[ ! -d "$XRC_WORKSPACE" ]]; then
    echo "XRC workspace directory not found: $XRC_WORKSPACE" >&2
    exit 1
  fi
  log "Deploying XRC canister from $XRC_WORKSPACE"
  pushd "$XRC_WORKSPACE" >/dev/null
  DFX_NETWORK="$DFX_NETWORK" dfx deploy $XRC_DEPLOY_EXTRA_ARGS
  XRC_CANISTER_ID="$(DFX_NETWORK="$DFX_NETWORK" dfx canister id xrc)"
  popd >/dev/null
  log "XRC canister deployed with id $XRC_CANISTER_ID"
}

configure_stablecoin() {
  local api_key_arg
  if [[ -n "$BACKEND_API_KEY" ]]; then
    api_key_arg="opt \"$BACKEND_API_KEY\""
  else
    api_key_arg="null"
  fi

  local mint_bool withdraw_bool
  mint_bool="$(bool_from_flag "$BROADCAST_MINT")"
  withdraw_bool="$(bool_from_flag "$BROADCAST_WITHDRAW")"

  log "Configuring stablecoin canister"
  dfx canister --network "$DFX_NETWORK" call stablecoin \
    set_local_testing_mode "(true)" >/dev/null

  dfx canister --network "$DFX_NETWORK" call stablecoin \
    set_backend_config "(\"$BACKEND_URL\", $api_key_arg)" >/dev/null

  dfx canister --network "$DFX_NETWORK" call stablecoin \
    set_backend_broadcast_mode "($mint_bool, $withdraw_bool)" >/dev/null

  dfx canister --network "$DFX_NETWORK" call stablecoin \
    set_fee_config "($ORDINALS_SATS : nat64, $FEE_RECIPIENT_SATS : nat64, \"$FEE_RECIPIENT_ADDRESS\", \"$RUNE_OP_RETURN\")" >/dev/null

  dfx canister --network "$DFX_NETWORK" call stablecoin \
    set_protocol_keys "(\"$PROTOCOL_GUARDIAN_KEY\", \"$PROTOCOL_VAULT_KEY_A\", \"$PROTOCOL_VAULT_KEY_B\")" >/dev/null

  dfx canister --network "$DFX_NETWORK" call stablecoin \
    set_collateral_params "($COLLATERAL_RATIO_BPS : nat16, $COLLATERAL_USD_CENTS : nat32)" >/dev/null

  dfx canister --network "$DFX_NETWORK" call stablecoin \
    set_xrc_config "(principal \"$XRC_CANISTER_ID\")" >/dev/null
}

main() {
  require_cmd dfx

  require_nonempty "$BACKEND_URL" "LOCAL_BACKEND_URL"
  require_nonempty "$FEE_RECIPIENT_ADDRESS" "LOCAL_FEE_RECIPIENT_ADDRESS"

  log "Stopping any running dfx replica"
  dfx stop >/dev/null 2>&1 || true

  log "Starting local replica (network=$DFX_NETWORK)"
  dfx start --background --clean >/dev/null
  wait_for_replica

  deploy_xrc_if_needed

  log "Deploying stablecoin canister"
  pushd "$ROOT_DIR" >/dev/null
  dfx deploy --network "$DFX_NETWORK" stablecoin >/dev/null
  popd >/dev/null

  configure_stablecoin

  log "Local stack ready"
  log "Backend URL: $BACKEND_URL"
  log "XRC canister id: $XRC_CANISTER_ID"
}

main "$@"
