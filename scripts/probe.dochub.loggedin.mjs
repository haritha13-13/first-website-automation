#!/usr/bin/env node
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
  const txt = (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(0, 500);
  return { label, url: location.href, text: txt };
}, label).then((s) => console.log("\n===== " + s.label + " =====\nURL: " + s.url + "\n" + s.text));

await page.goto("https://dochub.com/sign-in", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
await page.waitForTimeout(2500);

// Fill email + password
await page.fill("#email", EMAIL).catch((e) => console.log("fill email err:", e.message.split("\n")[0]));
const pwSel = await page.evaluate(() => { const i = document.querySelectorAll("input[type='password']"); return i.length ? (i[i.length - 1].id) : "none"; });
console.log("password input id:", pwSel);
await page.fill("#" + pwSel, PASSWORD).catch((e) => console.log("fill pw err:", e.message.split("\n")[0]));
await page.click("#dh-email-login-btn").catch((e) => console.log("click login err:", e.message.split("\n")[0]));
await page.waitForTimeout(8000);
await snap("after login attempt");

const loggedIn = await page.evaluate(() => !!(document.querySelector("#email")) === false || /sign-in/.test(location.href) === false);
console.log("\nprobably logged in:", !/sign-in/.test(page.url()));

// Landing page for logged-in users — find create/upload + share options
const ctls = await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button, a[role='button'], a.btn")].map((e) => ({ t: (e.textContent || "").trim().slice(0, 30), href: (e.href || "").slice(0, 60), sel: (e.id ? "#" + e.id : "." + (e.className + "").split(" ")[0]) })).filter((b) => b.t || b.href);
  return btns.slice(0, 30);
});
console.log("\nCTRLS:", JSON.stringify(ctls, null, 1));

await closeBrowser(browser);
process.exit(0);