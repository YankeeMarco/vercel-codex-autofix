# 📦 vercel-codex-autofix

An autonomous self-healing deployment loop for Vercel projects.

`vercel-codex-autofix` continuously watches the exact Vercel build corresponding to your current Git commit, diagnoses failures from build logs, applies fixes using Codex, commits the patch, and redeploys — automatically.

No dashboards.  
No manual log hunting.  
No refspec confusion.

⸻

✨ **What this project does** (in plain terms)

For the currently checked-out Git commit:
1. Finds the exact Vercel deployment triggered by that commit
2. Fetches its build logs
3. Feeds the logs into Codex (local agent)
4. Applies minimal, targeted code fixes
5. Commits and pushes to your active branch
6. Triggers a new Vercel deployment
7. Repeats until the build succeeds or stops safely

This creates a closed-loop, commit-aware, zero-touch build repair system.

⸻

🧠 **Key design principles**

- Commit-centric (not URL-centric)  
  Logs are matched to the exact Git commit using `vercel list -m githubCommitSha=<sha>` — avoids false positives.
- Safe automation  
  Codex edits files but **never commits**. Git operations are explicit and controlled by the script.
- CLI-first, version-agnostic  
  Works even when `vercel list --json` behaves unexpectedly.
- Self-terminating  
  Stops cleanly when: build succeeds, Codex makes no changes, or max iterations reached.

⸻

🏗 **Architecture Overview**

```
┌────────────────┐
│ Git Commit     │
└───────┬────────┘
        ▼
┌─────────────────────────┐
│ Vercel Deployment       │
│ (matched by commit ID)  │
└───────┬─────────────────┘
        ▼
[1] Fetch build logs
        ▼
[2] Write logs to dev_debug_logs.md
        ▼
[3] Codex reads logs and edits repo
        ▼
[4] Git commit + push (active branch)
        ▼
[5] Vercel redeploys
        ▼
[6] Loop until success
        │
        ▼ (optional post-success)
┌─────────────────────────────┐
│ Local Next.js Harness Test  │ ← See companion tool below
└─────────────────────────────┘
```

⸻

📦 **Requirements**

- Node.js 18+
- Git
- Vercel CLI (`npm i -g vercel`)
- Codex CLI or Codex SDK
- A Vercel project already connected to your repo

