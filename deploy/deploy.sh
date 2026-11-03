#!/usr/bin/env bash
# Converges this host's effect-pi to deploy/.env: builds every image, starts the server and the console, makes sure a
# first account exists before anything is exposed, turns the chosen exposures on, and checks the result through the
# edge. Safe to rerun; docs/deploy/README.md explains the choices.
set -euo pipefail

cd "$(dirname "$0")"

die() {
  echo "deploy: $*" >&2
  exit 1
}

expose_without_account=false
case "${1:-}" in
  "") ;;
  --expose-without-account) expose_without_account=true ;;
  *) die "usage: deploy/deploy.sh [--expose-without-account]" ;;
esac

[[ -f .env ]] || die "deploy/.env is missing (EXPOSURE, DOCKER_GID, ...); see docs/deploy/README.md"
[[ -f ../.env ]] || die "the repository's .env is missing (PUBLIC_URL, the model, ...); see docs/deploy/README.md"
set -a
# shellcheck source=/dev/null
source .env
set +a

IFS=',' read -r -a exposures <<<"${EXPOSURE:-}"
((${#exposures[@]} > 0)) || die "set EXPOSURE in deploy/.env to one or more of lan, tailscale, cloudflare"
has() {
  local exposure
  for exposure in "${exposures[@]}"; do
    [[ $exposure == "$1" ]] && return 0
  done
  return 1
}
for exposure in "${exposures[@]}"; do
  case "$exposure" in
    lan | tailscale | cloudflare) ;;
    *) die "unknown exposure '$exposure' in EXPOSURE (lan, tailscale, cloudflare)" ;;
  esac
done

# The edge listens on every interface only for the lan; the other exposures reach it on loopback.
if has lan; then
  export EDGE_BIND="0.0.0.0 ::" EDGE_PORT="${LAN_PORT:-80}"
else
  export EDGE_BIND="127.0.0.1" EDGE_PORT="${EDGE_PORT:-8080}"
fi

public_urls=$(sed -n 's/^PUBLIC_URL=//p' ../.env | tail -n 1 | tr -d "\"'")
IFS=',' read -r -a urls <<<"$public_urls"
any_url() {
  local url
  for url in "${urls[@]}"; do
    [[ $url =~ $1 ]] && return 0
  done
  return 1
}
if has lan; then
  any_url '^http://' || die "the lan exposure needs an http:// URL in PUBLIC_URL (the LAN address people type)"
fi
if has tailscale; then
  any_url '^https://[^/]+\.ts\.net/?$' || die "the tailscale exposure needs the machine's https://<name>.ts.net in PUBLIC_URL"
  command -v tailscale >/dev/null || die "the tailscale exposure needs tailscale on this host"
fi
if has cloudflare; then
  tunnel_url=false
  for url in "${urls[@]}"; do
    [[ $url =~ ^https:// && ! $url =~ \.ts\.net/?$ ]] && tunnel_url=true
  done
  [[ $tunnel_url == true ]] || die "the cloudflare exposure needs the tunnel's https:// hostname in PUBLIC_URL"
  [[ -n ${CLOUDFLARE_TUNNEL:-} ]] || die "the cloudflare exposure needs CLOUDFLARE_TUNNEL (the tunnel's id) in deploy/.env"
  [[ -f .cloudflared/credentials.json ]] || die "the cloudflare exposure needs deploy/.cloudflared/credentials.json"
fi

# Unchanged images keep their ids (no provenance attestations with a build timestamp): `up` leaves their containers
# alone, and Software images, tagged by their base image's id, stay valid.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1
echo "deploy: building images"
COMPOSE_PROFILES=build docker compose build

echo "deploy: starting the server and the console"
docker compose up -d --wait server web

if curl -fsS http://127.0.0.1:4000/api/auth/state | grep -q '"setup":true'; then
  echo "deploy: no account exists yet: whoever opens the site first can create it and own this server." >&2
  if [[ $expose_without_account == false ]]; then
    [[ -t 0 ]] || die "no account; rerun in a terminal to create one, or pass --expose-without-account"
    read -r -p "[c]reate the account now, [e]xpose anyway, or [a]bort? " choice
    case "$choice" in
      c | C)
        read -r -p "Account name: " name
        docker compose exec server node user.ts add "$name"
        ;;
      e | E) ;;
      *) die "aborted: the server and the console are up on loopback; nothing is exposed" ;;
    esac
  fi
fi

echo "deploy: exposing through ${exposures[*]} (edge on ${EDGE_BIND// /,} port $EDGE_PORT)"
if has cloudflare; then
  export COMPOSE_PROFILES=cloudflare
else
  docker compose rm --stop --force cloudflared >/dev/null 2>&1 || true
fi
docker compose up -d --wait --remove-orphans

if has tailscale; then
  tailscale serve --bg --https=443 "http://127.0.0.1:$EDGE_PORT" >/dev/null ||
    die "tailscale serve failed; run 'sudo tailscale set --operator=\$USER' once, and turn on HTTPS certificates for the tailnet"
fi

echo "deploy: checking every PUBLIC_URL host through the edge"
failed=0
check() {
  local host=$1 path=$2 want=$3 got
  got=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "Host: $host" "http://127.0.0.1:$EDGE_PORT$path") || true
  if [[ $got == "$want" ]]; then
    echo "  ok    $host$path $got"
  else
    echo "  FAIL  $host$path: got $got, want $want" >&2
    failed=1
  fi
}
for url in "${urls[@]}"; do
  host=${url#*://}
  host=${host%%/*}
  check "$host" /login 200
  check "$host" /api/auth/state 200
  # The socket route reaches the server, which refuses it without a session.
  check "$host" /api/conversations/0/shell 401
done
((failed == 0)) || die "the deploy is up but some checks failed"
echo "deploy: done"
