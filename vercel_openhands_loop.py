import subprocess
import time
from pathlib import Path
import os
import shutil
import select
import pty
import sys
from dotenv import load_dotenv
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
VERCEL_TEAM_ID = os.getenv("VERCEL_TEAM_ID", "")

MAX_ITERATIONS = int(os.getenv("MAX_ITERATIONS", 10))
SLEEP_AFTER_PUSH_SECONDS = int(os.getenv("SLEEP_AFTER_PUSH_SECONDS", 90))

# OpenHands LLM config
LLM_MODEL = os.getenv("LLM_MODEL", "openhands/claude-sonnet-4-5-20250929")
LLM_API_KEY = os.getenv("LLM_API_KEY")
LLM_BASE_URL = os.getenv("LLM_BASE_URL")
OPENHANDS_MAX_TURNS = int(os.getenv("OPENHANDS_MAX_TURNS", "8"))

# =========================
# HELPER FUNCTIONS
# =========================


def git_workdir_has_changes() -> bool:
    """
    Return True if there are unstaged or staged changes in the repo.
    """
    result = subprocess.run(
        ["git", "diff", "--quiet"],
        cwd=REPO_PATH,
        text=True,
    )
    if result.returncode != 0:
        return True

    result = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=REPO_PATH,
        text=True,
    )
    return result.returncode != 0


def run(cmd, cwd=None, input_text=None, check=True, env=None, encoding="utf-8", errors="replace"):
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
        env=env,
        encoding=encoding,
        errors=errors,
    )
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed: {' '.join(cmd)}\n"
            f"Exit code: {result.returncode}\n"
            f"STDOUT:\n{result.stdout}\n"
            f"STDERR:\n{result.stderr}"
        )
    return result.stdout, result.stderr, result.returncode


def run_with_pty(
    cmd,
    cwd=None,
    input_text: str | None = None,
    env=None,
    stream_to_stdout: bool = False,
    timeout_seconds: float = 120.0,
    send_eot: bool = True,
    auto_yes: bool = True,
    nudge_after_silence: float = 30.0,
) -> tuple[str, str, int]:
    """
    Run a command attached to a pseudo-TTY. Useful for CLIs that refuse to run
    without a terminal (e.g., they probe cursor position).

    Returns (stdout_and_stderr, "", returncode).
    """
    master_fd, slave_fd = pty.openpty()
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            text=False,
        )
    finally:
        os.close(slave_fd)

    output = bytearray()
    start = time.time()
    last_output = start
    last_heartbeat = start
    timed_out = False
    killed = False
    terminate_at = None
    timeout_deadline = start + timeout_seconds if timeout_seconds else None

    if input_text:
        try:
            os.write(master_fd, input_text.encode("utf-8", errors="replace"))
            os.write(master_fd, b"\n")
            if send_eot:
                os.write(master_fd, b"\x04")
        except OSError:
            pass

    while True:
        now = time.time()
        if timeout_deadline and now > timeout_deadline and not timed_out:
            timed_out = True
            terminate_at = now
            print("[warn] PTY command exceeded timeout; terminating...", flush=True)
            proc.terminate()
        if timed_out and not killed and terminate_at and (now - terminate_at) > 3.0:
            killed = True
            print("[warn] PTY process did not exit; killing...", flush=True)
            proc.kill()

        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if master_fd in ready:
            try:
                chunk = os.read(master_fd, 1024)
            except OSError:
                break
            if not chunk:
                break
            if b"\x1b[6n" in chunk:
                try:
                    os.write(master_fd, b"\x1b[1;1R")
                except OSError:
                    pass
                chunk = chunk.replace(b"\x1b[6n", b"")
            output.extend(chunk)
            if stream_to_stdout and chunk:
                try:
                    sys.stdout.buffer.write(chunk)
                    sys.stdout.flush()
                except Exception:
                    pass
            if chunk:
                last_output = now
            if auto_yes and b"Would you like to run the following command?" in chunk:
                try:
                    os.write(master_fd, b"y\n")
                except OSError:
                    pass
            if auto_yes and b"Press enter to confirm" in chunk:
                try:
                    os.write(master_fd, b"\n")
                except OSError:
                    pass

        if (now - last_output) > 10 and (now - last_heartbeat) > 10:
            print("[info from the loop] PTY command still running (no new output)...", flush=True)
            last_heartbeat = now

        if nudge_after_silence and (now - last_output) > nudge_after_silence:
            try:
                os.write(master_fd, b"\n")
                last_output = now
                print("[debug from the loop] Sent newline to nudge interactive prompt.", flush=True)
            except OSError:
                pass

        if proc.poll() is not None and not ready:
            break

    while True:
        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if master_fd not in ready:
            break
        try:
            chunk = os.read(master_fd, 1024)
        except OSError:
            break
        if not chunk:
            break
        output.extend(chunk)
        if stream_to_stdout and chunk:
            try:
                sys.stdout.buffer.write(chunk)
                sys.stdout.flush()
            except Exception:
                pass

    try:
        os.close(master_fd)
    except OSError:
        pass
    if timed_out:
        try:
            rc = proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            rc = proc.wait()
    else:
        rc = proc.wait()
    text_out = output.decode("utf-8", errors="replace")
    return text_out, "", rc


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

    print(f"[info from the loop] Inspecting deployment {dep_id} ...")
    cmd = ["vercel", "inspect", dep_id, "--logs", "--wait"]

    stdout, stderr, _ = run(cmd, cwd=REPO_PATH, check=False, env=env)
    logs = stdout if stdout.strip() else stderr
    if not logs.strip():
        print("[warn] No logs returned from Vercel for this deployment.")
        return ""

    print("[info from the loop] Log snippet:")
    print("\n".join(logs.splitlines()[-15:]))
    return logs


