import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, "..");

export const config = {
  root: ROOT,
  workflowsDir: path.join(ROOT, "workflows"),
  dataDir: path.join(ROOT, "data"),
  logsDir: path.join(ROOT, "logs"),
  artifactsDir: path.join(ROOT, "artifacts"),
  screenshotsDir: path.join(ROOT, "artifacts", "screenshots"),
  submissionsFile: path.join(ROOT, "data", "submissions.json"),
  envFile: path.join(ROOT, ".env"),

  browser: {
    // ALWAYS visible: headless is hard-coded to 0 (false) so the browser
    // window always opens regardless of any AUTOMATOR_HEADLESS value.
    headless: false,
    slowMo: process.env.AUTOMATOR_SLOWMO ? Number(process.env.AUTOMATOR_SLOWMO) : 80,
    timeout: process.env.AUTOMATOR_TIMEOUT ? Number(process.env.AUTOMATOR_TIMEOUT) : 45000,
    storageState: path.join(ROOT, "data", "session.json"),
    // Persistent Chrome PROFILE directory (not just cookies). Google treats a
    // browser with the same profile+device as TRUSTED, so the one-time "email
    // me a confirmation code" 2FA is asked ONLY on the first login and never
    // again — a fresh temp profile each run is what re-triggers it every time.
    profileDir: process.env.AUTOMATOR_PROFILE_DIR || path.join(ROOT, "data", "chrome-profile"),
    // Remote-debugging port so the SAME live browser can be opened/controlled
    // from the user's Windows browser at http://localhost:<port>/devtools/inspector.html
    // — a guaranteed view even when the WSLg window won't display.
    debugPort: Number(process.env.AUTOMATOR_DEBUG_PORT || 9333),
    // Records WHICH account the persisted session belongs to, so the automator
    // can detect new credentials and stop posting to the previous account.
    sessionAccount: path.join(ROOT, "data", "session-account.json"),
  },

  credentials: {
    // Behance / site credentials loaded from environment or .env file.
    email: process.env.BEHANCE_EMAIL || "",
    password: process.env.BEHANCE_PASSWORD || "",
  },

  // Optional LLM backend used by the browser agent for smarter discovery.
  llm: {
    provider: process.env.LLM_PROVIDER || "",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "",
  },
};

export function projectDirs() {
  for (const dir of [
    config.workflowsDir,
    config.dataDir,
    config.logsDir,
    config.screenshotsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}