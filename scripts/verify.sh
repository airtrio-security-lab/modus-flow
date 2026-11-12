#!/usr/bin/env bash
# MODUS FLOW · local release gate.
# Stops at the FIRST failing step (set -e + pipefail: a failure inside a pipe is
# not hidden). Used by the git hooks and before any build, commit or publication.
#
# These checks are LOCAL. GitHub CI is configured (.github/workflows/ci.yml) but
# does not run while the account has a billing problem: a green local run is not
# a green CI run, and reports must say so.
#
#   scripts/verify.sh            full: typecheck, prototype tests, platform tests (PostgreSQL), web build
#   scripts/verify.sh --quick    typecheck + DB-free unit tests + the given test files (pre-commit)
#   scripts/verify.sh --quick test/platform/x.test.ts ...
set -Eeuo pipefail
cd "$(dirname "$0")/.."
mode=full
if [ "${1:-}" = "--quick" ]; then mode=quick; shift; fi
trap 'code=$?; echo "✗ ОСТАНОВЛЕНО на шаге: ${STEP:-?} (код $code). Сборка, коммит и публикация запрещены." >&2; exit $code' ERR
step() { STEP="$*"; echo "▶ $STEP"; }

step "проверка типов (сервер и веб)"
npm run -s check
(cd web && npx tsc --noEmit -p .)

if [ "$mode" = quick ]; then
  step "модульные тесты без базы"
  node --test test/platform/domain.test.ts test/platform/world3d.test.ts test/platform/envoy-outfits.test.ts
  if [ "$#" -gt 0 ]; then
    : "${TEST_DATABASE_URL:?TEST_DATABASE_URL обязателен для тестов платформы: они никогда не пропускаются}"
    step "изменённые тесты: $*"
    node --test --test-concurrency=1 "$@"
  fi
  echo "✓ Быстрые проверки пройдены — ЛОКАЛЬНО (GitHub CI не запускался)"
  exit 0
fi

: "${TEST_DATABASE_URL:?TEST_DATABASE_URL обязателен: тесты платформы никогда не пропускаются}"
step "тесты прототипа"
npm run -s test:legacy
step "тесты платформы на PostgreSQL"
npm run -s test:platform
step "сборка веб-приложения"
npm --prefix web run -s build
echo "✓ Все обязательные проверки пройдены — ЛОКАЛЬНО (GitHub CI не запускался)"
