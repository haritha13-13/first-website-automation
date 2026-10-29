#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser, newPage, closeBrowser, getOzonePlatform, maximizeBrowserWindow } from "../src/browser/browser.js";
import { loadEnv } from "../src/common/env.js";
import { ok, warn } from "../src/common/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
loadEnv();

process.env.AUTOMATOR_HEADLESS = "0";

const outDir = path.join(ROOT, "artifacts");
fs.mkdirSync(outDir, { recursive: true });

const browser = await launchBrowser();
console.log(`ozone platform: ${getOzonePlatform()}`);
const { page, context } = await newPage(browser);
await maximizeBrowserWindow(context).catch(() => warn("maximize failed"));
await page.goto("https://www.behance.net/", { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
await page.waitForTimeout(4000);
const bounds = await context.newCDPSession(page).then((cdp) =>
  cdp.send("Browser.getWindowForTarget").then(({ windowId }) => cdp.send("Browser.getWindowBounds", { windowId }).then(({ bounds }) => ({ windowId, bounds })))
).catch(() => null);
console.log("window bounds:", JSON.stringify(bounds, null, 2));
const shot = path.join(outDir, "visibility-probe.png");
await page.screenshot({ path: shot, fullPage: false }).catch(() => warn("screenshot failed"));
console.log("screenshot: ", shot, "size:", fs.existsSync(shot) ? fs.statSync(shot).size : "NONE");
ok("Probe done — check the artifacts/visibility-probe.png to confirm rendering.");
await closeBrowser(browser);