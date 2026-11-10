#!/usr/bin/env bash
# Installs or updates automation-server on a Linux VPS with Docker Compose.
#
#   curl -fsSL https://raw.githubusercontent.com/prlct/automation-server/main/scripts/deploy-vps.sh | sudo bash
#   sudo ./scripts/deploy-vps.sh            # from a checkout
#
# While the repository is private, raw.githubusercontent.com needs a token too, and so does the clone:
#   curl -fsSL -H "Authorization: Bearer $TOKEN" https://raw.githubusercontent.com/prlct/automation-server/main/scripts/deploy-vps.sh \
#     | sudo REPO_TOKEN="$TOKEN" GHCR_USER=<github-user> bash
#
# First run asks for the settings and writes .env. Later runs update and restart, keeping .env.
# Every prompt can be answered ahead with an environment variable of the same name, for example
# GITHUB_TOKEN=... SENTRY_CLIENT_SECRET=... sudo -E ./scripts/deploy-vps.sh
#
# How to deploy, DEPLOY_MODE:
#   image  pull the prebuilt image that CI publishes to ghcr.io (fast, runs on 512 MB RAM)
#   build  build the image on this server (needs about 1 GB RAM)
# It is asked on the first run, defaults to build without a terminal, and can be set on a later
# run to switch an existing install. IMAGE and IMAGE_TAG choose which image to pull, for example
# IMAGE_TAG=sha-1a2b3c4 to pin or roll back. GHCR_USER and GHCR_TOKEN (a classic token with
# read:packages) log in to the registry when the package is private.
#
# REPO_TOKEN clones and updates a private repository. It falls back to GHCR_TOKEN, so one classic
# token with the repo and read:packages scopes covers both. It is sent in a request header and is
# not stored in .git/config.
#
# Overrides: INSTALL_DIR (default /opt/automation-server), REPO_URL, BRANCH (default main),
# SKIP_DOCKER_INSTALL=1, SKIP_FIREWALL=1.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/prlct/automation-server.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/automation-server}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# /dev/tty exists without a terminal behind it (containers, CI), so opening it is the only real test.
have_tty() { { : </dev/tty; } 2>/dev/null; }

# Prompts read the terminal, so they also work when the script itself arrives on stdin through curl.
tty_read() {
  local secret="$1" prompt="$2" reply
  have_tty || die "no terminal to ask \"$prompt\". Pass the value as an environment variable."
  if [ "$secret" = 1 ]; then
    read -r -s -p "$prompt" reply </dev/tty
    printf '\n' >/dev/tty
  else
    read -r -p "$prompt" reply </dev/tty
  fi
  printf '%s' "$reply"
}

# ask VAR "Question" [default] [secret] [optional]
ask() {
  local var="$1" question="$2" default="${3:-}" secret="${4:-0}" optional="${5:-0}" value
  value="${!var:-}"
  # An optional variable that is set, even to empty, counts as answered.
  if [ "$optional" = 1 ] && [ -n "${!var+set}" ]; then return; fi
  while [ -z "$value" ]; do
    local hint=""
    [ -n "$default" ] && hint=" [$default]"
    [ "$optional" = 1 ] && [ -z "$default" ] && hint=" (optional, Enter to skip)"
    value="$(tty_read "$secret" "$question$hint: ")"
    value="${value:-$default}"
    [ "$optional" = 1 ] && break
  done
  case "$value" in *"'"* | *$'\n'*) die "$var must not contain a single quote or a newline." ;; esac
  printf -v "$var" '%s' "$value"
}

