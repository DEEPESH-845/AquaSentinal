#!/usr/bin/env bash
# Start the FastAPI backend for local development with one command.
#
#   npm run backend:dev                 # http://localhost:8000, auto-reload, offline mode unless a key is set
#   npm run backend:dev -- --fresh      # wipe the local database and frames first
#   npm run backend:dev -- --port 8010  # another port (point the frontend at it with NEXT_PUBLIC_BACKEND_URL)
#   npm run backend:dev -- --no-reload
#
# First run creates backend/.venv and installs backend/requirements-dev.txt; later runs reinstall only when a
# requirements file changes. Optional settings (MODEL_API_KEY and the rest of .env.example) go in backend/.env.local,
# which is gitignored and exported into the backend's environment; variables already set in the shell win.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
VENV="$BACKEND/.venv"
PORT=8000
RELOAD=1
FRESH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --no-reload) RELOAD=0; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# Python 3.11 or later
PY="${PYTHON:-}"
if [[ -z "$PY" ]]; then
  for c in python3.13 python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 11))' 2>/dev/null; then PY="$c"; break; fi
  done
fi
if [[ ! -x "$VENV/bin/python" ]]; then
  [[ -n "$PY" ]] || { echo "Python 3.11 or later not found; set PYTHON=/path/to/python3.11" >&2; exit 1; }
  echo "creating backend/.venv with $PY"
  "$PY" -m venv "$VENV"
fi

# Install only when the requirements changed since the last install
STAMP="$VENV/.requirements.sha"
SUM="$(cat "$BACKEND/requirements.txt" "$BACKEND/requirements-dev.txt" | shasum | cut -d' ' -f1)"
if [[ "$(cat "$STAMP" 2>/dev/null)" != "$SUM" ]]; then
  echo "installing backend requirements"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet -r "$BACKEND/requirements-dev.txt"
  echo "$SUM" > "$STAMP"
fi

# Optional local settings; the shell's own values take precedence
if [[ -f "$BACKEND/.env.local" ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    value="${value%\"}"; value="${value#\"}"
    [[ -z "${!key:-}" ]] && export "$key=$value"
  done < "$BACKEND/.env.local"
fi

# Safe local defaults: simulated gantry, hardware off, data kept in backend/data (gitignored)
export APP_MODE="${APP_MODE:-SIMULATION}"
export AQUA_HARDWARE_ENABLE="${AQUA_HARDWARE_ENABLE:-false}"
export AQUA_DATA_DIR="${AQUA_DATA_DIR:-$BACKEND/data}"
export DATABASE_URL="${DATABASE_URL:-sqlite:///$AQUA_DATA_DIR/dev.db}"

if [[ $FRESH -eq 1 ]]; then
  echo "wiping $AQUA_DATA_DIR"
  rm -rf "$AQUA_DATA_DIR"
fi
mkdir -p "$AQUA_DATA_DIR"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use (a backend may already be running): stop it or pass --port" >&2
  exit 1
fi

if [[ -n "${MODEL_API_KEY:-}" ]]; then KEY="MODEL_API_KEY set: Meta models live"; else KEY="no MODEL_API_KEY: labelled offline mode"; fi
echo "backend on http://localhost:$PORT  ($APP_MODE, $KEY, data in $AQUA_DATA_DIR)"

cd "$BACKEND"
ARGS=(app.main:app --port "$PORT")
[[ $RELOAD -eq 1 ]] && ARGS+=(--reload --reload-dir app)
exec "$VENV/bin/uvicorn" "${ARGS[@]}"
