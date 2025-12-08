import subprocess
import time
from pathlib import Path
import os
from dotenv import load_dotenv
from pathlib import Path
import json

load_dotenv()  # Loads .env from repo root
# =========================
# CONFIGURATION
# =========================

REPO_PATH = Path(os.getenv("REPO_PATH")).resolve()
PROD_URL = os.getenv("PROD_URL")

GIT_REMOTE = os.getenv("GIT_REMOTE", "origin")
GIT_BRANCH = os.getenv("GIT_BRANCH", "main")

VERCEL_TOKEN = os.getenv("VERCEL_TOKEN")

# Convert command string to a list
CODEX_CMD = os.getenv("CODEX_CMD", "echo NO_CHANGES").split()

MAX_ITERATIONS = int(os.getenv("MAX_ITERATIONS", 10))
SLEEP_AFTER_PUSH_SECONDS = int(os.getenv("SLEEP_AFTER_PUSH_SECONDS", 90))

# =========================
# HELPER FUNCTIONS
# =========================


def get_current_commit_hash(short=True) -> str:
    """Return the current HEAD commit hash (short or full)."""
    if short:
        cmd = ["git", "rev-parse", "--short=7", "HEAD"]
    else:
        cmd = ["git", "rev-parse", "HEAD"]
    stdout, _, _ = run(cmd, cwd=REPO_PATH, check=True)
    return stdout.strip()

def git_workdir_has_changes() -> bool:
    """
    Return True if there are unstaged or staged changes in the repo.
    """
    # unstaged
    result = subprocess.run(
        ["git", "diff", "--quiet"],
        cwd=REPO_PATH,
        text=True,
    )
    if result.returncode != 0:
        return True

    # staged
    result = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=REPO_PATH,
        text=True,
    )
    return result.returncode != 0


def get_deployment_id_for_current_commit() -> str | None:
    """
    Find the Vercel deployment whose commit hash matches the current HEAD.

    Strategy:
    - Get HEAD short hash (e.g. '3cc8afc')
    - Call `vercel list --prod --json --limit 20`
    - Look for that hash in deployment metadata
    - Return deployment ID/uid if found
    """
    commit_short = get_current_commit_hash(short=True)
    print(f"[info] Looking for deployment of commit {commit_short}...")

    env = os.environ.copy()
    if VERCEL_TOKEN:
        env["VERCEL_AUTH_TOKEN"] = VERCEL_TOKEN
    if VERCEL_TEAM_ID:
        env["VERCEL_TEAM_ID"] = VERCEL_TEAM_ID

    cmd = ["vercel", "list", "--prod", "--json", "--limit", "20"]
    stdout, stderr, rc = run(cmd, cwd=REPO_PATH, check=False, env=env)

    if rc != 0 or not stdout.strip():
        print("[warn] `vercel list` failed or returned no data.")
        if stderr.strip():
            print("[vercel list stderr]")
            print(stderr)
        return None

    try:
        deployments = json.loads(stdout)
    except json.JSONDecodeError:
        print("[warn] Failed to parse `vercel list` JSON, cannot map commit → deployment.")
        return None

    # Some versions return {"deployments":[...]} instead of a raw list
    if isinstance(deployments, dict) and "deployments" in deployments:
        deployments = deployments["deployments"]

    # 1st pass: look in known meta fields
    for dep in deployments:
        meta = dep.get("meta", {}) or {}
        candidate_shas = [
            meta.get("githubCommitSha"),
            meta.get("gitlabCommitSha"),
            meta.get("bitbucketCommitSha"),
            meta.get("commit"),
        ]
        for sha in candidate_shas:
            if isinstance(sha, str) and sha.startswith(commit_short):
                dep_id = dep.get("uid") or dep.get("id") or dep.get("deploymentId")
                print(f"[info] Matched commit {commit_short} to deployment {dep_id}")
                return dep_id

    # 2nd pass: brute-force search in the whole JSON object as string
    for dep in deployments:
        dep_str = json.dumps(dep)
        if commit_short in dep_str:
            dep_id = dep.get("uid") or dep.get("id") or dep.get("deploymentId")
            print(f"[info] Fuzzy match commit {commit_short} → deployment {dep_id}")
            return dep_id

    print(f"[warn] No deployment found for commit {commit_short}.")
    return None


