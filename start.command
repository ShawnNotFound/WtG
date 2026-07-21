#!/bin/bash

set -Eeuo pipefail

# Finder-launched .command files do not always inherit Homebrew's PATH.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
LOCAL_DATABASE_URL="postgres://postgres:postgres@localhost:5432/future_headlines"
PLACEHOLDER_DATABASE_URL="postgres://USER:PASS@HOST:5432/DBNAME"

BACKEND_PID=""
FRONTEND_PID=""
DOCKER_BIN=""
COMPOSE_MODE=""
COMPOSE_BIN=""

info() {
  printf '%s\n' "$*"
}

die() {
  printf '\n[ERROR] %s\n' "$*" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  local file="$2"
  local value

  value="$(awk -v key="$key" '
    {
      sub(/\r$/, "")
      line = $0
      sub(/^[[:space:]]*export[[:space:]]+/, "", line)
      if (index(line, key "=") == 1) {
        print substr(line, length(key) + 2)
        exit
      }
    }
  ' "$file")"

  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value:${#value}-1:1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value:${#value}-1:1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  printf '%s' "$value"
}

find_docker() {
  local candidate

  if command -v docker >/dev/null 2>&1; then
    DOCKER_BIN="$(command -v docker)"
    return 0
  fi

  for candidate in \
    /Applications/Docker.app/Contents/Resources/bin/docker \
    "$HOME/Applications/Docker.app/Contents/Resources/bin/docker"; do
    if [[ -x "$candidate" ]]; then
      DOCKER_BIN="$candidate"
      return 0
    fi
  done

  return 1
}

ensure_docker_daemon() {
  local context=""
  local attempt=1

  if "$DOCKER_BIN" info >/dev/null 2>&1; then
    return 0
  fi

  context="$("$DOCKER_BIN" context show 2>/dev/null || true)"

  if command -v colima >/dev/null 2>&1 && [[ "$context" == colima* ]]; then
    info "Docker is stopped. Starting Colima..."
    colima start || die "Colima could not start. Run 'colima start' for details."
  elif [[ -d /Applications/Docker.app || -d "$HOME/Applications/Docker.app" ]]; then
    info "Docker Desktop is stopped. Starting it..."
    open -g -a Docker || die "Docker Desktop could not be opened."
  elif command -v colima >/dev/null 2>&1; then
    info "Docker is stopped. Starting Colima..."
    colima start || die "Colima could not start. Run 'colima start' for details."
  else
    die "The local database needs a Docker engine. Install Docker Desktop, or run 'brew install docker docker-compose colima'."
  fi

  info "Waiting for Docker to become ready..."
  while [[ $attempt -le 60 ]]; do
    if "$DOCKER_BIN" info >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done

  die "Docker did not become ready within two minutes."
}

configure_colima_docker_proxy() {
  local context
  local daemon_proxy
  local host_http_proxy
  local host_https_proxy
  local guest_http_proxy
  local guest_https_proxy
  local guest_no_proxy
  local gateway

  command -v colima >/dev/null 2>&1 || return 0
  context="$("$DOCKER_BIN" context show 2>/dev/null || true)"
  [[ "$context" == colima* ]] || return 0

  host_http_proxy="${HTTP_PROXY:-${http_proxy:-}}"
  host_https_proxy="${HTTPS_PROXY:-${https_proxy:-}}"

  daemon_proxy="$("$DOCKER_BIN" info --format '{{.HTTPProxy}}{{.HTTPSProxy}}' 2>/dev/null || true)"
  [[ -z "$daemon_proxy" || "$daemon_proxy" == "<no value><no value>" ]] || return 0

  guest_http_proxy="$(colima ssh -- sh -lc 'printf %s "${HTTP_PROXY:-${http_proxy:-}}"' 2>/dev/null || true)"
  guest_https_proxy="$(colima ssh -- sh -lc 'printf %s "${HTTPS_PROXY:-${https_proxy:-}}"' 2>/dev/null || true)"
  guest_no_proxy="$(colima ssh -- sh -lc 'printf %s "${NO_PROXY:-${no_proxy:-localhost,127.0.0.1,::1}}"' 2>/dev/null || true)"

  [[ -n "$host_http_proxy" || -n "$host_https_proxy" || -n "$guest_http_proxy" || -n "$guest_https_proxy" ]] || return 0

  if [[ -z "$guest_http_proxy" && -n "$host_http_proxy" ]]; then
    guest_http_proxy="$host_http_proxy"
  fi
  if [[ -z "$guest_https_proxy" && -n "$host_https_proxy" ]]; then
    guest_https_proxy="$host_https_proxy"
  fi

  if [[ "$guest_http_proxy" == *"//127.0.0.1"* || "$guest_http_proxy" == *"//localhost"* || "$guest_https_proxy" == *"//127.0.0.1"* || "$guest_https_proxy" == *"//localhost"* ]]; then
    gateway="$(colima ssh -- sh -lc "ip route show default | awk '{print \$3; exit}'" 2>/dev/null || true)"
    [[ -n "$gateway" ]] || die "Could not map the host proxy into the Colima VM."
    guest_http_proxy="${guest_http_proxy//\/\/127.0.0.1/\//$gateway}"
    guest_http_proxy="${guest_http_proxy//\/\/localhost/\//$gateway}"
    guest_https_proxy="${guest_https_proxy//\/\/127.0.0.1/\//$gateway}"
    guest_https_proxy="${guest_https_proxy//\/\/localhost/\//$gateway}"
  fi

  info "Configuring Docker to use the host proxy..."
  colima ssh -- sudo mkdir -p /etc/systemd/system/docker.service.d || die "Could not configure the Colima Docker proxy."
  if ! printf '[Service]\nEnvironment="HTTP_PROXY=%s"\nEnvironment="HTTPS_PROXY=%s"\nEnvironment="NO_PROXY=%s"\n' "$guest_http_proxy" "$guest_https_proxy" "$guest_no_proxy" | colima ssh -- sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf >/dev/null; then
    die "Could not write the Colima Docker proxy configuration."
  fi
  colima ssh -- sudo systemctl daemon-reload || die "Could not reload the Colima Docker service."
  colima ssh -- sudo systemctl restart docker || die "Could not restart Docker with the host proxy."
  "$DOCKER_BIN" info >/dev/null 2>&1 || die "Docker did not recover after applying the host proxy."
}

find_compose() {
  if "$DOCKER_BIN" compose version >/dev/null 2>&1; then
    COMPOSE_MODE="plugin"
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_MODE="standalone"
    COMPOSE_BIN="$(command -v docker-compose)"
    return 0
  fi

  return 1
}

run_compose() {
  if [[ "$COMPOSE_MODE" == "plugin" ]]; then
    "$DOCKER_BIN" compose "$@"
  else
    "$COMPOSE_BIN" "$@"
  fi
}

start_local_database() {
  local attempt=1

  find_docker || die "Docker was not found. Install Docker Desktop, or run 'brew install docker docker-compose colima'."
  ensure_docker_daemon
  configure_colima_docker_proxy
  find_compose || die "Docker Compose was not found. Install it with 'brew install docker-compose'."

  info "Starting the local PostgreSQL container..."
  if ! (cd "$ROOT" && run_compose up -d postgres); then
    die "PostgreSQL could not be started with Docker Compose."
  fi

  info "Waiting for PostgreSQL to accept connections..."
  while [[ $attempt -le 60 ]]; do
    if (cd "$ROOT" && run_compose exec -T postgres pg_isready -U postgres -d future_headlines >/dev/null 2>&1); then
      info "PostgreSQL is ready."
      return 0
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  (cd "$ROOT" && run_compose ps) || true
  die "PostgreSQL did not become ready within one minute."
}

ensure_dependencies() {
  local directory="$1"
  local executable="$2"
  local label="$3"
  local install_lock="$directory/node_modules/.package-lock.json"
  local needs_install=0

  if [[ ! -x "$directory/node_modules/.bin/$executable" || ! -f "$install_lock" ]]; then
    needs_install=1
  elif [[ "$directory/package.json" -nt "$install_lock" || "$directory/package-lock.json" -nt "$install_lock" ]]; then
    needs_install=1
  fi

  if [[ $needs_install -eq 0 ]]; then
    info "$label dependencies are current."
    return 0
  fi

  info "Installing $label dependencies from package-lock.json..."
  if ! (cd "$directory" && npm ci --no-audit --no-fund); then
    die "$label dependency installation failed."
  fi
}

port_in_use() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1
  else
    nc -z localhost "$port" >/dev/null 2>&1
  fi
}

