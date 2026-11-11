#!/usr/bin/env bash
# Proves the gate stops on a failing test: in a throw-away clone, a deliberately
# failing test is staged and committed — the commit must be refused, and
# scripts/verify.sh must exit non-zero. The real repository is not touched.
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone -q "$src" "$tmp/repo"
cd "$tmp/repo"
ln -s "$src/node_modules" node_modules
ln -s "$src/web/node_modules" web/node_modules
# Test the gate as it is in the working tree now (even before it is committed).
mkdir -p .githooks scripts
cp "$src/.githooks/pre-commit" "$src/.githooks/pre-push" .githooks/
cp "$src/scripts/verify.sh" scripts/
git config core.hooksPath .githooks
git config user.email gate@example.invalid
git config user.name "Gate selftest"
cat > test/platform/zz-gate-probe.test.ts <<'T'
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('deliberately failing test (gate selftest)', () => assert.equal(1, 2));
T
git add test/platform/zz-gate-probe.test.ts
if git commit -q -m "must be refused" >"$tmp/commit.log" 2>&1; then
  echo "✗ САМОПРОВЕРКА НЕ ПРОЙДЕНА: коммит с падающим тестом прошёл"; cat "$tmp/commit.log"; exit 1
fi
grep -q "ОСТАНОВЛЕНО" "$tmp/commit.log" || { echo "✗ коммит отклонён не шлагбаумом:"; cat "$tmp/commit.log"; exit 1; }
echo "✓ коммит с падающим тестом отклонён: $(grep -m1 'ОСТАНОВЛЕНО' "$tmp/commit.log")"
if scripts/verify.sh --quick test/platform/zz-gate-probe.test.ts >"$tmp/verify.log" 2>&1; then
  echo "✗ САМОПРОВЕРКА НЕ ПРОЙДЕНА: verify.sh вернул 0 при падающем тесте"; exit 1
fi
echo "✓ verify.sh вернул ненулевой код при падающем тесте"
# And a pipe no longer hides a failure: the old defect was `node --test … | grep …`.
if bash -o pipefail -c 'node --test test/platform/zz-gate-probe.test.ts | grep -q "^# pass"' 2>/dev/null; then
  echo "✗ конвейер с pipefail не заметил падения"; exit 1
fi
echo "✓ конвейер с pipefail замечает падение теста внутри пайпа"
echo "Самопроверка шлагбаума пройдена (локально)."
