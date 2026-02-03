#!/usr/bin/env bash
set -euo pipefail

# Basic secret scan for this repo.
# Intended as a cheap pre-push guard. Not a substitute for proper secret scanning.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[security_check] repo=$REPO_ROOT"

# Prefer scanning only tracked files to avoid flagging local .env and other untracked state.
# (Secrets should never be committed; local .env is expected to contain tokens.)

PATTERN_LITERAL='(xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z\-_]{20,}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----)'
PATTERN_VARLIKE='(OPENAI_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY|TOGETHER_API_KEY|TELEGRAM_BOT_TOKEN|DISCORD_TOKEN|SLACK_(BOT_)?TOKEN)'

# Build list of tracked files; ignore docs/examples that mention env var names.
mapfile -t FILES < <(git ls-files \
  | grep -vE '^(README\.md|PRIVACY\.md|SECURITY\.md|\.env\.example)$' \
  || true)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "[PASS] No tracked files to scan."
  exit 0
fi

# 1) Detect literal key/token-like strings.
if grep -nE "${PATTERN_LITERAL}" "${FILES[@]}" >/tmp/security_check_hits.txt 2>/dev/null; then
  echo "[FAIL] Suspected secrets found in tracked files:"
  head -n 200 /tmp/security_check_hits.txt
  exit 1
fi

echo "[PASS] No obvious secrets found in tracked files."