confirm() {
  local question="$1" default="$2" reply
  reply="$(tty_read 0 "$question [$([ "$default" = y ] && echo Y/n || echo y/N)]: ")"
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

secret() { openssl rand -hex 32; }

DEFAULT_IMAGE=ghcr.io/prlct/automation-server

# Runs git with the token for github.com when there is one. The header travels in the environment,
# so the token appears neither in the process list nor in .git/config. Never prompts for a password.
git_run() {
  local token="${REPO_TOKEN:-${GHCR_TOKEN:-}}" auth
  export GIT_TERMINAL_PROMPT=0
  if [ -n "$token" ]; then
    auth="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraHeader" \
      GIT_CONFIG_VALUE_0="Authorization: Basic $auth" git "$@"
  else
    git "$@"
  fi
}

# A private repository cannot be cloned anonymously. Ask for a token once on a terminal and retry.
clone_repo() {
  if git_run clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR" 2>/dev/null; then return 0; fi
  if [ -z "${REPO_TOKEN:-${GHCR_TOKEN:-}}" ] && have_tty; then
    warn "Could not clone $REPO_URL. If the repository is private, a token is needed."
    warn "Use a classic token with the repo scope (add read:packages to reuse it for the image) from https://github.com/settings/tokens."
    ask REPO_TOKEN "GitHub token" "" 1
    git_run clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP_DIR" && return 0
  fi
  die "could not clone $REPO_URL. For a private repository pass REPO_TOKEN, a token that can read its contents."
}

compose_files() {
  local files=docker-compose.yml
  if [ "$1" = image ]; then files=docker-compose.ghcr.yml; fi
  if [ "$2" = 1 ]; then files="$files:docker-compose.traefik.yml"; fi
  printf '%s' "$files"
}

# CI publishes ghcr.io/<owner>/<repo>, so a fork clones and pulls its own image.
default_image() {
  local url path
  url="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
  path="$(printf '%s' "$url" | sed -nE 's#^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+)$#\2#p')"
  path="${path%.git}"
  if [ -n "$path" ]; then
    printf 'ghcr.io/%s' "$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')"
  else
    printf '%s' "$DEFAULT_IMAGE"
  fi
}

choose_mode() {
  local reply
  if [ -n "${DEPLOY_MODE:-}" ]; then
    case "$DEPLOY_MODE" in image | build) MODE="$DEPLOY_MODE" ;; *) die "DEPLOY_MODE must be image or build, got \"$DEPLOY_MODE\"." ;; esac
  elif have_tty; then
    reply="$(tty_read 0 $'How do you want to deploy?\n  1) Pull the prebuilt image from the GitHub Container Registry (fast, runs on 512 MB RAM)\n  2) Build the image on this server (needs about 1 GB RAM, takes a few minutes)\nChoose [1]: ')"
    case "${reply:-1}" in 2 | b* | B*) MODE=build ;; *) MODE=image ;; esac
  else
    MODE=build
  fi
}

# Writes KEY=value to .env, replacing an earlier line. Values here never need quoting.
set_env() {
  local file="$APP_DIR/.env" tmp
  tmp="$(mktemp "$APP_DIR/.env.XXXXXX")"
  chmod 600 "$tmp"
  grep -v "^$1=" "$file" >"$tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  mv "$tmp" "$file"
}

current_mode() {
  case "$(env_value COMPOSE_FILE)" in *docker-compose.ghcr.yml*) printf image ;; *) printf build ;; esac
}

# Applies DEPLOY_MODE, IMAGE and IMAGE_TAG to an existing .env, so one script both installs and switches.
apply_overrides() {
  local current traefik=0 image
  current="$(current_mode)"
  if [[ "$(env_value COMPOSE_FILE)" == *traefik* ]]; then traefik=1; fi
  MODE="$current"
  if [ -n "${DEPLOY_MODE:-}" ]; then
    choose_mode
  fi
  if [ "$MODE" != "$current" ] || [ -z "$(env_value COMPOSE_FILE)" ]; then
    say "Deploy mode: $MODE"
    set_env COMPOSE_FILE "$(compose_files "$MODE" "$traefik")"
  fi
  if [ "$MODE" = image ]; then
    image="${IMAGE:-$(env_value IMAGE)}"
    image="${image:-$(default_image)}"
    if [ "$image" != "$(env_value IMAGE)" ]; then set_env IMAGE "$image"; fi
    if [ -n "${IMAGE_TAG:-}" ] && [ "$IMAGE_TAG" != "$(env_value IMAGE_TAG)" ]; then set_env IMAGE_TAG "$IMAGE_TAG"; fi
  fi
}

# The package is private while the repository is, and a new package is private by default, so a
# refused pull is the normal first-run case. Log in once, docker keeps the credentials.
pull_image() {
  local out image registry
  if out="$(docker compose pull 2>&1)"; then return 0; fi
  printf '%s\n' "$out" >&2
  image="$(env_value IMAGE)"
  image="${image:-$DEFAULT_IMAGE}"
  registry="${image%%/*}"
  if ! grep -qiE 'denied|unauthorized|forbidden|requires authentication|authentication required' <<<"$out"; then
    die "pulling $image failed, see above. Use DEPLOY_MODE=build to build on this server instead."
  fi
  warn "$registry refused the pull. The package is private until it is made public in its settings."
  warn "Create a classic token with the read:packages scope at https://github.com/settings/tokens and log in with it."
  ask GHCR_USER "GitHub username for $registry"
  ask GHCR_TOKEN "Token with read:packages" "" 1
  printf '%s' "$GHCR_TOKEN" | docker login "$registry" -u "$GHCR_USER" --password-stdin >/dev/null \
    || die "login to $registry failed."
  docker compose pull || die "pulling $image failed after logging in. Has CI published it yet? Use DEPLOY_MODE=build to build on this server instead."
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then return; fi
  [ "${SKIP_DOCKER_INSTALL:-0}" = 1 ] && die "Docker with the compose plugin is required."
  [ "$(id -u)" = 0 ] || die "Docker is missing. Run as root (sudo) to install it."
  say "Installing Docker with the official script from get.docker.com"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
}

