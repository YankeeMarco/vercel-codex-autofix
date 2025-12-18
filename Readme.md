 📦 vercel-codex-autofix

An autonomous self-healing deployment loop for Vercel projects.

vercel-codex-autofix continuously watches the exact Vercel build corresponding to your current Git commit, diagnoses failures from build logs, applies fixes using Codex, commits the patch, and redeploys — automatically.

No dashboards.
No manual log hunting.
No refspec confusion.

⸻

✨ What this project does (in plain terms)

For the currently checked-out Git commit:
	1.	Finds the exact Vercel deployment triggered by that commit
	2.	Fetches its build logs
	3.	Feeds the logs into Codex (local agent)
	4.	Applies minimal, targeted code fixes
	5.	Commits and pushes to your active branch
	6.	Triggers a new Vercel deployment
	7.	Repeats until the build succeeds or stops safely

This creates a closed-loop, commit-aware, zero-touch build repair system.

⸻

🧠 Key design principles
	•	Commit-centric (not URL-centric)
Logs are matched to the exact Git commit, not just the production URL.
		•	The script prefers `vercel list -m githubCommitSha=<sha>` to avoid false positives when scanning logs.
	•	Safe automation
Codex edits files but never commits. Git commits are done explicitly by the script.
	•	CLI-first, version-agnostic
Works even when vercel list --json is unavailable.
	•	Self-terminating
Stops when:
	•	build succeeds
	•	Codex makes no changes
	•	max iterations reached

⸻

🏗 Architecture Overview
```txt
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
```

⸻

📦 Requirements
	•	Node.js 18+
	•	Git
	•	Vercel CLI (npm i -g vercel)
	•	Codex CLI or Codex SDK
	•	A Vercel project already connected to your repo

⸻

📥 Installation
```bash
git clone https://github.com/yankeemarco/vercel-codex-autofix.git
cd vercel-codex-autofix

npm install
npm install -D ts-node typescript @types/node
```

⸻

⚙️ Configuration (.env)

Create a .env file:
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
```

Note:
	•	The script loads `.env` from the same directory as `vercel_codex_loop.ts` (so you can run it from any working directory).
	•	To override, set `DOTENV_CONFIG_PATH=/path/to/.env`.
	•	If `GIT_BRANCH` is set but doesn’t exist locally, the script falls back to your current branch.

🔑 Vercel token

Create at:
👉 https://vercel.com/account/tokens

⸻

▶️ How to run (important)

✅ Correct, recommended command

CODEX_USE_EXEC=1 npx ts-node ~/Documents/vercel-codex-autofix/vercel_codex_loop.ts

What this does
	•	Uses Codex CLI (codex exec --full-auto)
	•	Detects your currently checked-out Git branch
	•	Pushes to that active branch (e.g. master or main)
	•	Avoids refspec errors by not hardcoding branch names

You do not need to pass --ref or specify a branch manually.

⸻

🔄 What happens when you run it
	1.	Reads your current commit hash
	2.	Runs vercel list
	3.	Inspects deployments until it finds one containing that commit
	4.	Fetches logs via:

vercel inspect <deployment> --logs --wait


	5.	Writes logs to dev_debug_logs.md
	6.	Runs Codex with clear autofix instructions
	7.	If files changed:
	•	git add -A
	•	git commit
	•	git push origin <active-branch>
	8.	Waits and repeats

⸻

🧪 Example output
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

🛑 Stop conditions (safety)

The loop stops when any is true:
	•	Build logs indicate success
	•	Codex makes no file changes
	•	Git has nothing to commit
	•	MAX_ITERATIONS reached

No infinite loops.

⸻

🔧 Customization ideas
	•	Replace success heuristics with stricter checks
	•	Switch to PR mode instead of direct push
	•	Add multiple Codex passes
	•	Add structured error classification
	•	Integrate with GitHub Actions

⛑️ Troubleshooting
	•	Codex CLI error `invalid_encrypted_content`: clear stale credentials and re-login with ChatGPT auth:
```
codex logout
rm -rf ~/.codex/sessions ~/.codex/auth.json
codex --config preferred_auth_method=chatgpt
codex login
codex whoami   # sanity check
```

⸻

🌱 Roadmap
	•	GitHub Actions runner
	•	PR-based autofix mode
	•	Multi-agent repair strategies
	•	Native Vercel API integration
	•	Build-log diff intelligence

⸻

📄 License

MIT License.
