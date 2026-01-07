import fs from "fs";
import path from "path";
import process from "process";
import { chromium, Browser, Page } from "playwright";

type Plan = {
  defaultBaseUrl?: string;
  notes?: string;
  scenarios: Scenario[];
};

type Scenario = {
  name: string;
  goal?: string;
  path?: string;
  actions: Action[];
};

type SelectorAction =
  | { type: "waitForSelector"; selector: string; state?: "attached" | "detached" | "visible" | "hidden"; timeoutMs?: number }
  | { type: "fill"; selector: string; value: string }
  | { type: "click"; selector: string }
  | { type: "press"; selector: string; key: string }
  | { type: "upload"; selector: string; file: string }
  | { type: "expectText"; selector: string; text: string; match?: "equals" | "includes" }
  | { type: "expectVisible"; selector: string; visible?: boolean }
  | { type: "expectHidden"; selector: string };

type Action =
  | { type: "goto"; path?: string; url?: string }
  | SelectorAction
  | { type: "expectUrlContains"; value: string }
  | { type: "pause"; ms?: number };

type ScenarioResult = {
  scenario: Scenario;
  success: boolean;
  error?: string;
};

function parseArgs(): { planPath: string } {
  const argv = process.argv.slice(2);
  let planPath = process.env.MCP_PLAYWRIGHT_PLAN || path.join(process.cwd(), "playwright", "mcp-playwright-plan.json");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--plan" && argv[i + 1]) {
      planPath = path.resolve(argv[i + 1]);
      i++;
    }
  }
  return { planPath };
}

function loadPlan(planPath: string): Plan {
  if (!fs.existsSync(planPath)) {
    throw new Error(`Plan file not found at ${planPath}`);
  }
  const raw = fs.readFileSync(planPath, "utf-8");
  const parsed = JSON.parse(raw) as Plan;
  if (!parsed.scenarios || parsed.scenarios.length === 0) {
    throw new Error(`Plan ${planPath} does not contain any scenarios.`);
  }
  return parsed;
}

function resolveBaseUrl(plan: Plan): string {
  const fromEnv = process.env.MCP_PLAYWRIGHT_BASE_URL || process.env.PROD_URL;
  const base = fromEnv || plan.defaultBaseUrl || "http://localhost:3000";
  if (base.endsWith("/")) return base.slice(0, -1);
  return base;
}

function resolveValue(value: string, randomSeed: string): string {
  return value.replace(/{{RANDOM}}/gi, randomSeed);
}

async function ensureScreenshotDir(root: string): Promise<string> {
  const dir = path.join(root, ".autofix");
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

async function runScenario(browser: Browser, baseUrl: string, scenario: Scenario, repoRoot: string): Promise<ScenarioResult> {
  const page = await browser.newPage();
  const scenarioLabel = `[scenario:${scenario.name}]`;
  const randomSeed = Math.random().toString(36).slice(2, 10);
  const screenshotDir = await ensureScreenshotDir(repoRoot);

  const log = (message: string) => {
    console.log(`${scenarioLabel} ${message}`);
  };

  try {
    for (const action of scenario.actions) {
      switch (action.type) {
        case "goto": {
          const target = action.url || `${baseUrl}${action.path || scenario.path || "/"}`;
          log(`goto ${target}`);
          await page.goto(target, { waitUntil: "domcontentloaded" });
          break;
        }
        case "waitForSelector": {
          log(`waitForSelector ${action.selector} state=${action.state || "visible"}`);
          await page.waitForSelector(action.selector, { state: action.state || "visible", timeout: action.timeoutMs || 15000 });
          break;
        }
        case "fill": {
          const value = resolveValue(action.value, randomSeed);
          log(`fill ${action.selector} value=${value}`);
          await page.fill(action.selector, value);
          break;
        }
        case "click": {
          log(`click ${action.selector}`);
          await page.click(action.selector);
          break;
        }
        case "press": {
          log(`press ${action.selector} key=${action.key}`);
          await page.press(action.selector, action.key);
          break;
        }
        case "upload": {
          const filePath = path.isAbsolute(action.file) ? action.file : path.join(repoRoot, action.file);
          if (!fs.existsSync(filePath)) {
            throw new Error(`Upload file not found: ${filePath}`);
          }
          log(`upload ${action.selector} <- ${filePath}`);
          await page.setInputFiles(action.selector, filePath);
          break;
        }
        case "expectText": {
          const expected = resolveValue(action.text, randomSeed);
          log(`expectText ${action.selector} match=${action.match || "equals"} target=${expected}`);
          const locator = page.locator(action.selector);
          await locator.waitFor({ state: "visible" });
          const text = ((await locator.innerText()) || "").trim();
          if (action.match === "includes" || !action.match) {
            if (!text.includes(expected)) {
              throw new Error(`Expected text to include "${expected}", but got "${text}"`);
            }
          } else if (action.match === "equals" && text !== expected) {
            throw new Error(`Expected text to equal "${expected}", but got "${text}"`);
          }
          break;
        }
        case "expectUrlContains": {
          log(`expectUrlContains ${action.value}`);
          const url = page.url();
          if (!url.includes(action.value)) {
            throw new Error(`Expected url to contain "${action.value}", got "${url}"`);
          }
          break;
        }
        case "expectVisible": {
          log(`expectVisible ${action.selector} -> ${action.visible !== false}`);
          await page.waitForSelector(action.selector, { state: action.visible === false ? "hidden" : "visible" });
          break;
        }
        case "expectHidden": {
          log(`expectHidden ${action.selector}`);
          await page.waitForSelector(action.selector, { state: "hidden" });
          break;
        }
        case "pause": {
          const ms = action.ms ?? 1000;
          log(`pause ${ms}ms`);
          await page.waitForTimeout(ms);
          break;
        }
        default:
          throw new Error(`Unsupported action type ${(action as Action).type}`);
      }
    }
    log("✅ scenario passed");
    await page.close();
    return { scenario, success: true };
  } catch (err) {
    const failure = err instanceof Error ? err.message : String(err);
    log(`❌ scenario failed: ${failure}`);
    try {
      const screenshotPath = path.join(screenshotDir, `playwright_failure_${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      log(`Saved failure screenshot to ${screenshotPath}`);
    } catch (screenshotErr) {
      log(`Could not capture screenshot: ${screenshotErr}`);
    }
    await page.close();
    return { scenario, success: false, error: failure };
  }
}

async function main() {
  const repoRoot = process.env.REPO_PATH ? path.resolve(process.env.REPO_PATH) : process.cwd();
  const { planPath } = parseArgs();
  const plan = loadPlan(planPath);
  const baseUrl = resolveBaseUrl(plan);
  console.log(`[mcp-playwright] Loaded ${plan.scenarios.length} scenario(s) from ${planPath}`);
  console.log(`[mcp-playwright] Base URL: ${baseUrl}`);

  const browser = await chromium.launch({ headless: process.env.MCP_PLAYWRIGHT_HEADLESS !== "0" });
  const results: ScenarioResult[] = [];
  try {
    for (const scenario of plan.scenarios) {
      console.log(`[mcp-playwright] Starting scenario: ${scenario.name}`);
      const result = await runScenario(browser, baseUrl, scenario, repoRoot);
      results.push(result);
      if (!result.success) {
        break;
      }
    }
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.success).length;
  const failed = results.length - passed;
  console.log(`[mcp-playwright] Summary: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    const firstFailure = results.find((r) => !r.success);
    console.error(`[mcp-playwright] First failure: ${firstFailure?.scenario.name} -> ${firstFailure?.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[mcp-playwright] Fatal error:", err);
  process.exit(1);
});