check_compose_version() {
  local version major minor
  version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
  major="${version%%.*}"
  minor="$(printf '%s' "$version" | cut -d. -f2)"
  if [ "${major:-0}" -lt 2 ] || { [ "$major" -eq 2 ] && [ "${minor:-0}" -lt 24 ]; }; then
    die "Docker Compose $version is too old, 2.24 or newer is needed. Update Docker and run again."
  fi
}

locate_checkout() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
  if [ -n "$here" ] && [ -f "$here/../docker-compose.yml" ] && [ -f "$here/../Dockerfile" ]; then
    APP_DIR="$(cd "$here/.." && pwd)"
    say "Using the checkout at $APP_DIR"
    if git -C "$APP_DIR" rev-parse --abbrev-ref '@{upstream}' >/dev/null 2>&1; then
      git_run -C "$APP_DIR" pull --quiet --ff-only || warn "git pull failed, deploying the code as it is."
    fi
    return
  fi
  APP_DIR="$INSTALL_DIR"
  command -v git >/dev/null 2>&1 || { [ "$(id -u)" = 0 ] && command -v apt-get >/dev/null 2>&1 && apt-get update -qq && apt-get install -y -qq git >/dev/null; } || die "git is required."
  if [ -d "$APP_DIR/.git" ]; then
    say "Updating $APP_DIR"
    git_run -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    git_run -C "$APP_DIR" checkout --quiet "$BRANCH"
    git_run -C "$APP_DIR" pull --quiet --ff-only origin "$BRANCH"
  else
    say "Cloning $REPO_URL into $APP_DIR"
    clone_repo
  fi
}

write_env() {
  local env_file="$APP_DIR/.env" use_traefik=y
  say "No .env yet, configuring"

  choose_mode
  if [ -n "${USE_TRAEFIK:-}" ]; then
    use_traefik="$USE_TRAEFIK"
  elif ! confirm "Serve over HTTPS with Traefik and Let's Encrypt (needs two domains pointing here)?" y; then
    use_traefik=n
  fi
  local traefik_flag=0
  if [[ "$use_traefik" =~ ^[Yy1] ]]; then traefik_flag=1; fi

  if [[ "$use_traefik" =~ ^[Yy1] ]]; then
    ask SERVER_DOMAIN "Domain for webhooks, e.g. hooks.example.com"
    ask ADMIN_DOMAIN "Domain for the admin, e.g. admin.example.com"
    ask ACME_EMAIL "Email for Let's Encrypt expiry notices"
  fi
  ask GITHUB_REPO "GitHub repository for issues (owner/name)"
  ask GITHUB_TOKEN "GitHub token (Issues: Read and write, Actions: Read)" "" 1
  ask SENTRY_CLIENT_SECRET "Sentry integration client secret" "" 1
  ask SENTRY_AUTH_TOKEN "Sentry auth token for issue stats" "" 1 1
  ask GITHUB_ACTIONS_REPOS "Repositories whose GitHub Actions the admin shows, comma separated" "$GITHUB_REPO"
  ask ADMIN_EMAIL "Admin login email"

  ADMIN_PASSWORD_GENERATED=""
  if [ -z "${ADMIN_PASSWORD:-}" ]; then
    ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=')"
    ADMIN_PASSWORD_GENERATED=1
  fi
  ADMIN_API_TOKEN="${ADMIN_API_TOKEN:-$(secret)}"
  SESSION_SECRET="${SESSION_SECRET:-$(secret)}"

  local tmp
  tmp="$(mktemp "$APP_DIR/.env.XXXXXX")"
  chmod 600 "$tmp"
  {
    echo "# Written by scripts/deploy-vps.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). See .env.example for every option."
    echo "COMPOSE_FILE=$(compose_files "$MODE" "$traefik_flag")"
    echo "ADMIN_API_TOKEN='$ADMIN_API_TOKEN'"
    echo "SENTRY_CLIENT_SECRET='$SENTRY_CLIENT_SECRET'"
    if [ -n "$SENTRY_AUTH_TOKEN" ]; then echo "SENTRY_AUTH_TOKEN='$SENTRY_AUTH_TOKEN'"; fi
    echo "GITHUB_TOKEN='$GITHUB_TOKEN'"
    echo "GITHUB_REPO='$GITHUB_REPO'"
    echo "GITHUB_ACTIONS_REPOS='$GITHUB_ACTIONS_REPOS'"
    echo "ADMIN_EMAIL='$ADMIN_EMAIL'"
    echo "ADMIN_PASSWORD='$ADMIN_PASSWORD'"
    echo "SESSION_SECRET='$SESSION_SECRET'"
    if [[ "$use_traefik" =~ ^[Yy1] ]]; then
      echo "SERVER_DOMAIN='$SERVER_DOMAIN'"
      echo "ADMIN_DOMAIN='$ADMIN_DOMAIN'"
      echo "ACME_EMAIL='$ACME_EMAIL'"
    fi
    if [ -n "${SERVER_PORT:-}" ]; then echo "SERVER_PORT='$SERVER_PORT'"; fi
    if [ -n "${ADMIN_PORT:-}" ]; then echo "ADMIN_PORT='$ADMIN_PORT'"; fi
    if [ -n "${ACME_CA_SERVER:-}" ]; then echo "ACME_CA_SERVER='$ACME_CA_SERVER'"; fi
  } >"$tmp"
  mv "$tmp" "$env_file"
  say "Wrote $env_file (mode 600)"
}

