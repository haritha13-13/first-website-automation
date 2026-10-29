#!/usr/bin/env node
/**
 * Import a working Behance login session into the automator so it NEVER needs
 * Google OAuth / confirmation emails again.
 *
 * How to get the cookies (30 seconds):
 *   1. In your normal Windows browser, log into Behance as speedbotsdm@gmail.com
 *      (the account where "the workflow was good").
 *   2. Press F12 -> Application (left menu) -> Cookies -> https://www.behance.net
 *   3. There is a page of rows. Click the first row, then Ctrl+A to select ALL
 *      rows, Ctrl+C to copy them (DevTools copies them as a tab-separated grid).
 *   4. Paste that copied text into:  data/paste-cookies.txt
 *   5. Run:  node scripts/import.session.mjs
 *      It converts the grid into data/session.json (Playwright storageState).
 *
 * After this, run.live logs into Behance INSTANTLY using the saved cookies and
 * skips the email-confirmation entirely.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const srcFile = process.argv[2] || path.join(ROOT, "data", "paste-cookies.txt");

if (!fs.existsSync(srcFile)) {
  console.error("No cookie dump found at " + srcFile);
  console.error("Do the 4 steps above, then run this again.");
  process.exit(1);
}

const raw = fs.readFileSync(srcFile, "utf8");
const rows = raw
  .split(/\r?\n/)
  .map((l) => l.replace(/\s+$/, "").split(/\t/))
  .filter((r) => r.length >= 4 && r[0] && r[2] && r[2] !== "Domain");

const COOKIE_KEYS = ["name", "value", "domain", "path"];
const cookies = [];
const seen = new Set();
for (const r of rows) {
  const name = r[0];
  const value = r[1];
  const domain = (r[2] || "").replace(/^\./, "");
  const pth = r[3] || "/";
  if (!name || name === "Name") continue;
  const key = `${domain}|${name}|${value}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const maxAge = parseInt(r[4], 10) || undefined;
  const httpOnly = r[5] === "TRUE";
  const secure = r[6] === "TRUE";
  const sameSite = { "Lax": "Lax", "Strict": "Strict", "None": "None" }[(r[7] || "").trim()] || "Lax";
  const expires = Number.isFinite(maxAge) && maxAge > 0 ? (Date.now() / 1000) + maxAge : -1;
  cookies.push({
    name,
    value,
    domain,
    path: pth || "/",
    expires,
    httpOnly,
    secure,
    sameSite,
  });
}

if (!cookies.length) {
  console.error("No cookies parsed — make sure you copy the grid how DevTools shows it (Name␠Value␠Domain␠Path).");
  process.exit(1);
}

const behance = cookies.filter((c) => /behance\.net$/.test(c.domain));
const adobe = cookies.filter((c) => /adobe\.com$/.test(c.domain));
fs.mkdirSync(config.dataDir, { recursive: true });
fs.writeFileSync(
  config.browser.storageState,
  JSON.stringify({ cookies, origins: [] }, null, 2)
);
fs.writeFileSync(
  config.browser.sessionAccount,
  JSON.stringify({
    email: "speedbotsdm@gmail.com",
    siteName: "behance",
    savedAt: new Date().toISOString(),
  }, null, 2)
);

console.log(`Imported ${cookies.length} cookies → ${config.browser.storageState}`);
console.log(`  behance.net: ${behance.length}   adobe.com: ${adobe.length}`);
if (behance.length < 3) {
  console.error("WARNING: very few behance.net cookies — the session may miss auth cookies. Re-copy them including the adobe.com rows too.");
}
console.log("Done. Next run will open Behance already logged in — no Google, no confirmation email.");