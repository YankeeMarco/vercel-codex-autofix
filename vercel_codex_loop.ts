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
const RUN_PREFLIGHT = process.env.RUN_PREFLIGHT === "1"; // opt-in local checks
const PREFLIGHT_COMMANDS: string[][] = [
  ["pnpm", "-C", "apps/web", "exec", "tsc", "--noEmit", "--pretty", "false"],
  // Add lint/test commands if desired:
  // ["pnpm", "-C", "apps/web", "lint"],
  // ["pnpm", "-C", "apps/web", "test"],
];
const AUTOFIX_DIR = path.join(REPO_PATH, ".autofix");
const STATE_PATH = path.join(AUTOFIX_DIR, "state.json");
const RUN_MCP_GUI = (process.env.RUN_MCP_GUI || process.env.RUN_MCP_PLAYWRIGHT || "1") !== "0";
const MCP_GUI_SCRIPT_PATH = path.resolve(process.env.MCP_GUI_SCRIPT || path.join(REPO_PATH, "mcp", "run-gui-check.sh"));
const MCP_GUI_OUTPUT_DIR = path.resolve(process.env.MCP_GUI_LOG_DIR || path.join(REPO_PATH, "logs", "gui"));
const MCP_GUI_REPORT_PATH = path.join(AUTOFIX_DIR, "gui_report.md");
const CODEX_RULES =
  "- Edit files as needed, but do NOT commit.\n" +
  "- Prefer minimal, targeted changes that address the specific issue.\n" +
  "- Do not change dependency versions or lockfiles unless clearly required.\n" +
  "- Prefer editing application code over root configs unless necessary.\n" +
  "- Avoid broad refactors and keep diffs as small as possible.\n" +
  "- Do NOT rely on local node_modules or locally built artifacts.\n" +
  "- Refresh the lockfile only if there is clear evidence of a mismatch.";

function extractInitialTaskFromArgv(): string {
  const argv = process.argv || [];
  let scriptIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== "string") continue;
    if (!arg.endsWith(".ts") && !arg.endsWith(".js")) continue;
    const candidate = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
    if (fs.existsSync(candidate)) scriptIndex = i;
  }
  const start = scriptIndex >= 0 ? scriptIndex + 1 : 2;
  const fragments = argv.slice(start).filter((arg): arg is string => typeof arg === "string");
  if (fragments.length === 0) return "";
  const hasMeaningful = fragments.some((frag) => frag.trim().length > 0);
  if (!hasMeaningful) return "";
  const joined = fragments.join(" ").trim();
  if (!joined) return "";
  if (joined === '""' || joined === "''") return "";
  return joined;
}

const INITIAL_TASK = extractInitialTaskFromArgv();

function buildInitialCommitMessage(task: string): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  if (!normalized) return "chore: codex initial task";
  const prefix = "chore: codex initial task - ";
  const maxLength = 72;
  const available = Math.max(8, maxLength - prefix.length);
  const snippet = normalized.length > available ? `${normalized.slice(0, available - 3)}...` : normalized;
  return `${prefix}${snippet}`;
}

// =========================
// HELPER FUNCTIONS
// =========================

type RunResult = { stdout: string; stderr: string; code: number };
type AutoFixState = {
  iteration: number;
  lastPushedCommit?: string;
  seenSignatures: string[];
  resolvedSignatures: string[];
  lastScore?: number;
};
type GuiCheckOutcome = {
  ok: boolean;
  report: string;
  logPath: string;
  targetUrl: string;
};

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

function ensureAutofixDir() {
  if (!fs.existsSync(AUTOFIX_DIR)) fs.mkdirSync(AUTOFIX_DIR, { recursive: true });
}

function loadState(): AutoFixState {
  ensureAutofixDir();
  if (!fs.existsSync(STATE_PATH)) {
    return { iteration: 0, seenSignatures: [], resolvedSignatures: [] };
  }
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as AutoFixState;
    return {
      iteration: parsed.iteration || 0,
      lastPushedCommit: parsed.lastPushedCommit,
      seenSignatures: parsed.seenSignatures || [],
      resolvedSignatures: parsed.resolvedSignatures || [],
      lastScore: parsed.lastScore,
    };
  } catch {
    return { iteration: 0, seenSignatures: [], resolvedSignatures: [] };
  }
}

