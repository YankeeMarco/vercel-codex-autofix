import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import process from "process";
import dotenv from "dotenv";
import { Codex } from "@openai/codex-sdk";

function loadEnv() {
  const explicit = process.env.DOTENV_CONFIG_PATH;
  const scriptPath = [...process.argv]
    .reverse()
    .find((arg) => typeof arg === "string" && (arg.endsWith(".ts") || arg.endsWith(".js")) && fs.existsSync(arg));
  const scriptDir = scriptPath ? path.dirname(path.resolve(scriptPath)) : process.cwd();

  const scriptEnv = path.join(scriptDir, ".env");
  const cwdEnv = path.join(process.cwd(), ".env");

  const envPath = explicit
    ? path.resolve(explicit)
    : fs.existsSync(scriptEnv)
      ? scriptEnv
      : fs.existsSync(cwdEnv)
        ? cwdEnv
        : null;

  if (!envPath) {
    console.warn("[warn] No .env found (set DOTENV_CONFIG_PATH or place a .env next to the script).");
    return;
  }

  const res = dotenv.config({ path: envPath });
  const count = res.parsed ? Object.keys(res.parsed).length : 0;
  if (res.error) {
    console.warn(`[warn] Failed to load env from ${envPath}:`, res.error);
  } else {
    console.log(`[info] Loaded ${count} env var(s) from ${envPath}`);
  }
}

loadEnv();

// =========================
// CONFIGURATION
// =========================

const REPO_PATH = path.resolve(process.env.REPO_PATH || ".");
const PROD_URL = process.env.PROD_URL || "";
const GIT_REMOTE = process.env.GIT_REMOTE || "origin";
const GIT_BRANCH = process.env.GIT_BRANCH || "";
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || "";
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID || "";
const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS || 10);
const SLEEP_AFTER_PUSH_SECONDS = Number(process.env.SLEEP_AFTER_PUSH_SECONDS || 90);
const CODEX_USE_EXEC = (process.env.CODEX_USE_EXEC || "1") !== "0";

// =========================
// HELPER FUNCTIONS
// =========================

type RunResult = { stdout: string; stderr: string; code: number };

function run(
  cmd: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; inputText?: string; streamOutput?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      stdio: "pipe",
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");

    child.stdout.on("data", (data) => {
      stdout += data;
      if (opts.streamOutput) process.stdout.write(data);
    });
    child.stderr.on("data", (data) => {
      stderr += data;
      if (opts.streamOutput) process.stderr.write(data);
    });

    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));

    if (opts.inputText) {
      child.stdin.write(opts.inputText);
      child.stdin.end();
    }
  });
}

async function gitWorkdirHasChanges(): Promise<boolean> {
  const { code } = await run(["git", "diff", "--quiet"], { cwd: REPO_PATH });
  if (code !== 0) return true;
  const staged = await run(["git", "diff", "--cached", "--quiet"], { cwd: REPO_PATH });
  return staged.code !== 0;
}

async function getCurrentCommitHash(short = true): Promise<string> {
  const args = short ? ["git", "rev-parse", "--short=7", "HEAD"] : ["git", "rev-parse", "HEAD"];
  const { stdout } = await run(args, { cwd: REPO_PATH });
  return stdout.trim();
}

async function resolveGitBranch(): Promise<string> {
  if (GIT_BRANCH) {
    const exists = await run(["git", "show-ref", "--verify", "--quiet", `refs/heads/${GIT_BRANCH}`], { cwd: REPO_PATH });
    if (exists.code === 0) return GIT_BRANCH;
    console.warn(`[warn] GIT_BRANCH=${GIT_BRANCH} is not a local branch. Falling back to current branch.`);
  }
  const { stdout, code } = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_PATH });
  if (code === 0 && stdout.trim()) return stdout.trim();
  return "main";
}

function extractDeploymentCandidates(text: string): string[] {
  const candidates = new Set<string>();
  {
    const urlRe = /https?:\/\/[A-Za-z0-9-]+\.vercel\.app\b/g;
    let match: RegExpExecArray | null;
    while ((match = urlRe.exec(text)) !== null) candidates.add(match[0]);
  }
  {
    const bareRe = /\b[A-Za-z0-9-]+\.vercel\.app\b/g;
    let match: RegExpExecArray | null;
    while ((match = bareRe.exec(text)) !== null) candidates.add(`https://${match[0]}`);
  }
  return Array.from(candidates);
}

function stripAnsi(text: string): string {
  // ECMA-48 / ANSI escape sequences.
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function normalizeVercelInspectLogs(raw: string): string {
  const withoutCliPreamble = raw
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.startsWith("Vercel CLI ")) return false;
      if (trimmed.startsWith("Fetching deployment ")) return false;
      if (trimmed.startsWith("> Fetched deployment ")) return false;
      if (trimmed.startsWith("status\t")) return false;
      if (trimmed.startsWith("status ")) return false;
      return true;
    })
    .join("\n");

  return stripAnsi(withoutCliPreamble).trim();
}