env_value() {
  local line
  line="$(grep -E "^$1=" "$APP_DIR/.env" | tail -n1 || true)"
  line="${line#*=}"
  line="${line#\'}"
  printf '%s' "${line%\'}"
}

check_dns() {
  local domain
  for domain in "$@"; do
    if ! getent hosts "$domain" >/dev/null 2>&1 && ! host "$domain" >/dev/null 2>&1; then
      warn "$domain does not resolve yet. Let's Encrypt cannot issue its certificate until the A record points at this machine."
    fi
  done
}

open_firewall() {
  if [ "${SKIP_FIREWALL:-0}" = 1 ] || ! command -v ufw >/dev/null 2>&1; then return 0; fi
  if ! ufw status 2>/dev/null | grep -q "Status: active"; then return 0; fi
  if [ "$(id -u)" != 0 ]; then
    warn "ufw is active. Allow ports $* yourself, or rerun with sudo."
    return 0
  fi
  local port
  for port in "$@"; do
    say "ufw allow $port/tcp"
    ufw allow "$port/tcp" >/dev/null
  done
}

main() {
  [ "$(uname -s)" = Linux ] || warn "This script targets Linux servers. Continuing anyway."
  command -v openssl >/dev/null 2>&1 || die "openssl is required."
  install_docker
  check_compose_version
  locate_checkout
  cd "$APP_DIR"

  if [ -f .env ]; then
    say "Keeping the existing .env. Edit it, or delete it to answer the questions again."
  else
    write_env
  fi
  apply_overrides

  local traefik server_domain admin_domain
  traefik="$(env_value COMPOSE_FILE)"
  server_domain="$(env_value SERVER_DOMAIN)"
  admin_domain="$(env_value ADMIN_DOMAIN)"
  if [[ "$traefik" == *traefik* ]]; then
    check_dns "$server_domain" "$admin_domain"
    open_firewall 80 443
  else
    local port
    port="$(env_value SERVER_PORT)"
    open_firewall "${port:-3000}"
  fi

  local up=(up -d --remove-orphans --wait --wait-timeout 180)
  if [ "$MODE" = image ]; then
    local tag
    tag="$(env_value IMAGE_TAG)"
    say "Pulling $(env_value IMAGE):${tag:-latest}"
    pull_image
  else
    say "Building and starting, the first build takes a few minutes"
    up+=(--build)
  fi
  docker compose "${up[@]}" \
    || { docker compose ps; docker compose logs --tail 40; die "a service did not become healthy, see the logs above."; }
  docker image prune -f >/dev/null 2>&1 || true

  echo
  say "automation-server is running in $APP_DIR ($MODE mode)"
  if [[ "$traefik" == *traefik* ]]; then
    echo "  Admin:              https://$admin_domain"
    echo "  Sentry webhook URL: https://$server_domain/webhooks/sentry"
    echo "  Certificates can take a minute after the first start."
  else
    local server_port admin_port
    server_port="$(env_value SERVER_PORT)"
    admin_port="$(env_value ADMIN_PORT)"
    echo "  Sentry webhook URL: http://<this server's address>:${server_port:-3000}/webhooks/sentry"
    echo "  Admin (loopback only): ssh -L 3001:127.0.0.1:${admin_port:-3001} <this server>, then http://localhost:3001"
  fi
  echo "  Admin login:        $(env_value ADMIN_EMAIL)"
  if [ -n "${ADMIN_PASSWORD_GENERATED:-}" ]; then
    echo "  Admin password:     $ADMIN_PASSWORD"
    echo "  The password is shown once. It is also stored in $APP_DIR/.env."
  fi
  echo "  Update later:       sudo $APP_DIR/scripts/deploy-vps.sh"
}

main "$@"
