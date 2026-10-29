#!/usr/bin/env node
/**
 * Manual DocHub flow probe: map the real steps to publish a document and get a
 * shareable link, using the provided account. Logs every observed control.
 */
import fs from "node:fs";
import path from "node:path";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const EMAIL = "speedbotsdm@gmail.com";
const PASSWORD = "speedbotsdm@2025";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
const snap = (label) => page.evaluate((label) => {
  const txt = (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 600);
  const btns = [...document.querySelectorAll("button, a[role='button'], a.btn, input[type='submit']")].map((e) => ({ t: (e.textContent || e.value || "").trim().slice(0, 25), sel: `#${e.id}|.${(e.className + "").split(" ")[0]}` })).slice(0, 18);
  return { label, url: location.href, text: txt, controls: btns };
}, label).then((s) => { console.log("\n===== " + s.label + " ====="); console.log("URL:", s.url); console.log("TEXT>>>", s.text, "<<<"); console.log("CTRLS:", JSON.stringify(s.controls, null, 0)); });

await snap("home");
// look for sign-in link
await page.goto("https://dochub.com/sign-in", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(3000);
await snap("sign-in page");

const fields = await page.locator("input").count();
console.log("\ninput count on sign-in:", fields);
const fieldInfo = await page.evaluate(() => [...document.querySelectorAll("input")].map((i) => ({ type: i.type, name: i.name, id: i.id, ph: i.placeholder })));
console.log(JSON.stringify(fieldInfo, null, 1));
await closeBrowser(browser);
process.exit(0);