async function getDeploymentIdForCurrentCommit(): Promise<string | null> {
  const commitFull = await getCurrentCommitHash(false);
  const commitShort = commitFull.slice(0, 7);
  console.log(`[info] Looking for deployment of commit ${commitShort}...`);

  const env = { ...process.env };
  if (VERCEL_TOKEN) env.VERCEL_AUTH_TOKEN = VERCEL_TOKEN;
  if (VERCEL_TEAM_ID) env.VERCEL_TEAM_ID = VERCEL_TEAM_ID;

  // Prefer Vercel metadata filtering to avoid false positives when scanning logs for a short SHA.
  const listByMeta = await run(["vercel", "list", "--no-color", "--yes", "-m", `githubCommitSha=${commitFull}`], {
    cwd: REPO_PATH,
    env,
  });
  const metaCombined = `${listByMeta.stdout}\n${listByMeta.stderr}`;
  if (listByMeta.code === 0) {
    const metaCandidates = extractDeploymentCandidates(metaCombined);
    if (metaCandidates.length > 0) {
      console.log(`[info] Found ${metaCandidates.length} deployment(s) via metadata filter.`);
      return metaCandidates[0];
    }
  }

  const list = await run(["vercel", "list", "--no-color", "--yes"], { cwd: REPO_PATH, env });
  const combinedList = `${list.stdout}\n${list.stderr}`;
  if (list.code !== 0 || !combinedList.trim()) {
    console.warn("[warn] `vercel list` failed or returned no data.");
    if (combinedList.trim()) console.warn(combinedList);
    return null;
  }

  const candidates = extractDeploymentCandidates(combinedList);
  console.log(`[info] Parsed ${candidates.length} deployment candidates from \`vercel list\`.`);

  // Fallback: inspect build logs and parse the explicit "Commit: <sha>" line from Vercel's cloning step.
  const cloningCommitRe = /\bCommit:\s*([0-9a-f]{7,40})\b/i;
  for (const dep of candidates) {
    console.log(`[debug] Inspecting deployment ${dep} for commit ${commitShort}...`);
    const inspect = await run(["vercel", "inspect", dep, "--logs", "--no-color"], { cwd: REPO_PATH, env });
    const inspectCombined = `${inspect.stdout}\n${inspect.stderr}`;
    const match = inspectCombined.match(cloningCommitRe);
    const inspectedCommit = match?.[1]?.toLowerCase();
    if (!inspectedCommit) continue;
    if (commitFull.toLowerCase().startsWith(inspectedCommit) || inspectedCommit.startsWith(commitShort.toLowerCase())) {
      console.log(`[info] Matched commit ${commitShort} to deployment ${dep}`);
      return dep;
    }
  }

  console.warn(`[warn] No deployment found for commit ${commitShort} in ${candidates.length} candidates.`);
  return null;
}

async function fetchLatestBuildLogs(): Promise<string> {
  console.log("\n[step] Fetching Vercel build logs for current commit...");
  const env = { ...process.env };
  if (VERCEL_TOKEN) env.VERCEL_AUTH_TOKEN = VERCEL_TOKEN;
  if (VERCEL_TEAM_ID) env.VERCEL_TEAM_ID = VERCEL_TEAM_ID;

  const dep = await getDeploymentIdForCurrentCommit();
  if (!dep) {
    console.warn("[warn] Could not find a deployment for the current commit.");
    return "";
  }

  console.log(`[info] Inspecting deployment ${dep} ...`);
  const timeout = process.env.VERCEL_INSPECT_TIMEOUT || "10m";
  const res = await run(["vercel", "inspect", dep, "--logs", "--wait", "--timeout", timeout, "--no-color"], { cwd: REPO_PATH, env });
  const rawLogs = `${res.stdout}\n${res.stderr}`.trim();
  const logs = normalizeVercelInspectLogs(rawLogs) || rawLogs;
  if (!logs.trim()) {
    console.warn("[warn] No logs returned from Vercel for this deployment.");
    return "";
  }

  const lines = logs.split(/\r?\n/);
  console.log("[info] Log snippet:");
  console.log(lines.slice(-25).join("\n"));
  return logs;
}

function buildLooksSuccessful(logs: string): boolean {
  const text = logs.toLowerCase();
  const failures = ["error ", "failed", "build failed", "exit code 1", "exited with 1"];
  if (failures.some((f) => text.includes(f))) return false;
  const success = ["deployment completed", "build completed", "ready! deployed to"];
  return success.some((s) => text.includes(s));
}

