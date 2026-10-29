import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export function now() {
  return new Date().toISOString();
}

export function ensureDirs() {
  for (const dir of [
    config.workflowsDir,
    config.dataDir,
    config.logsDir,
    config.screenshotsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn(`[util] WARN: could not read ${file}: ${err.message}`);
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  return file;
}

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function screenshot(page, name) {
  ensureDirs();
  const file = path.join(config.screenshotsDir, `${name}-${Date.now()}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

export async function tryLoginWithEnv(page, siteUrl) {
  const creds = {
    email: process.env.BEHANCE_EMAIL || "",
    password: process.env.BEHANCE_PASSWORD || "",
  };
  if (!creds.email || !creds.password) return null;
  return creds;
}

export function logSection(title) {
  console.log("");
  console.log("=====================================================");
  console.log(`  ${title}`);
  console.log("=====================================================");
  emit(["meta", title]);
}

export function info(msg) {
  const line = `[info] ${msg}`;
  console.log(line);
  emit(["info", line]);
}

export function ok(msg) {
  const line = `[ok]   ${msg}`;
  console.log(line);
  emit(["ok", line]);
}

export function warn(msg) {
  const line = `[warn] ${msg}`;
  console.warn(line);
  emit(["warn", line]);
}

export function error(msg) {
  const line = `[error] ${msg}`;
  console.error(line);
  emit(["err", line]);
}

// --- Output broadcast (live mirror / watch feed) ----------------------------
const outputSubscribers = [];
function emit(entry) {
  for (const fn of outputSubscribers.slice()) {
    try {
      fn(entry);
    } catch {
      /* a subscriber must never break logging */
    }
  }
}
/** Subscribe to every ok/warn/info/error line the agent prints. Returns unsubscribe. */
export function subscribeOutput(fn) {
  outputSubscribers.push(fn);
  return () => {
    const i = outputSubscribers.indexOf(fn);
    if (i >= 0) outputSubscribers.splice(i, 1);
  };
}