def get_current_commit_hash(short: bool = True) -> str:
    """Return the current HEAD commit hash (short or full)."""
    if short:
        cmd = ["git", "rev-parse", "--short=7", "HEAD"]
    else:
        cmd = ["git", "rev-parse", "HEAD"]
    stdout, _, _ = run(cmd, cwd=REPO_PATH, check=True)
    return stdout.strip()


def get_deployment_id_for_current_commit() -> str | None:
    """
    Find the Vercel deployment whose commit hash matches the current HEAD.

    Works with older Vercel CLI (no --json, no --limit):

    - Run `vercel list` in the linked project dir (uses .vercel/project.json).
    - Parse deployment IDs from the first column of the table.
    - For each ID, run `vercel inspect <id>` and search for the short commit hash.
    """

    commit_short = get_current_commit_hash(short=True)
    print(f"[info from the loop] Looking for deployment of commit {commit_short}...")

    env = os.environ.copy()
    if VERCEL_TOKEN:
        env["VERCEL_AUTH_TOKEN"] = VERCEL_TOKEN
    if VERCEL_TEAM_ID:
        env["VERCEL_TEAM_ID"] = VERCEL_TEAM_ID

    cmd = ["vercel", "list"]
    stdout, stderr, rc = run(cmd, cwd=REPO_PATH, check=False, env=env)

    if rc != 0 or not stdout.strip():
        print("[warn] `vercel list` failed or returned no data.")
        if stderr.strip():
            print("[vercel list stderr]")
            print(stderr)
        return None

    dep_ids: list[str] = []
    for line in stdout.splitlines():
        raw = line.rstrip()
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped.startswith("Vercel CLI"):
            continue
        lower = stripped.lower()
        if lower.startswith("age ") or lower.startswith("deployment") or lower.startswith("id "):
            continue
        if set(stripped) <= {"─", "━", " ", "┌", "└", "┼", "│", "┐", "┘"}:
            continue

        parts = stripped.split()
        if not parts:
            continue

        dep_id = parts[0]
        is_url = ".vercel.app" in dep_id or dep_id.startswith("https://")
        is_raw_id = (
            dep_id.startswith("dpl_")
            or (dep_id.isalnum() and len(dep_id) >= 8 and any(ch.isdigit() for ch in dep_id))
        )
        if is_url or is_raw_id:
            dep_ids.append(dep_id)

    if not dep_ids:
        print("[warn] Could not parse any deployment IDs from `vercel list`.")
        return None

    print(f"[info from the loop] Parsed {len(dep_ids)} deployment candidates from `vercel list`.")

    for dep_id in dep_ids:
        print(f"[debug from the loop] Inspecting deployment {dep_id} for commit {commit_short}...")
        insp_out, insp_err, _ = run(
            ["vercel", "inspect", dep_id, "--logs"],
            cwd=REPO_PATH,
            check=False,
            env=env,
        )
        combined = f"{insp_out}\n{insp_err}"
        if commit_short in combined:
            print(f"[info from the loop] Matched commit {commit_short} to deployment {dep_id}")
            return dep_id

    print(f"[warn] No deployment found for commit {commit_short} in {len(dep_ids)} candidates.")
    return None


def build_looks_successful(logs: str) -> bool:
    """
    Naive heuristic to decide whether the build is 'clean enough'.
    Adjust this to match your project’s real success markers.
    """
    text = logs.lower()

    possible_failure_markers = [
        "error ",
        "failed",
        "build failed",
        "exit code 1",
        "command \"npm run build\" exited with 1",
    ]
    if any(marker in text for marker in possible_failure_markers):
        return False

    possible_success_markers = [
        "deployment completed",
        "build completed",
        "ready! deployed to",
    ]
    return any(marker in text for marker in possible_success_markers)


