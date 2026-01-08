# MCP Playwright Testing Overview

The Codex loop can now trigger deterministic Playwright smoke tests that are described in natural language and compiled into executable steps. The workflow is deliberately split into three artifacts so the same specification can drive many auto-fix iterations:

1. **NLP testing brief (`testing_nlp_instructions.md`).** A living guide that explains how to describe desired scenarios in natural language.
2. **Example NLP brief (`testing_nlp_demo.md`).** A ready-to-share sample you can paste into an MCP server request to illustrate the format (see “Scenario A/B/C” inside the file).
3. **Reusable MCP Playwright plan (`mcp-playwright-plan.json`).** A structured version of the brief that enumerates routes, selectors, and actions. Generate or edit this JSON manually or with whatever MCP/LLM you prefer; it is **not** produced automatically by the runner.
4. **Deterministic Playwright driver (`mcp_playwright_runner.ts`).** A thin automation harness that interprets the plan and executes it with Playwright — no LLM is invoked here, only the Playwright API.

## How to define tests

1. Write or update the natural-language goals in `testing_nlp_instructions.md` (and refer to `testing_nlp_demo.md` for a concrete “what good looks like” example) so teammates know what each scenario covers (login, checkout, uploads, etc.).
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

## FAQ

**Which LLM does `playwright/mcp_playwright_runner.ts` use to build the plan?**  
None. The runner never calls an LLM; it simply consumes the JSON plan that you (or any MCP server/LLM you choose) provide. If you want an LLM to help with selector discovery, run it separately to write `mcp-playwright-plan.json`, then rerun the deterministic runner.