def run(cmd, cwd=None, input_text=None, check=True):
    """
    Run a shell command and return stdout as text.
    Raises RuntimeError on non-zero exit code if check=True.
    """
    result = subprocess.run(
        cmd,
        cwd=cwd,
        input=input_text,
        text=True,
        capture_output=True,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed: {' '.join(cmd)}\n"
            f"Exit code: {result.returncode}\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        )
    return result.stdout, result.stderr, result.returncode


def fetch_latest_build_logs() -> str:
    """Fetch logs for the deployment that corresponds to the current HEAD commit."""
    print("\n[step] Fetching Vercel build logs for current commit...")

    env = os.environ.copy()
    if VERCEL_TOKEN:
        env["VERCEL_AUTH_TOKEN"] = VERCEL_TOKEN
    if VERCEL_TEAM_ID:
        env["VERCEL_TEAM_ID"] = VERCEL_TEAM_ID

    dep_id = get_deployment_id_for_current_commit()
    if not dep_id:
        print("[warn] Could not find a deployment for the current commit.")
        return ""

    print(f"[info] Inspecting deployment {dep_id} ...")
    cmd = ["vercel", "inspect", dep_id, "--logs", "--wait"]

    stdout, stderr, _ = run(cmd, cwd=REPO_PATH, check=False, env=env)
    if not stdout.strip():
        print("[warn] No logs returned from Vercel for this deployment.")
        if stderr.strip():
            print("[vercel inspect stderr]")
            print(stderr)
        return ""

    print("[info] Log snippet:")
    print("\n".join(stdout.splitlines()[-15:]))
    return stdout


def build_looks_successful(logs: str) -> bool:
    """
    Naive heuristic to decide whether the build is 'clean enough'.
    Adjust this to match your project’s real success markers.
    """
    text = logs.lower()

    # Typical failure hints
    possible_failure_markers = [
        "error ",
        "failed",
        "build failed",
        "exit code 1",
        "command \"npm run build\" exited with 1",
    ]
    if any(marker in text for marker in possible_failure_markers):
        return False

    # Some positive indicators – you can tune these
    possible_success_markers = [
        "deployment completed",
        "build completed",
        "ready! deployed to",
    ]
    return any(marker in text for marker in possible_success_markers)


def run_codex_on_logs(logs: str) -> bool:
    """
    Send logs to Codex via stdin. Returns:
      True  -> Codex did apply changes (or thinks it did)
      False -> Codex says 'no changes' or exit code indicates nothing done

    You *must* adapt this to however your local Codex tool behaves.
    """
    print("\n[step] Running Codex with latest build logs...")
    stdout, stderr, returncode = run(
        CODEX_CMD,
        cwd=REPO_PATH,
        input_text=logs,
        check=False,  # we handle non-zero ourselves
    )

    print("[codex stdout]")
    print(stdout)
    if stderr.strip():
        print("\n[codex stderr]")
        print(stderr)

    # Example convention: Codex prints "NO_CHANGES" if everything is fine
    if "NO_CHANGES" in stdout.upper():
        print("[info] Codex reports no changes needed.")
        return False

    if returncode != 0:
        print(f"[warn] Codex exited with non-zero code ({returncode}). "
              f"Treating as 'no further changes'.")
        return False

    print("[info] Codex appears to have made changes.")
    return True


def git_commit_and_push() -> bool:
    """
    git add/commit/push. Returns True if something was pushed, False if nothing changed.
    """
    print("\n[step] Git add/commit/push...")

    # Stage everything
    run(["git", "add", "-A"], cwd=REPO_PATH)

    # Commit; if nothing to commit, git will exit non-zero
    commit_msg = "chore: auto-fix by codex based on Vercel build logs"
    stdout, stderr, returncode = run(
        ["git", "commit", "-m", commit_msg],
        cwd=REPO_PATH,
        check=False,
    )

    if returncode != 0:
        if "nothing to commit" in stdout.lower() or "nothing to commit" in stderr.lower():
            print("[info] Nothing to commit. Skipping push.")
            return False
        raise RuntimeError(
            f"git commit failed unexpectedly:\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
        )

    print("[info] Commit created:")
    print(stdout)

    # Push
    stdout, stderr, returncode = run(
        ["git", "push", GIT_REMOTE, GIT_BRANCH],
        cwd=REPO_PATH,
        check=False,
    )
    if returncode != 0:
        raise RuntimeError(
            f"git push failed:\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
        )

    print("[info] git push completed.")
    return True

def apply_codex_fixes(logs: str) -> bool:
    """
    Use Codex CLI (`codex exec`) to try to fix the build based on Vercel logs.

    Strategy:
    - Build a task message that includes the logs.
    - Run `codex exec` with --full-auto and a sandbox mode that allows file edits.
    - Compare git diff before/after to see if any files changed.
    """
    print("\n[step] Running Codex (codex exec) to apply fixes...")

    if not logs.strip():
        print("[info] No logs provided to Codex. Skipping.")
        return False

    # Check if there were already changes before Codex runs
    had_changes_before = git_workdir_has_changes()

    # Build the task string for Codex CLI
    task = (
        "You are Codex running in a CI autofix loop for a Vercel deployment.\n\n"
        "The build or deployment has failed. Your goal:\n"
        "1. Read the build logs.\n"
        "2. Identify the root cause of the failure.\n"
        "3. Modify files in this Git repository to fix the issue.\n"
        "4. DO NOT commit; just edit files. A separate step will commit and push.\n\n"
        "Here are the Vercel logs:\n\n"
        f"{logs}\n"
    )

    # Environment for Codex; it can reuse OpenAI CLI auth or you can set CODEX_API_KEY
    env = os.environ.copy()
    # Example: if you want to override per-run, set CODEX_API_KEY in .env
    # env["CODEX_API_KEY"] = os.getenv("CODEX_API_KEY", env.get("CODEX_API_KEY", ""))

    cmd = [
        "codex",
        "exec",
        "--full-auto",                 # allow Codex to edit files
        "--sandbox",
        "workspace-write",             # allow writes inside repo, but no arbitrary network
        task,
    ]

    stdout, stderr, returncode = run(cmd, cwd=REPO_PATH, check=False, env=env)

    # Stream Codex info for debugging
    print("\n[codex stdout - final message]")
    print(stdout)
    if stderr.strip():
        print("\n[codex stderr - activity log]")
        print(stderr)

    if returncode != 0:
        print(f"[warn] Codex exited with non-zero status ({returncode}). "
              f"Treating as 'no changes'.")
        return False

    # Check if Codex actually changed anything
    has_changes_after = git_workdir_has_changes()

    if not has_changes_after and not had_changes_before:
        print("[info] Codex made no file changes.")
        return False

    print("[info] Codex appears to have modified the repo.")
    return True

# =========================
# MAIN LOOP
# =========================

def main():
    print("[start] Vercel ↔ Codex auto-fix loop")
    print(f"Repo:   {REPO_PATH}")
    print(f"Branch: {GIT_BRANCH}")
    print(f"URL:    {PROD_URL}")

    for i in range(1, MAX_ITERATIONS + 1):
        print(f"\n==============================")
        print(f"Iteration {i}/{MAX_ITERATIONS}")
        print(f"==============================")

        # 1. Fetch current build logs
        logs = fetch_latest_build_logs()
        if not logs.strip():
            print("[warn] No logs found. Sleeping and retrying...")
            time.sleep(SLEEP_AFTER_PUSH_SECONDS)
            continue

        # 2. If build is already clean AND we’ve looped at least once, we can stop
        if build_looks_successful(logs):
            print("[info] Build looks successful 🎉")
            print("[done] Stopping loop.")
            return

        # 3. Ask Codex to fix issues based on the logs
        changed = run_codex_on_logs(logs)
        if not changed:
            print("[info] Codex has no further changes. Stopping loop.")
            return

        # 4. Commit & push changes (this triggers a new Vercel deployment)
        pushed = git_commit_and_push()
        if not pushed:
            print("[info] No code changes actually pushed. Stopping loop.")
            return

        # 5. Give Vercel time to build the new commit
        print(f"[info] Sleeping {SLEEP_AFTER_PUSH_SECONDS}s while Vercel builds...")
        time.sleep(SLEEP_AFTER_PUSH_SECONDS)

    print(f"[stop] Reached MAX_ITERATIONS={MAX_ITERATIONS}. Exiting.")


if __name__ == "__main__":
    main()

# cd /path/to/your/repo
# python /abs_path_to/vercel_codex_loop.py