function saveState(state: AutoFixState) {
  ensureAutofixDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

async function gitWorkdirHasChanges(): Promise<boolean> {
  const { code } = await run(["git", "diff", "--quiet"], { cwd: REPO_PATH });
  if (code !== 0) return true;
  const staged = await run(["git", "diff", "--cached", "--quiet"], { cwd: REPO_PATH });
  return staged.code !== 0;
}

async function getBranchAheadBehind(branch: string): Promise<{ ahead: number; behind: number } | null> {
  const upstreamRef = `${branch}@{upstream}`;
  const res = await run(["git", "rev-list", "--left-right", "--count", upstreamRef, branch], { cwd: REPO_PATH });
  if (res.code !== 0) {
    if (/no upstream configured/i.test(res.stderr)) {
      console.warn(`[warn] Branch ${branch} has no upstream configured; skipping upstream push check.`);
      return null;
    }
    console.warn(`[warn] Could not determine upstream status for branch ${branch}:\n${res.stderr || res.stdout}`);
    return null;
  }
  const parts = res.stdout.trim().split(/\s+/);
  if (parts.length < 2) return { ahead: 0, behind: 0 };
  const behind = Number(parts[0] || 0) || 0;
  const ahead = Number(parts[1] || 0) || 0;
  return { ahead, behind };
}

function promptYesNo(question: string, defaultValue = false): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.warn("[warn] No interactive terminal detected; defaulting to 'no'.");
    return Promise.resolve(defaultValue);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf-8");
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      const answer = data.toString().trim().toLowerCase();
      if (!answer) {
        resolve(defaultValue);
        return;
      }
      resolve(answer === "y" || answer === "yes");
    });
  });
}