def run_codex_on_logs(logs: str) -> bool:
    """
    OpenHands-powered fixer:
      - Writes logs to dev_debug_logs.md for context
      - Runs an OpenHands agent (LLM + tools) in the repo workspace
      - Returns True if repo changed, False otherwise
    """
    print("\n[step] Running OpenHands with latest build logs...")

    if not logs.strip():
        print("[info from the loop] No logs provided to agent. Skipping.")
        return False

    try:
        from openhands.sdk import LLM, Agent, Conversation, Tool
        from openhands.tools.file_editor import FileEditorTool
        from openhands.tools.terminal import TerminalTool
        from openhands.tools.task_tracker import TaskTrackerTool
    except ImportError:
        print("[error] OpenHands SDK not installed. Install with `pip install openhands-sdk`.")
        return False

    logs_file = REPO_PATH / "dev_debug_logs.md"
    try:
        logs_file.write_text(
            f"# Vercel build logs\n\nFetched: {time.strftime('%Y-%m-%d %H:%M:%S %Z')}\n\n```\n{logs}\n```\n",
            encoding="utf-8",
        )
        print(f"[info] Wrote logs to {logs_file} for agent context.")
    except Exception as e:
        print(f"[warn] Could not write logs file {logs_file}: {e}")

    had_changes_before = git_workdir_has_changes()

    system_prompt = (
        "You are OpenHands running in an autofix loop for a Vercel deployment.\n"
        "Goal: diagnose the build failure from the Vercel logs and modify the repo to fix it.\n"
        "Rules:\n"
        "- Edit files as needed, but do NOT commit.\n"
        "- Prefer minimal, targeted changes.\n"
        "- Do NOT rely on local node_modules or locally built artifacts; reason from the Vercel build logs and repo source.\n"
        "- If lockfile mismatches are indicated, refresh the lockfile accordingly.\n\n"
        f"The logs are in {logs_file}.\n"
        "Start by reading that file."
    )

    llm = LLM(
        model=LLM_MODEL,
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL,
    )

    agent = Agent(
        llm=llm,
        tools=[
            Tool(name=TerminalTool.name),
            Tool(name=FileEditorTool.name),
            Tool(name=TaskTrackerTool.name),
        ],
        system_prompt=system_prompt,
    )

    conversation = Conversation(agent=agent, workspace=str(REPO_PATH))
    conversation.send_message("Fix the Vercel build based on the logs file specified in the system prompt.")
    try:
        conversation.run(max_turns=OPENHANDS_MAX_TURNS)
    except TypeError:
        conversation.run()

    has_changes_after = git_workdir_has_changes()
    if not has_changes_after and not had_changes_before:
        print("[info from the loop] OpenHands made no file changes.")
        return False

    print("[info from the loop] OpenHands appears to have modified the repo.")
    return True


def git_commit_and_push() -> bool:
    """
    git add/commit/push. Returns True if something was pushed, False if nothing changed.
    """
    print("\n[step] Git add/commit/push...")

    run(["git", "add", "-A"], cwd=REPO_PATH)

    commit_msg = "chore: auto-fix by openhands based on Vercel build logs"
    stdout, stderr, returncode = run(
        ["git", "commit", "-m", commit_msg],
        cwd=REPO_PATH,
        check=False,
    )

    if returncode != 0:
        if "nothing to commit" in stdout.lower() or "nothing to commit" in stderr.lower():
            print("[info from the loop] Nothing to commit. Skipping push.")
            return False
        raise RuntimeError(
            f"git commit failed unexpectedly:\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
        )

    print("[info from the loop] Commit created:")
    print(stdout)

    stdout, stderr, returncode = run(
        ["git", "push", GIT_REMOTE, GIT_BRANCH],
        cwd=REPO_PATH,
        check=False,
    )
    if returncode != 0:
        raise RuntimeError(
            f"git push failed:\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
        )

    print("[info from the loop] git push completed.")
    return True


# =========================
# MAIN LOOP
# =========================


def main():
    print("[start] Vercel ↔ OpenHands auto-fix loop")
    print(f"Repo:   {REPO_PATH}")
    print(f"Branch: {GIT_BRANCH}")
    print(f"URL:    {PROD_URL}")

    for i in range(1, MAX_ITERATIONS + 1):
        print(f"\n==============================")
        print(f"Iteration {i}/{MAX_ITERATIONS}")
        print(f"==============================")

        logs = fetch_latest_build_logs()
        if not logs.strip():
            print("[warn] No logs found. Sleeping and retrying...")
            time.sleep(SLEEP_AFTER_PUSH_SECONDS)
            continue

        if build_looks_successful(logs):
            print("[info from the loop] Build looks successful 🎉")
            print("[done] Stopping loop.")
            return

        changed = run_codex_on_logs(logs)
        if not changed:
            print("[info from the loop] OpenHands has no further changes. Stopping loop.")
            return

        pushed = git_commit_and_push()
        if not pushed:
            print("[info from the loop] No code changes actually pushed. Stopping loop.")
            return

        print(f"[info from the loop] Sleeping {SLEEP_AFTER_PUSH_SECONDS}s while Vercel builds...")
        time.sleep(SLEEP_AFTER_PUSH_SECONDS)

    print(f"[stop] Reached MAX_ITERATIONS={MAX_ITERATIONS}. Exiting.")


if __name__ == "__main__":
    main()

# cd /path/to/your/repo
# python /abs_path_to/vercel_openhands_loop.py