stop_process_tree() {
  local parent="$1"
  local child
  local children

  [[ -n "$parent" ]] || return 0

  children="$(pgrep -P "$parent" 2>/dev/null || true)"
  for child in $children; do
    stop_process_tree "$child"
  done

  kill -TERM "$parent" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?

  trap - EXIT INT TERM HUP
  if [[ -n "$BACKEND_PID" || -n "$FRONTEND_PID" ]]; then
    info ""
    info "Stopping frontend and backend..."
    stop_process_tree "$FRONTEND_PID"
    stop_process_tree "$BACKEND_PID"
    [[ -z "$FRONTEND_PID" ]] || wait "$FRONTEND_PID" 2>/dev/null || true
    [[ -z "$BACKEND_PID" ]] || wait "$BACKEND_PID" 2>/dev/null || true
  fi

  exit "$status"
}

wait_for_service() {
  local label="$1"
  local url="$2"
  local pid="$3"
  local attempt=1

  while [[ $attempt -le 30 ]]; do
    if curl --noproxy localhost,127.0.0.1 --max-time 1 --fail --silent --show-error "$url" >/dev/null 2>&1; then
      info "$label is ready."
      return 0
    fi

    if ! kill -0 "$pid" >/dev/null 2>&1; then
      wait "$pid" 2>/dev/null || true
      die "$label exited before it became ready."
    fi

    sleep 1
    attempt=$((attempt + 1))
  done

  die "$label did not become ready within 30 seconds."
}