async function maybePushAheadCommits(branch: string): Promise<boolean> {
  const aheadBehind = await getBranchAheadBehind(branch);
  if (!aheadBehind || aheadBehind.ahead <= 0) {
    return true;
  }

  console.warn(`[warn] Local branch ${branch} is ahead of its upstream by ${aheadBehind.ahead} commit(s).`);
  const confirm = await promptYesNo("Push these commits before starting the loop? [y/N] ");
  if (!confirm) {
    console.log("[info] Aborting to allow manual git push.");
    return false;
  }

  const push = await run(["git", "push", GIT_REMOTE, branch], { cwd: REPO_PATH, streamOutput: true });
  if (push.code !== 0) {
    throw new Error(`git push failed:\n${push.stdout}\n${push.stderr}`);
  }
  console.log("[info] git push completed (pre-loop sync).");
  console.log(`[info] Sleeping ${SLEEP_AFTER_PUSH_SECONDS}s while Vercel builds...`);
  await sleep(SLEEP_AFTER_PUSH_SECONDS * 1000);
  return true;
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

function extractErrorSignatures(logs: string): string[] {
  const s = new Set<string>();
  const lines = logs.split(/\r?\n/);

  for (const line of lines) {
    const m1 = line.match(/(?:^|\s)(\.\/[^\s]+?\.(?:ts|tsx|js|jsx)):(\d+):(\d+)/);
    if (m1) s.add(`LOC|${m1[1]}:${m1[2]}:${m1[3]}`);
    const m2 = line.match(/\bTS(\d{3,5})\b/);
    if (m2) s.add(`TS${m2[1]}`);
    if (/failed to compile/i.test(line)) s.add("NEXT_FAILED_TO_COMPILE");
    if (/type error:/i.test(line)) s.add("TS_TYPE_ERROR");
    if (/elifecycle/i.test(line)) s.add("PNPM_ELIFECYCLE");
  }

  return Array.from(s).slice(0, 30);
}

function scoreFromLogs(logs: string): number {
  const lines = logs.split(/\r?\n/);
  const tsErrCount = lines.filter((l) => /\bTS\d{3,5}\b/.test(l) || /type error:/i.test(l)).length;
  const buildFail = /failed to compile|build failed|elifecycle|command failed with exit code|next\.js build worker exited/i.test(logs) ? 1 : 0;
  return buildFail * 1000 + tsErrCount * 10;
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

async function fetchLatestBuildLogs(): Promise<{ logs: string; deploymentUrl?: string }> {
  console.log("\n[step] Fetching Vercel build logs for current commit...");
  const env = { ...process.env };
  if (VERCEL_TOKEN) env.VERCEL_AUTH_TOKEN = VERCEL_TOKEN;
  if (VERCEL_TEAM_ID) env.VERCEL_TEAM_ID = VERCEL_TEAM_ID;

  const dep = await getDeploymentIdForCurrentCommit();
  if (!dep) {
    console.warn("[warn] Could not find a deployment for the current commit.");
    return { logs: "", deploymentUrl: undefined };
  }
  console.log(`[info] Inspecting deployment ${dep} ...`);
  const timeout = process.env.VERCEL_INSPECT_TIMEOUT || "10m";
  const res = await run(["vercel", "inspect", dep, "--logs", "--wait", "--timeout", timeout, "--no-color"], { cwd: REPO_PATH, env });
  const rawLogs = `${res.stdout}\n${res.stderr}`.trim();
  const logs = normalizeVercelInspectLogs(rawLogs) || rawLogs;
  if (!logs.trim()) {
    console.warn("[warn] No logs returned from Vercel for this deployment.");
    return { logs: "", deploymentUrl: dep || undefined };
  }

  const lines = logs.split(/\r?\n/);
  console.log("[info] Log snippet:");
  console.log(lines.slice(-25).join("\n"));
  return { logs, deploymentUrl: dep || undefined };
}

function buildLooksSuccessful(logs: string): boolean {
  const text = logs.toLowerCase();
  const failMarkers = [
    "failed to compile",
    "type error:",
    "build failed",
    "elifecycle",
    "command failed with exit code",
    "next.js build worker exited with code",
  ];
  if (failMarkers.some((f) => text.includes(f))) return false;
  const success = ["deployment completed", "ready! deployed to", "successfully deployed"];
  if (success.some((s) => text.includes(s))) return true;
  return false;
}

async function runCodexPrompt(task: string): Promise<boolean> {
  const hadChangesBefore = await gitWorkdirHasChanges();

  if (CODEX_USE_EXEC) {
    const execEnv = { ...process.env };
    delete execEnv.OPENAI_API_KEY;
    delete execEnv.CODEX_API_KEY;

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

async function runCodexOnLogs(logs: string, extraContext = ""): Promise<boolean> {
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

  const task =
    "You are Codex running in an autofix loop for a Vercel deployment.\n" +
    "Goal: diagnose the build failure from the Vercel logs and modify the repo to fix it.\n" +
    "Rules:\n" +
    `${CODEX_RULES}\n` +
    "- Reason strictly from dev_debug_logs.md and the repo; do not assume hidden state.\n\n" +
    `The logs are in ${logsPath}.\n` +
    "Start by reading that file." +
    (extraContext ? `\n\nAdditional context:\n${extraContext}` : "");

  return runCodexPrompt(task);
}

async function runInitialCodexTask(initialTask: string, extraContext = ""): Promise<boolean> {
  const trimmed = initialTask.trim();
  if (!trimmed) {
    console.log("[info] No initial task provided.");
    return false;
  }

  console.log("\n[step] Running Codex for initial CLI task...");
  const task =
    "You are Codex running in an autofix loop for a Vercel deployment.\n" +
    "Goal: implement the initial user request described below and ensure the code remains production-ready.\n" +
    "Rules:\n" +
    `${CODEX_RULES}\n` +
    "- Avoid regressing existing functionality and prefer incremental changes.\n\n" +
    `Initial task:\n${trimmed}\n` +
    (extraContext ? `\nAdditional context:\n${extraContext}` : "");

  return runCodexPrompt(task);
}

async function gitCommitAndPush(branch: string, customMessage?: string): Promise<boolean> {
  console.log("\n[step] Git add/commit/push...");

  await run(["git", "add", "-A"], { cwd: REPO_PATH });

  const commitMsg = customMessage || "chore: auto-fix by codex based on Vercel build logs";
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

async function runPreflight(): Promise<{ ok: boolean; output: string }> {
  if (!RUN_PREFLIGHT || PREFLIGHT_COMMANDS.length === 0) {
    return { ok: true, output: "[info] Preflight disabled (RUN_PREFLIGHT!=1 or no commands)." };
  }
  console.log("\n[step] Running local preflight checks...");
  let output = "";
  for (const cmd of PREFLIGHT_COMMANDS) {
    console.log(`[preflight] ${cmd.join(" ")}`);
    const res = await run(cmd, { cwd: REPO_PATH, streamOutput: true });
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    output += `\n\n## ${cmd.join(" ")}\n\n${combined}\n`;
    if (res.code !== 0) {
      return { ok: false, output };
    }
  }
  return { ok: true, output };
}

async function runMcpPlaywrightTests(): Promise<PlaywrightTestOutcome | null> {
async function runGuiCheck(targetUrl?: string): Promise<GuiCheckOutcome | null> {
  if (!RUN_MCP_GUI) {
    console.log("[info] RUN_MCP_GUI=0 — skipping GUI checks.");
    return null;
  }

  const resolvedTarget = targetUrl || PROD_URL;
  if (!resolvedTarget) {
    console.log("[info] No target URL available for GUI checks. Set PROD_URL or pass MCP_GUI_TARGET_URL.");
    return null;
  }

  if (!fs.existsSync(MCP_GUI_SCRIPT_PATH)) {
    console.log(`[info] GUI runner script not found at ${MCP_GUI_SCRIPT_PATH}. Skipping GUI checks.`);
    return null;
  }

  console.log("\n[step] Running MCP Playwright GUI checks...");
  const env = { ...process.env };
  env.MCP_GUI_TARGET_URL = resolvedTarget;
  env.MCP_GUI_LOG_DIR = MCP_GUI_OUTPUT_DIR;

  const res = await run(["bash", MCP_GUI_SCRIPT_PATH, resolvedTarget], {
    cwd: REPO_PATH,
    env,
    streamOutput: true,
  });
  const combined = `${res.stdout}\n${res.stderr}`.trim();

  ensureAutofixDir();
  fs.writeFileSync(
    MCP_GUI_REPORT_PATH,
    `# MCP Playwright GUI report\n\nRun: ${new Date().toISOString()}\nTarget: ${resolvedTarget}\nLogs directory: ${MCP_GUI_OUTPUT_DIR}\n\n\`\`\`\n${combined}\n\`\`\`\n`,
    "utf-8",
  );

  const ok = res.code === 0 && !/FAIL/i.test(combined);
  return {
    ok,
    report: combined || "[no report produced]",
    logPath: MCP_GUI_REPORT_PATH,
    targetUrl: resolvedTarget,
  };
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

  const synced = await maybePushAheadCommits(branch);
  if (!synced) {
    console.log("[stop] Exiting before Codex loop because local commits were not pushed.");
    return;
  }

  let state = loadState();

  if (INITIAL_TASK) {
    console.log("\n[init] Initial CLI task detected:");
    console.log(`       ${INITIAL_TASK}`);
    const initialChanged = await runInitialCodexTask(INITIAL_TASK);
    if (!initialChanged) {
      console.log("[info] Initial task produced no repo changes. Continuing to build-log loop.");
    } else {
      const preflight = await runPreflight();
      if (RUN_PREFLIGHT && !preflight.ok) {
        console.log("[warn] Preflight failed after initial task; asking Codex to revise the patch.");
        const constraints =
          "\nAdditional constraints:\n" +
          "- Complete the initial CLI request without breaking preflight commands.\n" +
          "- Keep prior fixes intact unless absolutely necessary.\n" +
          "\nPreflight output:\n```text\n" +
          preflight.output.slice(-12000) +
          "\n```\n";

        const retryChanged = await runInitialCodexTask(INITIAL_TASK, constraints);
        if (!retryChanged) {
          console.log("[info] Codex could not resolve the initial task preflight issues. Stopping.");
          return;
        }

        const preflightRetry = await runPreflight();
        if (!preflightRetry.ok) {
          console.log("[warn] Preflight still failing after retry. Stopping to avoid regressions.");
          return;
        }
      }

      const commitMsg = buildInitialCommitMessage(INITIAL_TASK);
      const pushed = await gitCommitAndPush(branch, commitMsg);
      if (!pushed) {
        console.log("[info] Initial task yielded nothing to push. Continuing to build-log loop.");
      } else {
        console.log(`[info] Sleeping ${SLEEP_AFTER_PUSH_SECONDS}s while Vercel builds...`);
        await sleep(SLEEP_AFTER_PUSH_SECONDS * 1000);
      }
    }
  }

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    console.log("\n==============================");
    console.log(`Iteration ${i}/${MAX_ITERATIONS}`);
    console.log("==============================");

    const { logs, deploymentUrl } = await fetchLatestBuildLogs();
    if (!logs.trim()) {
      console.log("[warn] No logs found. Sleeping and retrying...");
      await sleep(SLEEP_AFTER_PUSH_SECONDS * 1000);
      continue;
    }

    let effectiveLogs = logs;
    let extraCodexContext = "";
    let logSource: "vercel" | "gui" = "vercel";
    let finalSuccess = false;
    let guiOutcome: GuiCheckOutcome | null = null;
    const deployLooksSuccessful = buildLooksSuccessful(logs);

    if (deployLooksSuccessful) {
      guiOutcome = await runGuiCheck(deploymentUrl || PROD_URL);
      if (!guiOutcome || guiOutcome.ok) {
        finalSuccess = true;
      } else {
        console.warn("[warn] GUI checks failed after a successful deployment.");
        effectiveLogs = guiOutcome.report;
        logSource = "gui";
        extraCodexContext =
          "GUI regression detected by MCP Playwright after deployment.\n" +
          `Target URL: ${guiOutcome.targetUrl}\n` +
          `GUI report saved to ${guiOutcome.logPath}\n` +
          `Artifacts directory: ${MCP_GUI_OUTPUT_DIR}\n` +
          "Analyze the report, inspect the trace/video in the logs directory, and patch the application so the scenario passes.";
      }
    }

    const rawSigs = extractErrorSignatures(effectiveLogs);
    const sigSet = new Set(rawSigs);
    if (logSource === "gui") {
      sigSet.add("GUI_REGRESSION");
    }
    const sigs = Array.from(sigSet);
    let score = scoreFromLogs(effectiveLogs);
    if (logSource === "gui") {
      score += 5000;
    }
    console.log(`[info] Score=${score}, signatures=${sigs.join(", ")}`);
    const regression = sigs.some((x) => state.resolvedSignatures.includes(x));
    if (regression) {
      console.warn("[warn] Regression detected: previously resolved signature reappeared.");
    }

    state.iteration = state.iteration + 1;
    state.seenSignatures = Array.from(new Set([...state.seenSignatures, ...sigs])).slice(-200);
    state.lastScore = score;
    saveState(state);

    if (finalSuccess) {
      console.log("[info] Build looks successful 🎉");
      if (guiOutcome) {
        console.log("[info] MCP Playwright GUI checks also passed ✅");
      } else if (RUN_MCP_GUI) {
        console.log("[info] GUI checks skipped (script missing or target URL unavailable).");
      } else {
        console.log("[info] GUI checks disabled (RUN_MCP_GUI=0).");
      }
      state = loadState();
      state.resolvedSignatures = Array.from(new Set([...state.resolvedSignatures, ...state.seenSignatures])).slice(-200);
      saveState(state);
      console.log("[done] Stopping loop.");
      return;
    }

    const changed = await runCodexOnLogs(effectiveLogs, extraCodexContext);
    if (!changed) {
      console.log("[info] Codex has no further changes. Stopping loop.");
      return;
    }

    const preflight = await runPreflight();
    if (RUN_PREFLIGHT && !preflight.ok) {
      console.log("[warn] Preflight failed; asking Codex to fix without regressions.");
      const constraints =
        "\nAdditional constraints:\n" +
        `- Do NOT reintroduce previously seen error signatures: ${state.resolvedSignatures.join(", ") || "none"}\n` +
        "- Do NOT revert previous fixes unless absolutely necessary.\n" +
        "- After changes, ensure `pnpm -C apps/web exec tsc --noEmit --pretty false` passes.\n" +
        "\nPreflight output:\n```text\n" +
        preflight.output.slice(-12000) +
        "\n```\n";

      const retryChanged = await runCodexOnLogs(effectiveLogs, constraints);
      if (!retryChanged) {
        console.log("[info] Codex could not fix preflight. Stopping.");
        return;
      }

      const preflightRetry = await runPreflight();
      if (!preflightRetry.ok) {
        console.log("[warn] Preflight still failing after retry. Stopping to avoid regressions.");
        return;
      }
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
