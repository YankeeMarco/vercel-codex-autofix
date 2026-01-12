# MCP Playwright assets

This folder holds everything the GUI scout needs:

- `playwright.config.json` – headless Chromium config shared by every run (CI-friendly viewport/timeouts).
- `gui-tests.md` – the intent spec written in natural language. This is the file you show to Codex or any MCP-aware agent so it understands which flows to exercise.
- `run-gui-check.sh` – a thin wrapper around `npx @playwright/mcp@latest` that executes the spec above, saves traces/videos to `logs/gui/`, and prints a concise PASS/FAIL summary.

## How it works

1. The autofix loop (or you) invokes `bash mcp/run-gui-check.sh <deployment-url>`.
2. The script launches the Playwright MCP tool. Under the hood, that package spins up Chromium and lets an MCP-enabled LLM drive it using the instructions from `gui-tests.md`.
3. Playwright MCP emits text output, plus trace/video artifacts whenever it discovers a problem.
4. The loop copies the textual report into `.autofix/gui_report.md` so Codex can reason about GUI failures just like it reasons about Vercel build logs.

> **Which LLM does this use?**  
> Whatever LLM your MCP environment is configured for. The script itself doesn’t hardcode a model; it simply shells out to `@playwright/mcp`, which negotiates with your configured MCP/LLM stack.

Customize `gui-tests.md` as your product evolves—no code changes required. If you need to skip GUI checks entirely (e.g., while stabilizing flows), export `RUN_MCP_GUI=0` before launching the loop.
