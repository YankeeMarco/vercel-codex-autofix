#!/usr/bin/env bash
set -euo pipefail

TARGET_URL="${1:-${MCP_GUI_TARGET_URL:-}}"

if [[ -z "${TARGET_URL}" ]]; then
  echo "[mcp-gui] Missing target URL. Pass it as the first argument or set MCP_GUI_TARGET_URL." >&2
  exit 2
fi

OUTPUT_DIR="${MCP_GUI_LOG_DIR:-logs/gui}"
mkdir -p "${OUTPUT_DIR}"

npx @playwright/mcp@latest \
  --config "$(dirname "$0")/playwright.config.json" \
  --save-trace \
  --save-video=1280x720 \
  --output-dir "${OUTPUT_DIR}" <<EOF
Use Playwright MCP tools to test the website at ${TARGET_URL}.
Follow the GUI intent described in $(dirname "$0")/gui-tests.md.
Return a concise PASS/FAIL report for each scenario.
EOF
