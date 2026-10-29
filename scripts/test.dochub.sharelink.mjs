#!/usr/bin/env node
/**
 * DocHub share-link capture, one-time reCAPTCHA assist.
 * Drives a HEADED browser to the "Get Shareable Link" step, where DocHub shows
 * "Verification Required". The user clicks "Continue with reCAPTCHA" and solves
 * it once; this script then reads the copyable shareable link.
 */
import fs from "node:fs";
import { launchBrowser, newPage, closeBrowser, maximizeBrowserWindow, armUserActivity, raiseBrowserWindow, persistSession } from "/home/haritha_13/behance-backlink-automator/src/browser/browser.js";
import { loadEnv } from "/home/haritha_13/behance-backlink-automator/src/common/env.js";
loadEnv();
const ROOT = "/home/haritha_13/behance-backlink-automator";
const DOC = process.env.DOCHUB_DOC || "/mnt/c/Users/haris/Downloads/ai-automation (1).docx";
const EMAIL = "speedbotsdm@gmail.com";

const browser = await launchBrowser();
const { page, context } = await newPage(browser, {
  storageState: fs.existsSync(ROOT + "/data/session.json") ? ROOT + "/data/session.json" : undefined,
});
await armUserActivity(page).catch(() => {});
await maximizeBrowserWindow(context).catch(() => {});
await raiseBrowserWindow(context).catch(() => {});

console.log("Step 1/5: open /new and upload document...");
await page.goto("https://dochub.com/new", { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => console.log("goto err:", e.message.split("\n")[0]));
await page.waitForTimeout(5000);
await page.locator("input[type=file]").first().setInputFiles(DOC).catch((e) => console.log("upload err:", e.message.split("\n")[0]));
await page.waitForTimeout(12000);

console.log("Step 2/5: click 'Create Document'...");
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button")].find((b) => /^Create Document$/i.test((b.textContent || "").trim()));
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(15000);

console.log("Step 3/5: dismiss onboarding, open Share dialog...");
await page.evaluate(() => {
  const skip = [...document.querySelectorAll("button, [role='button']")].find((e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0);
  if (skip) skip.click();
}).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(() => { const b = document.querySelector("#share-send-btn"); if (b) b.click(); }).catch(() => {});
await page.waitForTimeout(5000);

console.log("Step 4/5: click 'Get Shareable Link'...");
await page.evaluate(() => {
  const el = [...document.querySelectorAll("button, [role='button'], a, div, span")].find((e) => {
    const t = (e.textContent || "").replace(/\s+/g, " ").trim();
    return /^Get Shareable Link/i.test(t) && e.getBoundingClientRect().width > 0 && e.children.length <= 3;
  });
  if (el) el.click();
}).catch(() => {});
await page.waitForTimeout(5000);

const textNow = await page.evaluate(() => (document.body?.innerText || "").slice(-500));
console.log("\n--- current dialog ---\n" + (textNow.match(/Verification Required[\s\S]{0,200}/) || [textNow.slice(-300)])[0] + "\n");
if (/Verification Required|reCAPTCHA|verify your account/i.test(textNow)) {
  console.log(`\n>>> DocHub is asking to verify the account. Please click "Continue with reCAPTCHA" in the browser window and solve it.`);
  console.log(`>>> Waiting up to 120s for you...\n`);
}

// Poll: wait until either link field appears or verification passes
let deadline = Date.now() + 180000;
let link = "";
while (Date.now() < deadline && !link) {
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => {
    const t = (document.body?.innerText || "").slice(-1200);
    const inputs = [...document.querySelectorAll("input")].filter((i) => (i.value || "").includes("dochub.com") || /link|url/i.test(i.id + i.className)).map((i) => (i.value || "").slice(0, 110));
    const anchors = [...document.querySelectorAll("a")].filter((a) => /dochub\.com\/\w/.test(a.href || "") && !/https:\/\/(help|legal|www)\.dochub\.com\//.test(a.href) && !/\/new$|documents|inbox|sent|templates|rooms|faxes|settings|pricing|release|helpdesk/.test(a.href)).map((a) => (a.href || "").slice(0, 110));
    return { text: t, inputs, anchors };
  });
  for (const u of [...s.inputs, ...s.anchors]) {
    if (/dochub\.com\/(d|s|share|doc|view)\//i.test(u) || /\?token=|#?share/i.test(u)) { link = u; break; }
  }
  if (!link && /Continue with reCAPTCHA|Verification Required/.test(s.text)) {
    // still waiting for user
  }
  console.log(`  t+${Math.round((Date.now() - (deadline - 120000)) / 1000)}s link=${link || "-"} recaptcha=${/reCAPTCHA/.test(s.text)}`);
}

console.log("\n--- final text tail ---");
console.log((await page.evaluate(() => (document.body?.innerText || "").slice(-600))));
if (link) {
  console.log("\nSHAREABLE LINK:", link);
  await raiseBrowserWindow(context).catch(() => {});
  await persistSession(context, { email: EMAIL, siteName: "dochub" }).catch(() => {});
} else {
  console.log("\nNo shareable link captured yet. The verification may still be pending or the link appears elsewhere.");
}
await closeBrowser(browser);
process.exit(link ? 0 : 1);