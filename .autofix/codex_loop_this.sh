#!/usr/bin/env bash
set -euo pipefail

# ----------------------------------------
# CONFIG
# ----------------------------------------
REPO_CODEX="/Users/jacky/Documents/vercel-codex-autofix"
REPO_TARGET="/Users/jacky/Documents/zeda_video"

CHECK_CMD='CODEX_USE_EXEC=1 npx ts-node ~/Documents/vercel-codex-autofix/vercel_codex_loop.ts ""'

MAX_ROUNDS=10
ROUND=1

LAST_MSG="$REPO_CODEX/.codex_last_message.txt"

# ----------------------------------------
# LOOP
# ----------------------------------------
while [[ $ROUND -le $MAX_ROUNDS ]]; do
  echo
  echo "======================================"
  echo "🔁 Round $ROUND / $MAX_ROUNDS"
  echo "======================================"

  # 1️⃣ Run external command FIRST
  set +e
  OUTPUT="$(
    cd "$REPO_TARGET" && bash -lc "$CHECK_CMD" 2>&1
  )"
  EXIT_CODE=$?
  set -e

  echo "$OUTPUT"

  # 2️⃣ Stop early if success
  if [[ $EXIT_CODE -eq 0 ]]; then
    echo "✅ CHECK_CMD succeeded. Loop finished."
    exit 0
  fi

  # 3️⃣ Ask Codex to fix based on stdout
  codex exec --full-auto \
    -C "$REPO_CODEX" \
    -o "$LAST_MSG" \
    "
The following command was run and FAILED:

Command:
$CHECK_CMD

Stdout/Stderr:
$OUTPUT

Please:
1. Identify the root cause from the output
2. Apply the minimal correct fix in this repository
3. Do not refactor unrelated code
4. Ensure the next run of the command is more likely to succeed
"

  ROUND=$((ROUND + 1))
done

echo "❌ Reached max rounds ($MAX_ROUNDS) without success."
exit 1