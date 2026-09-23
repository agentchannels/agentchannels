#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

project=agentchannels-relay-verify
origin=http://127.0.0.1:8787
export AGENTCHANNELS_RELAY_ORIGIN=$origin

compose() {
  docker compose -p "$project" -f compose.yml -f compose.build.yml "$@"
}

cleanup() {
  compose down --volumes >/dev/null 2>&1 || true
  rm -rf secrets
}
trap cleanup EXIT

wait_until_listening() {
  for _ in $(seq 1 120); do
    curl -s -o /dev/null "$origin/" && return 0
    sleep 0.25
  done
  echo "relay did not start listening" >&2
  compose logs relay >&2
  return 1
}

public_key() {
  bun -e 'const { generateKeyPairSync } = require("node:crypto");
console.log(generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));'
}

enroll() {
  local authorization=$1 key=$2
  curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'content-type: application/json' \
    ${authorization:+-H "authorization: $authorization"} \
    -d "{\"installationId\":\"in_verify\",\"publicKeyBase64\":\"$key\"}" \
    "$origin/v1/installations"
}

expect() {
  local label=$1 wanted=$2 actual=$3
  if [ "$actual" != "$wanted" ]; then
    echo "$label: expected $wanted, got $actual" >&2
    return 1
  fi
  echo "$label: $actual"
}

install -d -m 700 secrets
openssl rand -hex 32 > secrets/relay-enrollment-token
chmod 644 secrets/relay-enrollment-token
token=$(cat secrets/relay-enrollment-token)

compose up --build --detach --quiet-pull
wait_until_listening

key=$(public_key)
expect "enrollment without a token" 401 "$(enroll "" "$key")"
expect "enrollment with a wrong token" 401 "$(enroll "Bearer wrong" "$key")"
expect "enrollment with the token" 200 "$(enroll "Bearer $token" "$key")"

container=$(compose ps -q relay)
expect "hardening" '10001:10001 true ["ALL"] ["no-new-privileges:true"]' \
  "$(docker inspect --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}' "$container")"
expect "process identity" "10001 10001" \
  "$(docker exec "$container" sh -c 'echo "$(id -u) $(id -g)"')"

compose restart relay >/dev/null
wait_until_listening
expect "a different key after restart" 409 "$(enroll "Bearer $token" "$(public_key)")"