**Recommended companion** (for faster local validation & agent debugging):  
[Next.js Runtime Harness](https://github.com/your-org/nextjs-harness) — a fixed Docker base for isolated, reproducible Next.js runs (mount your repo, share global pnpm cache, healthchecks).

⸻

📥 **Installation**

```bash
git clone https://github.com/yankeemarco/vercel-codex-autofix.git
cd vercel-codex-autofix

npm install
npm install -D ts-node typescript @types/node
```

⸻

⚙️ **Configuration** (`.env`)

Create `.env` in the script directory:

```
# --- Vercel Authentication ---
VERCEL_TOKEN=vcpat_your_token_here
VERCEL_TEAM_ID=

# --- Repo Configuration ---
REPO_PATH=/absolute/path/to/your/project
GIT_REMOTE=origin
GIT_BRANCH=   # optional; auto-detected if empty

# --- Deployment Configuration ---
PROD_URL=https://your-project.vercel.app

# --- Codex ---
CODEX_USE_EXEC=1   # use Codex CLI (recommended)

# --- Loop Control ---
MAX_ITERATIONS=10
SLEEP_AFTER_PUSH_SECONDS=90
RUN_PREFLIGHT=0  # set to 1 to run local checks (tsc/lint/tests) before committing

# --- MCP Playwright GUI checks ---
RUN_MCP_GUI=1
MCP_GUI_SCRIPT=          # override runtime script path if needed
MCP_GUI_LOG_DIR=         # override logs dir if needed
MCP_GUI_ROUTES=          # override routes file if needed
# Where runtime assets live (defaults to <REPO_PATH>/vercel_codex_autofix)
VERCEL_CODEX_RUNTIME=
```

Note: Script loads `.env` relative to `vercel_codex_loop.ts`. Override with `DOTENV_CONFIG_PATH=/path/to/.env`.

🔑 **Vercel token**  
Create at: https://vercel.com/account/tokens

⸻

▶️ **How to run** (recommended)

```bash
CODEX_USE_EXEC=1 npx ts-node ~/Documents/vercel-codex-autofix/vercel_codex_loop.ts
```

- Auto-detects current branch & pushes to it
- No manual `--ref` or branch args needed

**Optional initial task** (e.g. feature request before log loop):

```bash
CODEX_USE_EXEC=1 npx ts-node .../vercel_codex_loop.ts "add facebook auth"
```

Empty string `""` skips initial task.

**Manual MCP GUI check** (post-first-run):

```bash
bash vercel_codex_autofix/mcp/run-gui-check.sh https://your-app.vercel.app
```

Artifacts → `vercel_codex_autofix/logs/gui/` + `.autofix/gui_report.md`

⸻

🔄 **What happens when you run it**

1. Reads current commit hash
2. Finds matching deployment via `vercel list`
3. Fetches logs: `vercel inspect <deployment> --logs --wait`
4. Writes to `dev_debug_logs.md`
5. Runs Codex with autofix prompt
6. If changes → `git add -A`, commit, push to active branch
7. Wait → repeat
8. On success → runs MCP GUI scout (if enabled); GUI fails → feed back to Codex

⸻

🧪 **Example output**

```
[start] Vercel ↔ Codex auto-fix loop (TypeScript)
Repo:   /Users/jacky/Documents/zeda_video
Branch: master
URL:    https://zeda-xxxx.vercel.app

Iteration 1/10
[info] Looking for deployment of commit 3cc8afc...
[info] Matched commit to deployment dpl_abc123
[step] Fetching Vercel build logs...
[step] Running Codex with latest build logs...
[info] Codex appears to have modified the repo.
[step] Git add/commit/push...
[info] git push completed.
```

⸻

🧪 **MCP Playwright GUI scout**

- Define routes in `<REPO>/vercel_codex_autofix/mcp/gui-routes.json`
- Loop auto-generates `gui-tests.md` + `gui-plan.generated.json`
- On successful deploy → runs `npx @playwright/mcp` via helper script
- FAIL reports → become next Codex input + traces/videos saved
- Disable: `RUN_MCP_GUI=0`
- Manual run: `bash vercel_codex_autofix/mcp/run-gui-check.sh https://your-app.vercel.app`

⸻

🛑 **Stop conditions** (safety)

Loop exits when:
- Build logs show success
- Codex makes no changes
- Git has nothing to commit
- `MAX_ITERATIONS` reached

No infinite loops.

⸻

🔧 **Customization ideas**

- Replace success heuristics with stricter checks
- Switch to PR mode (instead of direct push)
- Add multiple Codex passes
- Integrate structured error classification
- **Run local Next.js Harness tests** after each successful deploy (before MCP GUI) for fast smoke/validation
- GitHub Actions runner
- Multi-agent repair strategies

⸻

🧯 **Stability tips** (avoid A↔B oscillation)

- Add regression bundles: store error signatures + repros
- Canonicalize logs into signatures → detect repeats
- Enforce monotonic progress (failure score)
- Freeze high-risk files (lockfiles, tsconfig, etc.)
- Keep decision records for agent learning
- Propose → critic multi-agent passes

⸻

🧰 **Companion: Next.js Runtime Harness**

For local, reproducible Next.js testing (great for pre-commit validation or Codex debugging):

Use the fixed Docker harness: https://github.com/your-org/nextjs-harness (or similar)

Quick example (mount your repo):

```bash
docker run --rm -it \
  -p 3000:3000 \
  -v /path/to/your-project:/workspace \
  -v pnpm-store:/pnpm-store \
  -w /workspace \
  --health-cmd="curl -f http://localhost:3000 || exit 1" \
  nextjs-harness:node24 \
  sh -c "pnpm install && pnpm dev"
```

- Global named volume `pnpm-store` (create once: `docker volume create pnpm-store`)
- Shared cache → fast installs across projects
- Healthcheck → reliable MCP/automation signals

Add to your workflow: run this after each successful Vercel deploy for local smoke test before GUI scout.

⸻

⛑️ **Troubleshooting**

Codex CLI `invalid_encrypted_content`:
```bash
codex logout
rm -rf ~/.codex/sessions ~/.codex/auth.json
codex --config preferred_auth_method=chatgpt
codex login
codex whoami
```

⸻

🌱 **Roadmap**

- GitHub Actions runner
- PR-based autofix mode
- Multi-agent repair strategies
- Native Vercel API integration
- Build-log diff intelligence
- **Tight integration with Next.js Runtime Harness** for local pre-verification loops

⸻

📄 **License**

MIT License.