monitor_services() {
  local status

  while true; do
    if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
      set +e
      wait "$BACKEND_PID"
      status=$?
      set -e
      [[ $status -ne 0 ]] || status=1
      printf '\n[ERROR] Backend stopped unexpectedly.\n' >&2
      return "$status"
    fi

    if ! kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
      set +e
      wait "$FRONTEND_PID"
      status=$?
      set -e
      [[ $status -ne 0 ]] || status=1
      printf '\n[ERROR] Frontend stopped unexpectedly.\n' >&2
      return "$status"
    fi

    sleep 1
  done
}

trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap cleanup EXIT

printf '\nFuture Headlines local launcher (macOS)\n'
printf '=======================================\n\n'

command -v node >/dev/null 2>&1 || die "Node.js was not found. Install Node.js 22.19 or newer."
command -v npm >/dev/null 2>&1 || die "npm was not found. Install Node.js 22.19 or newer."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 19) )); then
  die "Node.js 22.19 or newer is required by the locked dependencies (found $(node --version))."
fi

[[ -f "$BACKEND/package.json" ]] || die "Cannot find $BACKEND/package.json."
[[ -f "$FRONTEND/package.json" ]] || die "Cannot find $FRONTEND/package.json."
[[ -f "$BACKEND/.env" ]] || die "Missing backend/.env. Copy backend/.env.example, fill in an LLM API key, and run this launcher again."

BACKEND_PORT="$(read_env_value PORT "$BACKEND/.env")"
BACKEND_PORT="${BACKEND_PORT:-3001}"
[[ "$BACKEND_PORT" =~ ^[0-9]+$ ]] || die "PORT in backend/.env must be a number."

port_in_use "$BACKEND_PORT" && die "Port $BACKEND_PORT is already in use; the backend cannot start."
port_in_use 5173 && die "Port 5173 is already in use; the frontend cannot start."

info "[1/6] Preparing the database..."
DATABASE_URL="$(read_env_value DATABASE_URL "$BACKEND/.env")"
DATABASE_URL_BASE="${DATABASE_URL%%\?*}"
case "$DATABASE_URL_BASE" in
  "$PLACEHOLDER_DATABASE_URL")
    start_local_database
    sed -i '' "s|^DATABASE_URL=$PLACEHOLDER_DATABASE_URL|DATABASE_URL=$LOCAL_DATABASE_URL|" "$BACKEND/.env"
    DATABASE_URL="$(read_env_value DATABASE_URL "$BACKEND/.env")"
    [[ "$DATABASE_URL" == "$LOCAL_DATABASE_URL" ]] || die "Could not update DATABASE_URL in backend/.env."
    info "backend/.env now points at the local PostgreSQL container."
    ;;
  "$LOCAL_DATABASE_URL"|"postgresql://postgres:postgres@localhost:5432/future_headlines"|"postgres://postgres:postgres@127.0.0.1:5432/future_headlines"|"postgresql://postgres:postgres@127.0.0.1:5432/future_headlines")
    start_local_database
    ;;
  "")
    die "DATABASE_URL is missing from backend/.env."
    ;;
  *)
    info "Using the custom DATABASE_URL from backend/.env."
    ;;
esac

info ""
info "[2/6] Checking backend dependencies..."
ensure_dependencies "$BACKEND" tsx "Backend"

info ""
info "[3/6] Checking frontend dependencies..."
ensure_dependencies "$FRONTEND" vite "Frontend"

info ""
info "[4/6] Applying database migrations..."
if ! (cd "$BACKEND" && npm run migrate); then
  die "Database migration failed. Check DATABASE_URL and the database logs above."
fi

info ""
info "[5/6] Starting backend on http://localhost:$BACKEND_PORT ..."
(cd "$BACKEND" && exec npm run dev) &
BACKEND_PID=$!

info "[6/6] Starting frontend on http://localhost:5173 ..."
(cd "$FRONTEND" && export VITE_BACKEND_URL="http://localhost:$BACKEND_PORT" && exec npm run dev -- --strictPort) &
FRONTEND_PID=$!

wait_for_service "Backend" "http://localhost:$BACKEND_PORT/health" "$BACKEND_PID"
wait_for_service "Frontend" "http://localhost:5173" "$FRONTEND_PID"

info ""
info "Future Headlines is ready: http://localhost:5173"
info "Press Control-C in this window to stop both servers."

if [[ "${WTG_OPEN_BROWSER:-1}" != "0" ]] && command -v open >/dev/null 2>&1; then
  open "http://localhost:5173" >/dev/null 2>&1 || true
fi

monitor_services
