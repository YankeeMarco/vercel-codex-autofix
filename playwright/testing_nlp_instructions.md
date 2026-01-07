# MCP Playwright Testing Overview

The Codex loop can now trigger deterministic Playwright smoke tests that are described in natural language and compiled into executable steps. The workflow is deliberately split into three artifacts so the same specification can drive many auto-fix iterations:

1. **NLP testing brief (`testing_nlp_instructions.md`, this file).** Describe the intent of the regression checks in prose so humans (or MCP-aware tools) understand the scenarios.
2. **Reusable MCP Playwright plan (`mcp-playwright-plan.json`).** A structured version of the brief that enumerates routes, selectors, and actions. The loop reads this file every time tests run, so you can iterate without changing code.
3. **Deterministic Playwright driver (`mcp_playwright_runner.ts`).** A thin automation harness that interprets the plan and executes it with Playwright — no additional LLM calls inside the GUI automation layer.

## How to define tests

1. Write or update the natural-language goals in this file so teammates know what each scenario covers (login, checkout, uploads, etc.).
2. Translate each goal into a `scenario` object in `mcp-playwright-plan.json`.
   - `path`: entry route (relative to `defaultBaseUrl` or the env var `MCP_PLAYWRIGHT_BASE_URL`).
   - `actions`: ordered steps built from the supported action types below.
3. Keep selectors stable by preferring `data-test="..."` attributes.

### Supported action types

| Type | Purpose | Required fields |
|------|---------|-----------------|
| `goto` | Navigate to a path or full URL. | `path` or `url` |
| `waitForSelector` | Wait for an element to appear/disappear. | `selector`, optional `state` (`visible`, `attached`, etc.) |
| `fill` | Fill an input/textarea. | `selector`, `value` (supports `{{RANDOM}}` token) |
| `click` | Click an element. | `selector` |
| `press` | Send a keypress to an element. | `selector`, `key` |
| `upload` | Attach a file to an `<input type=file>`. | `selector`, `file` (path relative to repo) |
| `expectText` | Assert element text equals/includes expected content. | `selector`, `text`, optional `match` (`equals` or `includes`) |
| `expectUrlContains` | Ensure the current URL contains a substring. | `value` |
| `pause` | Wait for a fixed number of milliseconds. | `ms` |

Add as many scenarios or actions as needed. The runner stops at the first failure and writes detailed logs to `.autofix/playwright_logs.md` for Codex.

## Running the tests manually

```
CODEX_USE_EXEC=1 \
MCP_PLAYWRIGHT_BASE_URL=https://your-app.vercel.app \
npx ts-node playwright/mcp_playwright_runner.ts --plan playwright/mcp-playwright-plan.json
```

The script launches Chromium in headless mode, executes every scenario, and exits non-zero if any action fails. The Codex loop runs the same command automatically after a deployment succeeds, so failing smoke tests immediately feed fresh logs back into the auto-fix cycle.
