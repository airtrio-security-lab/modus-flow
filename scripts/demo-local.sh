#!/usr/bin/env bash
# One-command local demo (macOS / Linux): PostgreSQL in Docker, fictional
# «Модус Трейд — демо» data, API + web app on http://127.0.0.1:3100.
# Never use with real employee data: the demo sign-in is an SSO imitation.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .demo

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22 || (a===22 && b<18)) { console.error("Нужен Node.js 22.18 или новее (сейчас " + process.versions.node + ")"); process.exit(1) }'
docker info >/dev/null 2>&1 || { echo "Запустите Docker (OrbStack или Docker Desktop) и повторите."; exit 1; }

# Port: reuse the one chosen last time; if 5432 is taken by another server, use 55432.
if [ -f .demo/pg-port ]; then PORT=$(cat .demo/pg-port); else
  PORT=5432
  if lsof -nP -iTCP:5432 -sTCP:LISTEN >/dev/null 2>&1; then PORT=55432; fi
  echo "$PORT" > .demo/pg-port
fi
export MODUS_PG_PORT=$PORT
echo "PostgreSQL для демо: 127.0.0.1:$PORT"
docker compose up -d postgres
printf 'Ждём PostgreSQL'
until docker compose exec -T postgres pg_isready -h 127.0.0.1 -U modus >/dev/null 2>&1; do printf '.'; sleep 1; done
echo

export MIGRATION_DATABASE_URL="postgres://modus:modus-local-only@127.0.0.1:$PORT/modus"
export DATABASE_URL="postgres://modus_api:modus-api-local-only@127.0.0.1:$PORT/modus"

[ -d node_modules ] || npm ci
if [ "$(docker compose exec -T postgres psql -U modus -d modus -Atc "SELECT to_regclass('public.organizations') IS NOT NULL AND EXISTS (SELECT 1 FROM organizations WHERE slug = 'modus-demo')" 2>/dev/null || true)" != "t" ] || [ ! -f .demo/personas.json ]; then
  echo "Заполняем демо-данные…"
  npm run -s demo:seed
fi
[ -f web/dist/index.html ] || npm run web:build

( sleep 2; command -v open >/dev/null && open http://127.0.0.1:3100 ) &
echo "Откройте http://127.0.0.1:3100 — остановить: Ctrl+C"
npm run -s demo:start