async function runCodexOnLogs(logs: string): Promise<boolean> {
  console.log("\n[step] Running Codex with latest build logs...");
  if (!logs.trim()) {
    console.log("[info] No logs provided to Codex. Skipping.");
    return false;
  }

  // Make logs available for the agent.
  const logsPath = path.join(REPO_PATH, "dev_debug_logs.md");
  fs.writeFileSync(
    logsPath,
    `# Vercel build logs\n\nFetched: ${new Date().toISOString()}\n\n\`\`\`\n${logs}\n\`\`\`\n`,
    "utf-8",
  );
  console.log(`[info] Wrote logs to ${logsPath} for Codex context.`);

  const hadChangesBefore = await gitWorkdirHasChanges();

  const task =
    "You are Codex running in an autofix loop for a Vercel deployment.\n" +
    "Goal: diagnose the build failure from the Vercel logs and modify the repo to fix it.\n" +
    "Rules:\n" +
    "- Edit files as needed, but do NOT commit.\n" +
    "- Prefer minimal, targeted changes.\n" +
    "- Do NOT rely on local node_modules or locally built artifacts; reason from the Vercel build logs and repo source.\n" +
    "- If lockfile mismatches are indicated, refresh the lockfile accordingly.\n\n" +
    `The logs are in ${logsPath}.\n` +
    "Start by reading that file.";

  if (CODEX_USE_EXEC) {
    const execEnv = { ...process.env };
    delete execEnv.OPENAI_API_KEY; // avoid forcing API-billed mode when CLI auth is available
    delete execEnv.CODEX_API_KEY; // same: prefer the logged-in Codex CLI auth

    const args = ["codex", "exec", "--full-auto", task];
    const res = await run(args, { cwd: REPO_PATH, env: execEnv, streamOutput: true });

    if (res.code !== 0) {
      console.warn("[warn] codex exec failed:", res.stderr || res.stdout);
      return false;
    }

    console.log("[codex final response]");
    console.log((res.stdout || res.stderr).trim());
  } else {
    const codexEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) codexEnv[k] = v;
    }

    const codex = new Codex({
      env: codexEnv,
    });

    try {
      const thread = codex.startThread({
        workingDirectory: REPO_PATH,
        skipGitRepoCheck: false,
      });

      const turn = await thread.run(task);

      console.log("[codex final response]");
      console.log(turn.finalResponse);
    } catch (err) {
      console.warn("[warn] Codex run failed:", err);
      return false;
    }
  }

  const hasChangesAfter = await gitWorkdirHasChanges();
  if (!hasChangesAfter && !hadChangesBefore) {
    console.log("[info] Codex made no file changes.");
    return false;
  }

  console.log("[info] Codex appears to have modified the repo.");
  return true;
}

async function gitCommitAndPush(branch: string): Promise<boolean> {
  console.log("\n[step] Git add/commit/push...");

  await run(["git", "add", "-A"], { cwd: REPO_PATH });

  const commitMsg = "chore: auto-fix by codex based on Vercel build logs";
  const commit = await run(["git", "commit", "-m", commitMsg], { cwd: REPO_PATH });
  if (commit.code !== 0) {
    if (commit.stdout.toLowerCase().includes("nothing to commit") || commit.stderr.toLowerCase().includes("nothing to commit")) {
      console.log("[info] Nothing to commit. Skipping push.");
      return false;
    }
    throw new Error(`git commit failed:\n${commit.stdout}\n${commit.stderr}`);
  }

  console.log("[info] Commit created:");
  console.log(commit.stdout);

  const push = await run(["git", "push", GIT_REMOTE, branch], { cwd: REPO_PATH });
  if (push.code !== 0) {
    throw new Error(`git push failed:\n${push.stdout}\n${push.stderr}`);
  }
  console.log("[info] git push completed.");
  return true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =========================
// MAIN LOOP
// =========================

async function main() {
  console.log("[start] Vercel ↔ Codex auto-fix loop (TypeScript)");
  console.log(`Repo:   ${REPO_PATH}`);
  const branch = await resolveGitBranch();
  console.log(`Branch: ${branch}`);
  console.log(`URL:    ${PROD_URL}`);
  console.log(`MAX_ITERATIONS:    ${MAX_ITERATIONS}`);

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    console.log("\n==============================");
    console.log(`Iteration ${i}/${MAX_ITERATIONS}`);
    console.log("==============================");

    const logs = await fetchLatestBuildLogs();
    if (!logs.trim()) {
      console.log("[warn] No logs found. Sleeping and retrying...");
      await sleep(SLEEP_AFTER_PUSH_SECONDS * 1000);
      continue;
    }

    if (buildLooksSuccessful(logs)) {
      console.log("[info] Build looks successful 🎉");
      console.log("[done] Stopping loop.");
      return;
    }

    const changed = await runCodexOnLogs(logs);
    if (!changed) {
      console.log("[info] Codex has no further changes. Stopping loop.");
      return;
    }

    const pushed = await gitCommitAndPush(branch);
    if (!pushed) {
      console.log("[info] No code changes actually pushed. Stopping loop.");
      return;
    }

    console.log(`[info] Sleeping ${SLEEP_AFTER_PUSH_SECONDS}s while Vercel builds...`);
    await sleep(SLEEP_AFTER_PUSH_SECONDS * 1000);
  }

  console.log(`[stop] Reached MAX_ITERATIONS=${MAX_ITERATIONS}. Exiting.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
