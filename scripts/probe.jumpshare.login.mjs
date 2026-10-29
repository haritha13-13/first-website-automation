#!/usr/bin/env node
/**
 * JumpShare login + post-login app exploration.
 * Goes to jumpshare.com/login, dumps the form, logs in, and maps the app UI.
 */
import fs from "node:fs";
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
page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log("   NAV ->", f.url()); });
setTimeout(() => process.exit(2), 120000).unref();

const dumpForm = async (label) => {
  const d = await page.evaluate(() => ({
    url: location.href,
    text: (document.body?.innerText || "").replace(/\n{2,}/g, "\n").slice(-500),
    inputs: [...document.querySelectorAll("input, select, textarea")].map((i) => ({ tag: i.tagName, type: i.type, id: i.id, name: i.name, ph: i.placeholder, auto: i.autocomplete })).slice(0, 12),
    buttons: [...document.querySelectorAll("button, [role='button'], a")].filter((b) => (b.textContent || "").trim().length <= 30 && b.getBoundingClientRect().width > 0).map((b) => ({ t: (b.textContent || "").trim().slice(0, 28), id: b.id, name: b.name, href: (b.href || "").slice(0, 50) })).slice(0, 16),
  }));
  console.log("\n===== " + label + " =====\nURL: " + d.url + "\n" + d.text.slice(-260));
  console.log("INPUTS:", JSON.stringify(d.inputs, null, 1));
  console.log("BUTTONS:", JSON.stringify(d.buttons, null, 1));
  return d;
};

await page.goto("https://jumpshare.com/login", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
await page.waitForTimeout(6000);
await dumpForm("login page");

// Are we already logged in? Check for a redirect to app/dashboard.
if (/app\.jumpshare|You're already logged|library|dashboard/i.test(page.url() + (await page.evaluate(() => (document.body?.innerText || "").slice(0, 300))).toString())) {
  console.log("\nALREADY LOGGED IN? url=", page.url());
} else {
  // Fill email/password
  const filled = await page.evaluate(({ EMAIL, PASSWORD }) => {
    const set = (el, v) => {
      if (!el) return false;
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const emailEl = document.querySelector('input[type="email"], input[name*="email" i], input[name*="user" i], input[autocomplete="username"]') || [...document.querySelectorAll("input")][0];
    const pwEl = document.querySelector('input[type="password"]');
    const okE = set(emailEl, EMAIL);
    const okP = set(pwEl, PASSWORD);
    return { okE, okP, emailSel: emailEl && (emailEl.id || emailEl.name), pwSel: pwEl && (pwEl.id || pwEl.name) };
  }, { EMAIL, PASSWORD }).catch((e) => ({ err: e.message }));
  console.log("\nfilled:", JSON.stringify(filled));
  await page.waitForTimeout(1200);

  const submitInfo = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button, [type=submit], a")];
    const submit = btns.find((b) => /^log in$/i.test((b.textContent || "").trim())) || btns.find((b) => /log in|sign in/i.test((b.textContent || "").trim()) && b.getBoundingClientRect().width > 0);
    if (!submit) return { clicked: false };
    submit.click();
    return { clicked: true, t: (submit.textContent || "").trim().slice(0, 20) };
  }).catch((e) => ({ err: e.message }));
  console.log("submit:", JSON.stringify(submitInfo));
}

await page.waitForTimeout(12000);
await dumpForm("after login submit");

// If we're logged in (dashboard/app), save session and dump app links.
const afterText = await page.evaluate(() => (document.body?.innerText || "").slice(0, 800));
if (/log ?out|logout|account|dashboard|upload|library/i.test(afterText) && !/log ?in/i.test(afterText.slice(0, 200))) {
  console.log("\n>> Looks logged in — persisting session");
  await persistSession(context, { email: EMAIL, siteName: "jumpshare" }).catch((e) => console.log("persist err", e.message.split("\n")[0]));
  await page.waitForTimeout(4000);
  await dumpForm("post-login app");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://jumpshare.com" }).catch(() => {});
} else {
  console.log("\n>> login may not have completed yet; body head:", afterText.slice(0, 200));
}
await closeBrowser(browser);
process.exit(0);