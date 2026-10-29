import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";
import { launchBrowser, newPage, closeBrowser, raiseBrowserWindow, maximizeBrowserWindow, armUserActivity, suspendRaise, resumeRaise, isStopRequested, persistSession } from "../browser/browser.js";
import { startLiveView } from "../ui/liveview.js";
import { startWatch } from "../ui/watch.js";
import { collectInputs, collectButtons, collectLinks, visibleText, currentUrl } from "../browser/domProbe.js";
import { saveWorkflow, isValidWorkflow, workflowKey, listWorkflows } from "./repository.js";
import { ok, warn, error, logSection, screenshot } from "../common/util.js";

/**
 * Browser Agent: navigates a real browser to the target site, observes the
 * DOM, discovers the "create & publish a post" workflow, generates a workflow
 * definition, validates it (best-effort) and saves it to the repository.
 *
 * Heuristic-based by default so it runs with zero API keys. If an LLM backend
 * is configured, discovery can be routed through an AI model for smarter
 * field mapping (see src/workflow/agent.llm.js).
 */

export async function runDiscovery({ siteUrl, siteName, credentials } = {}) {
  siteUrl = String(siteUrl || "").trim();
  logSection(`Browser Agent Discovery: ${siteName || siteUrl}`);
  const browser = await launchBrowser();
  const { page, context } = await newPage(browser, {
    storageState: fs.existsSync(config.browser.storageState) ? config.browser.storageState : undefined,
  });
  await armUserActivity(page).catch(() => {});

  if (!config.browser.headless) {
    // Guarantee the automation window is on-screen, restacked ABOVE the
    // terminal and fully within the visible screen from the start (WSLg
    // windows can open behind the terminal, off-screen or over-scaled wide).
    await raiseBrowserWindow(context).catch(() => {});
    ok(`Headed browser active — watch the REAL window “Create Project :: Behance - Google Chrome for testing” on your desktop (top-left).`);
    ok(`If you can’t find it: press Win+Tab (Task View) → click it — it may be on another virtual desktop.`);
  }

  // Keep the real browser window raised ALL run long (not only at CAPTCHA)
  // every 5s, so you can watch the agent work in the Behance editor live.
  let raiseWatchdog = null;
  if (!config.browser.headless) {
    raiseWatchdog = setInterval(() => {
      raiseBrowserWindow(page.context(), { gentle: true }).catch(() => {});
    }, 5000);
  }

  // Live terminal view: watch the automation actions as they happen.
  const liveView = config.browser.headless ? null : startLiveView(page);
  // Crisp live mirror (OPT-IN via AUTOMATOR_WATCH=1; off by default).
  const watch = config.browser.headless ? null : startWatch(page);

  const discovered = {
    steps: [],
    visitedUrls: new Set(),
    inputsSeen: [],
    buttonsSeen: [],
    linksSeen: [],
    fieldCandidates: {},
    login: [],
    signup: [],
    authRequired: false,
    publishCandidates: [],
    confirmation: [],
    confirmed: false,
    missing: [],
  };

  const finishPartial = async (ctx) => {
    const workflow = buildWorkflow(discovered, { siteUrl, siteName }, { partialContext: ctx.context });
    const file = saveWorkflow(siteUrl, workflow);
    ok(`Partial workflow saved -> ${file}`);
    console.log("");
    console.log(summarizeWorkflow(workflow));
    return { workflow, file, partial: true };
  };

  try {
    // --- Step 1: open the site root -------------------------------------
    discovered.steps.push({ id: "goto-home", action: "goto", url: siteUrl.replace(/\/+$/, "/") });
    await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3000);
    discovered.visitedUrls.add(page.url());

    // --- Step 2: detect login wall / logged-out state -------------------
    const hasLogin = await page.locator('a[href*="login"i], button:has-text("Log In"), a:has-text("Log In")').first().isVisible().catch(() => false);
    const hasPhoto = await page.locator('[data-testid="header-profile-photo"], [class*="avatar"], [class*="profile-photo"]').first().isVisible().catch(() => false);

    discovered.authRequired = hasLogin && !hasPhoto;

    if (discovered.authRequired) {
      warn(`Login/sign-up required detected (${siteUrl}) — recording auth steps.`);
      await captureLoginFlow(discovered, page, { url: siteUrl });
      if (credentials && credentials.email && credentials.password) {
        // 1) login with the provided credentials FIRST (the agent fills email +
        //    password; the user only solves the reCAPTCHA), 2) sign-up for a
        //    brand-new site, 3) manual.
        if (await attemptLogin(page, discovered, credentials)) {
          await persistSession(context, { email: credentials && credentials.email ? credentials.email : "", siteName });
          ok("Logged in — session persisted to data/session.json");
          discovered.authRequired = false; // authenticated now
        } else if (await attemptSignup(page, discovered, credentials)) {
          await persistSession(context, { email: credentials && credentials.email ? credentials.email : "", siteName });
          ok("Account created — session persisted to data/session.json");
          discovered.authRequired = false; // authenticated now
        } else if (await manualLoginTakeover(page)) {
          await persistSession(context, { email: credentials && credentials.email ? credentials.email : "", siteName });
          ok("Manual login completed — session persisted to data/session.json");
          discovered.authRequired = false;
        } else {
          warn(`Login/sign-up attempt failed — stopping discovery (locked out).`);
          return await finishPartial({ siteUrl, siteName, context: "login-failed" });
        }
      } else {
        warn("No credentials provided — stopping discovery here (create/publish flow is login-gated).");
        return await finishPartial({ siteUrl, siteName, context: "login-required" });
      }
    } else if (!(await isLoggedIn(page)) && credentials && credentials.email && credentials.password) {
      // Brand-new site with no login wall (only "Sign Up" visible): create the
      // account with the provided credentials, else fall back to login/manual.
      ok("Not authenticated yet. Looking for a Sign Up option…");
      await captureLoginFlow(discovered, page, { url: siteUrl });
      const okSignup = await attemptSignup(page, discovered, credentials);
      if (okSignup) {
        await persistSession(context, { email: credentials && credentials.email ? credentials.email : "", siteName });
        ok("Account created — session persisted to data/session.json");
      } else if (await attemptLogin(page, discovered, credentials)) {
        await persistSession(context, { email: credentials && credentials.email ? credentials.email : "", siteName });
        ok("Logged in — session persisted to data/session.json");
      } else if (await manualLoginTakeover(page)) {
        await persistSession(context, { email: credentials && credentials.email ? credentials.email : "", siteName });
        ok("Manual login completed — session persisted to data/session.json");
      }
    } else {
      ok("No login wall detected (or session already stored) — continuing.");
    }

    // --- Step 2b: if the publishing section redirects back to login, re-auth ---
    if (!(await isLoggedIn(page))) {
      warn("Authentication required again for the publishing section — re-authenticating.");
      let reAuthed = false;
      if (credentials && credentials.email && credentials.password) {
        await captureLoginFlow(discovered, page, { url: page.url() });
        reAuthed = await attemptLogin(page, discovered, credentials);
      }
      if (!reAuthed) reAuthed = await manualLoginTakeover(page);
      if (!reAuthed) {
        warn("Re-authentication failed — discovery will be best-effort (publish steps may be incomplete).");
        discovered.missing.push("re-authentication failed");
      }
    }

    // --- Step 3: navigate to the create/publish entry point -------------
    const entryFound = await findCreateEntryPoint(discovered, page, { mustCreate: true });
    if (!entryFound) {
      warn("Could not locate the create/publish entry point — stopping discovery.");
      return await finishPartial({ siteUrl, siteName, context: "no-create-entry" });
    }

    // --- Step 4: on editor, add media blocks (image + text + body) ---------
    await discoverEditorFields(discovered, page);

    // --- Step 5: open the publish dialog; map title/tags/visibility ---------
    await discoverPublishModal(discovered, page);

    // --- Step 6: quick pause so we grab a screenshot of the editor -------
    await screenshot(page, "discovery-editor");

    // --- Step 7: build + save the workflow -------------------------------
    const workflow = buildWorkflow(discovered, { siteUrl, siteName });
    await validateAndPatch(discovered, workflow, page);
    const file = saveWorkflow(siteUrl, workflow);
    ok(`Workflow saved -> ${file}`);

    const summary = summarizeWorkflow(workflow);
    console.log("");
    console.log(summary);

    return { workflow, file, partial: workflow.status === "partial" };
  } catch (err) {
    if (isStopRequested()) {
      warn("Discovery stopped by user (Ctrl+C) — nothing was saved.");
      return { workflow: null, file: null, partial: false, interrupted: true };
    }
    error(`Discovery failed: ${err.message}`);
    await screenshot(page, "discovery-error").catch(() => {});
    throw new Error(`Discovery error: ${err.message}`);
  } finally {
    if (raiseWatchdog) clearInterval(raiseWatchdog);
    if (watch) watch.stop();
    if (liveView) liveView.stop();
    await closeBrowser(browser);
  }
}

// ---------------------------------------------------------------------------
// CAPTCHA-aware login: automation pauses while the user solves "I'm not a
// robot" verification, then resumes automatically and keeps discovering.
// ---------------------------------------------------------------------------
const CAPTCHA_WAIT_MS = Number(process.env.AUTOMATOR_CAPTCHA_WAIT_MS || 150_000);

// Only genuinely rendered/actionable challenge widgets count as a CAPTCHA.
// Generic words like "security check" or hidden badge iframes do NOT, so a
// page that merely mentions "captcha" never hangs the discovery for minutes.
async function detectCaptcha(page) {
  try {
    return await page
      .evaluate(() => {
        const check = (sel) => {
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.width >= 24 && r.height >= 24) return true;
          }
          return false;
        };
        if (check('iframe[src*="api2/anchor"]')) return true; // reCAPTCHA v2 checkbox widget
        if (check('iframe[src*="recaptcha/enterprise/anchor"]')) return true; // reCAPTCHA enterprise checkbox
        if (check('iframe[src*="/bframe"]')) return true; // reCAPTCHA challenge grid (v2 + enterprise)
        if (check('iframe[title*="challenge" i]')) return true; // open challenge popup
        if (check('iframe[src*="hcaptcha"]')) return true; // hCaptcha widget
        if (check('[data-sitekey]')) return true; // render container
        if (check('[class*="g-recaptcha"]:not([class*="badge"])')) return true;
        // Custom "I'm not a robot" checkbox rendered by the site itself.
        const t = document && document.body ? document.body.innerText.slice(0, 12000) : "";
        if (/i["']?m not a robot|verify\s+you\s+are\s+(a\s+)?(human|not a robot)/i.test(t)) return true;
        return false;
      })
      .catch(() => false);
  } catch {
    return false;
  }
}

/**
 * Locate the page that actually shows the CAPTCHA widget. The challenge often
 * opens in a SEPARATE popup window (reCAPTCHA popup type) that is a sibling
 * page in the same context — never the signin page itself, so we scan them all.
 * Returns the offending page, or null when no challenge is pending.
 */
async function findCaptchaPage(page) {
  const candidates = [page, ...(page.context().pages() || []).filter((p) => p !== page)];
  for (const candidate of candidates) {
    if (await detectCaptcha(candidate)) return candidate;
  }
  return null;
}

/**
 * If a CAPTCHA is visible, pause automation and wait for the user to solve it
 * in the (visible) browser window. Returns true once it was present AND got
 * resolved (automation should resume); false when nothing was pending.
 * In headless mode it cannot be solved — the caller decides what to do.
 */
async function awaitCaptchaResolution(page, waitMs = CAPTCHA_WAIT_MS) {
  if (!(await findCaptchaPage(page))) return false;
  if (config.browser.headless) {
    warn(`CAPTCHA detected but the browser is headless — it can’t be solved live. Re-run with AUTOMATOR_HEADLESS=0 so you can solve it.`);
    return false;
  }
  // Pull EVERY automation window (the challenge is often its own popup window)
  // onto the screen, forced ABOVE your terminal (minimize→restore restack), and
  // kept in front with re-assertion every few seconds while the pause runs.
  const title = (await page.title().catch(() => "")) || "window";
  const raised = await raiseBrowserWindow(page.context());
  await armUserActivity(page);
  const windowCount = page.context().pages().length;
  warn(`CAPTCHA / “I’m not a robot” detected at ${page.url()}`);
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    const { bounds } = await cdp.send("Browser.getWindowBounds", { windowId });
    warn(`>>> window geometry: state=${bounds.windowState} ${bounds.width}x${bounds.height} @ (${bounds.left},${bounds.top}) — the automation window EXISTS and is on-screen.`);
  } catch {}
  warn(`>>> BROWSER WINDOW: “${title} - Google Chrome for testing [ubuntu]”${windowCount > 1 ? ` (${windowCount} Chrome windows are open — the CAPTCHA may be in one of the others)` : ""}`);
  warn(`>>> ${raised ? "It was just restacked ABOVE your terminal, placed in the top-left of your screen." : "It could not be auto-raised — see the hints below."}`);
  warn(`>>> If a Chrome window flashed and then slid behind your terminal, don’t fight it — the agent RE-RAISES it for you every few seconds.`);
  warn(`>>> Still don’t see it?  (one of these always works)`);
  warn(`    • press Win+Tab (Task View) — every Chrome window, even on another virtual desktop, is listed here; click it.`);
  warn(`    • or press Ctrl+Win+→ / Ctrl+Win+← to hop between virtual desktops.`);
  warn(`    • or in Windows Task Manager you can “Bring to front” a WSL window.`);
  warn(`>>> ALSO: this terminal now shows the page LIVE (grayscale preview + status line every 2.5s), and the full screenshot is saved to artifacts/screenshots/live-latest.png.`);
  warn(`>>> TO SOLVE: 1) click the “I’m not a robot” checkbox, 2) do the confirmation, 3) DONE — the agent will click “Sign in” itself.`);
  warn(`>>> The agent waits up to ${Math.round(waitMs / 1000)}s — it resumes automatically once you finish.`);
  await screenshot(page, "captcha-pause").catch(() => {});
  // The window was already restacked to the top-left above the work — now
  // FREEZE all re-raises while the user clicks the challenge (every other
  // touch would steal focus and make the grid "blink" / drop the Verify click).
  suspendRaise();
  const deadline = Date.now() + waitMs;
  try {
    while (Date.now() < deadline) {
      if (isStopRequested()) return false;
      try {
        if (!(await findCaptchaPage(page))) {
          ok("CAPTCHA solved — resuming automation.");
          return true;
        }
        await page.waitForTimeout(2000);
      } catch {
        if (isStopRequested()) return false; // browser closed by Ctrl+C
        throw new Error("CAPTCHA wait failed", { cause: null });
      }
    }
    warn("CAPTCHA wait timed out — continuing anyway (solve it later if it re-appears).");
    return true;
  } finally {
    resumeRaise();
  }
}

// Some login screens (SlideShare, etc.) require selecting "Continue with Email"
// before the email/password form appears.
async function selectContinueWithEmail(page) {
  const cta = page
    .locator(
      'button:has-text("Continue with Email"), a:has-text("Continue with Email"), ' +
        'button:has-text("Continue with email"), label:has-text("Email"), [data-testid*="email" i]'
    )
    .first();
  if (await cta.count()) {
    ok("[agent] Selecting Continue with Email…");
    await cta.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(2000);
    await awaitCaptchaResolution(page);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Login capture + attempt
// ---------------------------------------------------------------------------
async function captureLoginFlow(d, page, { url }) {
  // Prefer a dedicated /login page if the header link points there.
  const loginHref = await page
    .locator('a[href*="login"i]')
    .first()
    .getAttribute("href")
    .catch(() => null);
  if (loginHref) {
    const target = new URL(loginHref, url).href;
    d.steps.push({ id: "goto-login", action: "goto", url: target });
    await page.goto(target, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
  } else {
    const loginBtn = page.locator('button:has-text("Log In"), a:has-text("Log In")').first();
    if (await loginBtn.count()) {
      d.steps.push({ id: "open-login", action: "click", text: "Log In" });
      await loginBtn.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
  }
  d.visitedUrls.add(page.url());
  await selectContinueWithEmail(page);
  await scanLoginFields(d, page);
  d.login = d.steps.filter((s) => s.id.startsWith("login-"));
}

async function scanLoginFields(d, page) {
  const fields = await page.evaluate(collectInputs);
  const email = fields.find((f) => f.type === "email" || /email|username|mail/i.test([f.name, f.placeholder, f.ariaLabel, f.label].join(" ")));
  if (email) d.steps.push({ id: "login-email", action: "fill", selector: email.selector, property: "_email", value: "", stepType: "login" });
  const pw = fields.find((f) => f.type === "password");
  if (pw) d.steps.push({ id: "login-password", action: "fill", selector: pw.selector, property: "_password", value: "", stepType: "login" });
  const submit = await findButton(page, ["log in", "sign in", "continue", "next", "submit"]);
  if (submit) d.steps.push({ id: "login-submit", action: "click", selector: submit.selector, stepType: "login" });
}

async function attemptLogin(page, d, creds) {
  let loginPage = null;
  try {
    if (d.login.length) {
      // Recorded login steps (captureLoginFlow) walk the fields one by one.
      for (const step of d.login) {
        if (isStopRequested()) return false;
        if (step.action === "fill") {
          const value = step.property === "_email" ? creds.email : creds.password;
          if (!value) throw new Error(`missing ${step.property}`);
          const el = page.locator(step.selector).first();
          await el.fill(value);
        } else if (step.action === "click") {
          const btn = step.selector ? page.locator(step.selector).first() : null;
          if (btn && (await btn.count())) {
            await btn.click({ timeout: 5000 }).catch(() => {});
          }
        }
        // Pause for CAPTCHA between login steps, then resume entering fields.
        await awaitCaptchaResolution(page);
      }
      loginPage = page;
    } else {
      // Preferred flow: the agent ENTERS the email + password itself; the user
      // only ticks the reCAPTCHA checkbox + confirms; the agent then presses
      // the real Sign-in button.
      await page.waitForTimeout(1200);
      await selectContinueWithEmail(page);

      // "Continue with Email" NAVIGATES to the real login form (SlideShare:
      // /login/email). Filling during the navigation hits the old page which
      // has no fields — so first WAIT until the form actually loads, scanning
      // every window in the context (slideshare's form sits on the main page).
      loginPage = await waitForLoginForm(page, 15000);
      if (!loginPage) {
        warn("Could not reach the login form (email/password) — dumping what the page exposed:");
        await dumpInputs(page);
        return false;
      }

      const emailSaved = await fillLoginField(loginPage, creds.email, [
        "#user_login", "input[type='email']", 'input[autocomplete="username"]', 'input[name*="email" i]',
      ]);
      const pwSaved = await fillLoginField(loginPage, creds.password, [
        "#user_password", 'input[type="password"]', 'input[autocomplete="current-password"]', 'input[name*="password" i]',
      ]);
      ok(`Agent auto-filled ${emailSaved ? "email ✓" : "EMAIL ✗ (you will need to type it)"} and ${pwSaved ? "password ✓" : "PASSWORD ✗ (you will need to type it)"}.`);

      // Trigger the submit via the real button; this is what surfaces the
      // reCAPTCHA "I'm not a robot" checkbox.
      const submitBtn = await findFormSubmit(loginPage);
      if (submitBtn) {
        await submitBtn.click({ timeout: 6000 }).catch(() => loginPage.keyboard.press("Enter"));
      } else {
        await loginPage.keyboard.press("Enter");
      }
      await loginPage.waitForTimeout(3500);

      // The reCAPTCHA now needs the USER: tick the box + confirmation.
      if (await findCaptchaPage(loginPage)) {
        ok("Please tick “I'm not a robot” and do the confirmation — the agent will click “Sign in” right after.");
        await awaitCaptchaResolution(loginPage, CAPTCHA_WAIT_MS);
      }

      // CAPTCHA cleared → click the real Sign-in button again (some forms need
      // the re-trigger now that the token is valid), else press Enter.
      const btn = await findFormSubmit(loginPage);
      if (btn) {
        await btn.click({ timeout: 6000 }).catch(() => {});
        await loginPage.waitForTimeout(3000);
      } else {
        await loginPage.keyboard.press("Enter").catch(() => {});
        await loginPage.waitForTimeout(3000);
      }
      await attemptSignupEntryIfNeeded(loginPage);
    }
    // If a CAPTCHA blocked the final submit, keep waiting for it to clear so we
    // can verify login and continue with discovery (checks popup windows too).
    const check = loginPage || page;
    if (await findCaptchaPage(check)) {
      await awaitCaptchaResolution(check, CAPTCHA_WAIT_MS + 60_000);
    }
    await check.waitForTimeout(2000);
    return await isLoggedIn(check);
  } catch (err) {
    if (isStopRequested()) return false;
    warn(`Login attempt error: ${err.message}`);
    return false;
  }
}

/** Find the primary submit button on the login form ("Log in"/"Sign in"/"Continue"). */
async function findFormSubmit(page) {
  const sels = ['button[type="submit"]'];
  for (const t of ["log in", "sign in", "sign-in", "login", "continue", "next", "submit", "sign in to slideshare"]) {
    sels.push(`button:has-text("${t}")`);
    sels.push(`input[type="submit"][value*="${t}" i]`);
  }
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) return el;
  }
  return null;
}

/**
 * Wait until the real login form (email/password inputs) is present on ANY
 * window in the context. Returns the page that hosts it, or null on timeout.
 */
async function waitForLoginForm(page, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (isStopRequested()) return null;
    const candidates = [page, ...(page.context().pages() || []).filter((p) => p !== page)];
    for (const p of candidates) {
      for (const sel of ["#user_login", "#user_password", 'input[type="password"]', 'input[autocomplete="username"]']) {
        if (await p.locator(sel).first().count().catch(() => 0)) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return null;
}

/** Fill the FIRST matching field with `value` and confirm the value stuck. */
async function fillLoginField(page, value, selectors) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (!(await el.count().catch(() => 0))) continue;
    await el.fill(String(value), { timeout: 4000 }).catch(() => {});
    const v = await el.inputValue().catch(() => "");
    if (String(v) === String(value)) return true;
  }
  return false;
}

/** Log the input fields the page exposes, so a failed fill is diagnosable. */
async function dumpInputs(page) {
  const snaps = await page
    .evaluate(() =>
      [...document.querySelectorAll("input")].map((i) => `${i.id || "?"}#${i.type}#${i.name}#${i.autocomplete}`)
    )
    .catch(() => []);
  warn("   available inputs: " + (snaps.length ? snaps.join(" | ") : "(none)"));
}

/**
 * If the login form redirects into a "Create account / Sign Up" page instead,
 * click the minimal entry (without creating anything) so a real Sign-in link
 * or the password form becomes reachable. Best-effort, never destructive.
 */
async function attemptSignupEntryIfNeeded(page) {
  const visible = await page.locator('a[href*="login"i], button:has-text("Sign In"), a:has-text("Sign In"), button:has-text("Log In")').first().isVisible().catch(() => false);
  if (visible) await page.locator('a[href*="login"i], button:has-text("Sign In"), a:has-text("Sign In"), button:has-text("Log In")').first().click({ timeout: 4000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Account creation: a brand-new site with no saved workflow often only offers
// "Sign Up". We click it, use the user-provided email/password, accept the
// required Terms/Privacy checkboxes, handle CAPTCHA pauses, and verify the
// authenticated session before continuing discovery.
// ---------------------------------------------------------------------------
async function selectSignupEntry(d, page) {
  const sels = [
    'button:has-text("Sign Up")', 'a:has-text("Sign Up")', 'button:has-text("Sign up")', 'a:has-text("Sign up")',
    'button:has-text("Sign Up For Free")', 'a:has-text("Sign Up For Free")',
    'button:has-text("Create Account")', 'a:has-text("Create Account")', 'button:has-text("Create account")', 'a:has-text("Create account")',
    'button:has-text("Register")', 'a:has-text("Register")', 'button:has-text("Get Started")', 'a:has-text("Get Started")',
    'button:has-text("Join Now")', 'a:has-text("Join Now")', 'button:has-text("Join for Free")', 'a:has-text("Join for Free")',
    '[data-testid*="signup" i]', '[data-testid*="sign-up" i]',
  ];
  for (const sel of sels) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      ok(`[agent] Sign Up option found — clicking “${sel}”.`);
      await el.click({ timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await awaitCaptchaResolution(page);
      d.steps.push({ id: "signup-entry", action: "click", selector: sel, stepType: "signup" });
      return sel;
    }
  }
  const buttons = await page.evaluate(collectButtons).catch(() => []);
  const hit = buttons.find((b) => /sign\s?up|create\s?(an\s?)?account|register|get\s+started|join\s+(now|for\s+free)|create\s+your/i.test((b.text || "").trim()));
  if (hit && hit.selector) {
    ok(`[agent] Sign Up option found — clicking “${(hit.text || "").trim()}”.`);
    await page.locator(hit.selector).first().click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await awaitCaptchaResolution(page);
    d.steps.push({ id: "signup-entry", action: "click", selector: hit.selector, text: hit.text, stepType: "signup" });
    return hit.selector;
  }
  return null;
}

async function scanSignupFields(d, page) {
  await selectContinueWithEmail(page);
  const fields = await page.evaluate(collectInputs).catch(() => []);
  const email = fields.find((f) => f.type === "email" || /email|username|mail/i.test([f.name, f.placeholder, f.ariaLabel, f.label].join(" ")));
  if (email) d.steps.push({ id: "signup-email", action: "fill", selector: email.selector, property: "_email", value: "", stepType: "signup" });
  const pw = fields.find((f) => f.type === "password");
  if (pw) d.steps.push({ id: "signup-password", action: "fill", selector: pw.selector, property: "_password", value: "", stepType: "signup" });
  d.signup = d.steps.filter((s) => s.id.startsWith("signup-"));
  return { email, pw, fields };
}

/**
 * Auto-accept REQUIRED checkboxes (Terms & Conditions, Privacy Policy,
 * consent/age gates). Voluntarily-marketed boxes (newsletter, offers) are
 * deliberately skipped so we never sign the user up for marketing.
 */
async function acceptRequiredCheckboxes(page) {
  const data = await page
    .evaluate(() => {
      const out = [];
      document.querySelectorAll('input[type="checkbox"], [role="checkbox"]').forEach((el) => {
        let text = "";
        const id = el.id || el.getAttribute("aria-describedby") || "";
        const lab = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        if (lab) text = lab.innerText || "";
        if (!text) {
          const l = el.closest("label");
          if (l) text = l.innerText || "";
        }
        if (!text) {
          const w = el.closest('[role="checkbox"]') || el.parentElement;
          if (w) text = w.innerText || "";
        }
        out.push({ text: (text || "").slice(0, 240) });
      });
      return out;
    })
    .catch(() => []);
  const boxes = await page.locator('input[type="checkbox"], [role="checkbox"]').all();
  const REQUIRED = /term|condition|privacy|agree|consent|policy|age\s*\d+|e-?signature/gim;
  const OPT_OUT = /subscribe|newsletter|marketing|offer|promotion(al)?|updat|tip|product/i;
  let accepted = 0;
  for (let i = 0; i < boxes.length; i++) {
    const label = data[i]?.text || "";
    if (!REQUIRED.test(label)) continue;
    if (OPT_OUT.test(label)) continue; // skip marketing opt-ins
    const tag = await boxes[i].evaluate((el) => el.tagName).catch(() => "INPUT");
    const done =
      tag === "INPUT"
        ? await boxes[i]
            .evaluate((el) => {
              if (el.checked) return true;
              el.checked = true;
              el.dispatchEvent(new Event("click", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return el.checked;
            })
            .catch(() => false)
        : await boxes[i].click({ force: true }).then(() => true).catch(() => false);
    if (done) accepted++;
  }
  if (accepted) ok(`[agent] Accepted ${accepted} required checkbox(es) (Terms/Privacy/Consent).`);
  return accepted;
}

async function findSignupSubmit(page, excludeSelector) {
  const buttons = await page.evaluate(collectButtons).catch(() => []);
  const texts = ["create account", "sign up", "create my account", "get started", "register", "join", "submit", "continue"];
  for (const text of texts) {
    const hit = buttons.find(
      (b) =>
        b.role === "button" && // never the "Sign Up" nav anchor
        (b.text || "").toLowerCase().includes(text) &&
        (!excludeSelector || b.selector !== excludeSelector) &&
        b.visible !== false
    );
    if (hit) return hit;
  }
  return buttons.find((b) => b.role === "button" && b.visible !== false && (!excludeSelector || b.selector !== excludeSelector)) || null;
}

async function attemptSignup(page, d, creds) {
  try {
    if (!creds.email || !creds.password) {
      warn("No credentials provided — cannot create an account.");
      return false;
    }
    const found = await selectSignupEntry(d, page);
    if (!found) {
      warn("No Sign Up option available on this site.");
      return false;
    }
    const entrySelector = found;
    await page.waitForTimeout(1500);
    const { email, pw } = await scanSignupFields(d, page);
    await acceptRequiredCheckboxes(page);
    const emailFilled = email
      ? await page.locator(email.selector).first().fill(creds.email, { timeout: 5000 }).then(() => true).catch(() => false)
      : false;
    await awaitCaptchaResolution(page);
    const pwFilled = pw
      ? await page.locator(pw.selector).first().fill(creds.password, { timeout: 5000 }).then(() => true).catch(() => false)
      : false;
    if (!emailFilled && !pwFilled) {
      warn("Sign-up form has no email/password fields — nothing to fill.");
      return false;
    }
    await page.waitForTimeout(800);
    const submit = await findSignupSubmit(page, entrySelector);
    if (submit) {
      await page.locator(submit.selector).first().click({ timeout: 6000 }).catch(() => {});
    } else {
      await page.keyboard.press("Enter").catch(() => {});
    }
    await page.waitForTimeout(4000);
    await awaitCaptchaResolution(page);
    if (await detectCaptcha(page)) await awaitCaptchaResolution(page, CAPTCHA_WAIT_MS + 60_000);
    await page.waitForTimeout(2000);
    const authed = await isLoggedIn(page);
    if (authed) {
      ok("[agent] Account created and authenticated.");
      d.signup.push({ id: "signup-submit", action: "click", selector: submit?.selector, property: undefined });
    } else {
      warn("Account creation did not yield an authenticated session (email verification may be required).");
    }
    return authed;
  } catch (err) {
    warn(`Sign-up attempt error: ${err.message}`);
    return false;
  }
}

/**
 * Sometimes login is CAPTCHA/2FA-protected (Behance uses Adobe ID), which can't
 * be automated. If the browser is visible, give the user time to finish logging
 * in manually, then detect the logged-in state.
 */
async function isLoggedIn(page) {
  const url = page.url ? page.url() : "";
  if (/auth\.services\.adobe|adobelogin|accounts\.google\.com|google\.com\/signin|google\.com\/sorry|accounts\.google/i.test(url)) return false;
  const loggedIn = await page.evaluate(() => {
    const visible = (e) => {
      if (!e) return false;
      const r = e.getBoundingClientRect();
      const c = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && c.display !== "none" && c.visibility !== "hidden";
    };
    // Any visible auth control ("Log In"/"Sign In"/"Sign Up") means NOT logged in.
    const authLinkVisible = [...document.querySelectorAll(
      'a[href*="login"i], a[href*="signin"i], a[href*="sign-in"i], a[href*="log-in"i], a[href*="create-account"i], button[aria-label*="Log In"i], button[aria-label*="Sign In"i], a[aria-label*="Log In"i], a[aria-label*="Sign In"i], button[aria-label*="Sign Up"i], a[aria-label*="Sign Up"i]'
    )].some(visible);
    // POSITIVE signal only: ANY avatar / profile chip must be VISIBLE (iterate
    // all matches — the first in DOM can be a hidden sprite, which is why the
    // old single-querySelector check falsely reported logged-out).
    const avatarVisible = [...document.querySelectorAll(
      '[data-testid="header-profile-photo"], [class*="profile-photo" i], [class*="avatar" i], img[alt*="profile" i], button[aria-label*="profile" i], [role="button"][aria-label*="account" i], a[aria-label*="profile" i]'
    )].some(visible);
    if (avatarVisible) return true;
    // Behance headers currently render the logged-in account as a TEXT chip
    // with no image alt ("<name>'s profile") — detect that too, but only when
    // no visible login control contradicts it.
    if (!authLinkVisible) {
      const chip = [...document.querySelectorAll("a, button, [role=button], [role=link]")].find((e) => {
        if (!visible(e)) return false;
        const label = ((e.getAttribute("aria-label") || "") + " " + (e.textContent || ""))
          .replace(/\s+/g, " ")
          .trim();
        return /(profile\w*)$/i.test(label) && /(mine|my|\u2019s|'s)/i.test(label);
      });
      if (chip) return true;
    }
    if (authLinkVisible) return false;
    // No positive proof -> NOT logged in. Never guess from absence alone, or
    // the manual-login wait would "complete" before the user signs in.
    return false;
  }).catch(() => false);
  return loggedIn;
}

async function manualLoginTakeover(page) {
  // Re-check the LIVE env (config is a snapshot taken before .env loads, so
  // AUTOMATOR_HEADLESS=0 from .env or the shell must win). Only bail when the
  // env EXPLICITLY forces headless.
  const effHeadless = process.env.AUTOMATOR_HEADLESS === "1" || process.env.AUTOMATOR_HEADLESS === "true";
  if (effHeadless) {
    warn(`Manual login needs a visible window — run with AUTOMATOR_HEADLESS=0.`);
    return false;
  }
  const waitMs = Number(process.env.AUTOMATOR_LOGIN_WAIT_MS || 600_000);
  const deadline = Date.now() + waitMs;
  warn(`Automated login was not successful. The browser is now open — finish logging in manually `);
  warn(`(${page.url()}). If a CAPTCHA/“I'm not a robot” shows up, solve it and the agent resumes automatically. `);
  warn(`Waiting up to ${Math.round(waitMs / 1000)}s for your login... (skip with AUTOMATOR_HEADLESS=1)`);
  while (Date.now() < deadline) {
    if (isStopRequested()) return false;
    if (await isLoggedIn(page)) return true;
    await awaitCaptchaResolution(page);
    try {
      await page.waitForTimeout(3000);
    } catch {
      if (isStopRequested()) return false; // browser closed by Ctrl+C
      throw new Error("Manual login wait failed", { cause: null });
    }
  }
  warn("Manual login timed out.");
  return false;
}

async function findButton(page, texts) {
  const buttons = await page.evaluate(collectButtons);
  for (const text of texts) {
    const hit = buttons.find((b) => b.text && b.text.toLowerCase().includes(text));
    if (hit) return hit;
  }
  // Fall back to press Enter on the last input.
  return null;
}

// ---------------------------------------------------------------------------
// Create entry point
// ---------------------------------------------------------------------------
async function findCreateEntryPoint(d, page) {
  const scan = async () => {
    const buttons = await page.evaluate(collectButtons);
    const links = await page.evaluate(collectLinks).catch(() => []);
    return [...buttons, ...links].map((el) => {
      const hay = `${el.text || ""} ${el.label || ""}`.toLowerCase();
      let score = 0;
      if (/\b(create project|start a project|new project|new post|create a design|upload a project|upload your work|add project|create a moodboard|share your work|share work|post a project)\b/.test(hay)) score = 6;
      else if (/\b(upload|publish post|write post|contribute|compose|upload a project|share)\b/.test(hay)) score = 4;
      else if (/^\s*\+?\s*create\b/.test(hay)) score = 3;
      else if (/create|new project|publish/.test(hay)) score = 1;
      return { ...el, score, hay };
    });
  };

  const pickBest = (list, excludeSet) =>
    list
      .filter((el) => el.score >= 3 && el.visible !== false && !excludeSet.has(el.selector))
      .sort((a, b) => b.score - a.score)[0] || null;

  const clicked = new Set();
  for (let stage = 0; stage < 3; stage++) {
    const scored = await scan();
    const target = pickBest(scored, clicked);
    if (!target) break;
    clicked.add(target.selector);
    d.steps.push({ id: `open-create-${stage}`, action: "click", selector: target.selector, text: target.text, waitAfter: 5000 });
    try {
      const loc = target.selector ? page.locator(target.selector).first() : page.getByText(target.text, { exact: true }).first();
      await loc.click({ timeout: 8000 }).catch(async () => {
        if (target.label) await page.click(`button[aria-label="${target.label}"]`).catch(() => {});
      });
    } catch (err) {
      warn(`Could not click create entry (${target.text}): ${err.message}`);
    }
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1500);
      if (await isOnEditor(page)) {
        d.visitedUrls.add(page.url());
        return true;
      }
    }
  }

  d.visitedUrls.add(page.url());
  if (await isOnEditor(page)) return true;

  // Nothing auto-detectable: in a visible browser, let the user click Create manually.
  if (await manualCreateTakeover(page)) {
    d.missing.push("create button clicked manually by user");
    return true;
  }

  warn("No obvious create/project entry found.");
  d.missing.push("no create entry found");
  return false;
}

async function isOnEditor(page) {
  const info = await page
    .evaluate(() => {
      const hasFields = !!document.querySelector('textarea, input[type="file"], [contenteditable="true"], [contenteditable=""]');
      const url = location.href;
      return {
        editorUrl: /upload|create|draft|editor|project|moodboard|wip/i.test(url),
        hasFields,
        url,
      };
    })
    .catch(() => ({ editorUrl: false, hasFields: false, url: "" }));
  return info.editorUrl || info.hasFields;
}

/**
 * Behance's "+ Create" control may be a small icon/aria-labelled node the
 * generic scanner misses. In a visible browser, give the user a moment to
 * click Add a Project / Create Project themselves, then detect the editor.
 */
async function manualCreateTakeover(page) {
  if (config.browser.headless) return false;
  const waitMs = Number(process.env.AUTOMATOR_CREATE_WAIT_MS || 90_000);
  warn("Couldn't find the create button automatically. Click 'Add a Project' / 'Create Project' ");
  warn("in the browser window yourself. Waiting up to ~90s for the editor to open...");
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isOnEditor(page)) return true;
    await page.waitForTimeout(2000);
  }
  warn("Manual create step timed out.");
  return false;
}

// ---------------------------------------------------------------------------
// Editor field discovery
// ---------------------------------------------------------------------------
async function discoverEditorFields(d, page) {
  await page.waitForTimeout(2000);
  let inputs = await page.evaluate(collectInputs);
  let buttons = await page.evaluate(collectButtons);
  d.inputsSeen = inputs;
  d.buttonsSeen = buttons;
  d.fieldCandidates = classifyFields(inputs);
  d.linksSeen = await page.evaluate(collectLinks).catch(() => []);
  console.log(`[agent] Editor: ${inputs.length} form controls, ${buttons.length} buttons.`);

  const probeFileInput = () =>
    page.evaluate(() => {
      const el = document.querySelector('input[type="file"]');
      return el ? "input[type=file]" : null;
    });

  // --- Document-body sites --------------------------------------------------
  // Some directories don't take the blog body as pasted text at all — the
  // content is an uploaded document (e.g. .docx/.ppt/.pdf/.txt file input).
  // Detect those EARLY so the file input maps to "bodyDocument" (the engine
  // renders/retrieves a document at runtime) instead of being mislabeled as a
  // cover image. A short description textarea beside it does NOT make the body
  // "text" — it stays "document" mode with the textarea for the description.
  const docSignals = /doc|pdf|ppt|presentation|text.*file|attach.*file|upload.*(doc|file)|document|article|blog/i;
  const docFile = (inputs || []).find(
    (f) => f.type === "file" && docSignals.test([f.accept, f.name, f.ariaLabel, f.label, f.id, f.placeholder].filter(Boolean).join(" "))
  );
  if (docFile) {
    ok("[agent] Document-upload body detected — the blog content will be uploaded as a .docx/.txt.");
    d.steps.push({ id: "upload-body-document", action: "upload", selector: docFile.selector, property: "bodyDocument", waitAfter: 4000 });
    d.missing.push("document-upload body — no editable text body expected");
  }

  // --- Cover image block ----------------------------------------------------
  const otherFileInput = (inputs || []).find((f) => f.type === "file" && f.selector !== docFile?.selector);
  const fileInput = docFile ? otherFileInput : inputs.find((f) => f.type === "file");
  const imageBlock =
    buttons.find((b) => /^(image|add image|photo|add photo|images)$/i.test((b.text || "").trim())) ||
    buttons.find((b) => /^image$/i.test((b.label || "").trim()));

  if (fileInput) {
    d.steps.push({ id: "upload-cover", action: "upload", selector: fileInput.selector, property: "image", waitAfter: 9000 });
  } else if (imageBlock) {
    d.steps.push({ id: "open-image", action: "click", selector: imageBlock.selector, text: imageBlock.text, waitAfter: 3500 });
    await page.waitForTimeout(2500);
    const sel = await probeFileInput();
    if (sel) {
      d.steps.push({ id: "upload-cover", action: "upload", selector: sel, property: "image", waitAfter: 9000 });
    } else {
      warn("No file input after opening the Image block.");
      d.missing.push("no file input after opening image block");
    }
  } else {
    warn("No image block / file input detected on the editor.");
    d.missing.push("no cover upload found");
  }

  // --- Body text block -------------------------------------------------------
  const textBlock = buttons.find((b) => /^(text|add text|text block|body|write)$/i.test((b.text || "").trim()));
  let bodySel = null;
  if (textBlock) {
    d.steps.push({ id: "open-text", action: "click", selector: textBlock.selector, text: textBlock.text, waitAfter: 3000 });
    await page.waitForTimeout(2500);
    const after = await page.evaluate(collectInputs);
    const body =
      after.find((f) => /contenteditable|textbox/.test(f.tag + f.role + f.type)) ||
      after.find((f) => f.tag === "textarea");
    if (body) {
      bodySel = body.selector;
      ok("[agent] Body editor detected.");
    } else {
      warn("No body/contenteditable found after opening the Text block.");
      d.missing.push("no body editor after opening text block");
    }
  } else {
    const body =
      d.fieldCandidates.description?.[0] ||
      inputs.find((f) => f.tag === "textarea" || /contenteditable|textbox/.test(f.tag + f.role + f.type)) ||
      await (async () => {
        const sel = await page.evaluate(() => {
          const el = document.querySelector(
            'textarea:not([placeholder]), [contenteditable]:not([contenteditable="false"]), [role="textbox"], [data-slate-editor]'
          );
          return el ? "textarea:not([placeholder]), [contenteditable]:not([contenteditable=\"false\"]), [role=\"textbox\"]" : null;
        });
        return sel ? { selector: sel } : null;
      })();
    if (body) bodySel = body.selector;
    else d.missing.push("no body/text editor found");
  }
  if (bodySel) {
    d.steps.push({ id: "fill-description", action: "fill", selector: bodySel, property: "description", waitAfter: 500 });
  }

  // Backlink is typed at the end of the just-filled body, so it must come last
  // in this phase (focus is still inside the text block).
  if (bodySel) {
    d.steps.push({ id: "append-backlink", action: "type", property: "backlinkUrl", goToEnd: true, prefixNewline: true, waitAfter: 600 });
  }
}

function classifyFields(inputs) {
  const buckets = { title: [], description: [], category: [], tags: [], visibility: [], email: [], password: [] };
  const patterns = {
    title: ["title", "name", "project name", "heading", "subject"],
    description: ["description", "about", "story", "body", "content", "editor", "write", "details", "info"],
    category: ["category", "field", "discipline", "type", "industry", "domain"],
    tags: ["tag", "keyword", "label"],
    visibility: ["visibility", "permission", "audience", "private", "public"],
    email: ["email", "username", "e-mail", "mail"],
    password: ["password"],
  };
  for (const f of inputs) {
    const haystack = [f.name, f.placeholder, f.ariaLabel, f.label, f.id, f.type, f.dataPlaceholder]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!haystack) continue;
    for (const [field, words] of Object.entries(patterns)) {
      if (words.some((w) => haystack.includes(w))) {
        buckets[field].push(f);
      }
    }
  }
  // Prefer visible fields and avoid empty duplicates.
  for (const key of Object.keys(buckets)) {
    buckets[key].sort((a, b) => (b.visible ? 1 : 0) - (a.visible ? 1 : 0));
    buckets[key] = buckets[key].filter((f, i, arr) => arr.findIndex((x) => x.selector === f.selector) === i);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Publish dialog discovery (title / tags / visibility live in the dialog)
// ---------------------------------------------------------------------------
async function manualDialogTakeover(page) {
  const waitMs = Number(process.env.AUTOMATOR_DIALOG_WAIT_MS || 90_000);
  ok("MANUAL STEP: please open the Publish dialog in the browser (click Publish / Publishing settings).");
  warn(`Waiting up to ${Math.round(waitMs / 1000)}s for the title field…`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const open1 = await page.locator('input[aria-label*="title" i], input[placeholder*="title" i]').first().isVisible().catch(() => false);
    const open2 = await page.locator('[role="dialog"] textarea, [role="dialog"][aria-modal] input').first().isVisible().catch(() => false);
    if (open1 || open2) {
      ok("Publish dialog detected.");
      return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

async function discoverPublishModal(d, page) {
  const buttons = await page.evaluate(collectButtons);
  const publishBtn = buttons.find(
    (b) => /publish|save & publish|share/i.test(b.text || "") && !/draft/i.test(b.text || "")
  );
  if (publishBtn) {
    d.publishCandidates.push(publishBtn);
    d.steps.push({ id: "open-publish", action: "click", selector: publishBtn.selector, text: publishBtn.text, waitAfter: 3500 });
    ok(`[agent] Opening publish dialog (${(publishBtn.text || "").trim()})…`);
    // Behance's first Publish click usually auto-saves the draft, and the
    // dialog only opens on a subsequent click (or once the save completes).
    const loc = page.locator(publishBtn.selector).first();
    const titleOpen = () =>
      page.locator('input[aria-label*="title" i], input[placeholder*="title" i]').first().isVisible().catch(() => false);
    for (let attempt = 0; attempt < 5 && !(await titleOpen()); attempt++) {
      const saving = await page
        .locator('[role="dialog"]:has-text("Saving as Draft"), button:has-text("Saving...")')
        .first()
        .isVisible()
        .catch(() => false);
      if (!saving) await loc.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
    if (!(await titleOpen()) && !(await manualDialogTakeover(page))) {
      warn("Could not open the publish dialog during discovery.");
      d.missing.push("publish dialog did not open");
    }
  } else {
    warn("No publish button found on the editor.");
    d.missing.push("no publish button found");
    return;
  }

  // Scroll the dialog so below-the-fold fields (visibility, etc.) load/probe.
  await page.evaluate(() => {
    const m = document.querySelector('[role="dialog"], [aria-modal="true"]');
    if (m) m.scrollTop = m.scrollHeight;
  }).catch(() => {});
  await page.waitForTimeout(1200);

  const allInputs = await page.evaluate(collectInputs);
  const used = new Set(d.steps.map((s) => s.selector));
  const inputs = allInputs.filter((f) => !used.has(f.selector));
  const buckets = classifyFields(inputs);
  d.publishDialogInputs = inputs;
  const modalButtons = await page.evaluate(collectButtons);
  console.log(`[agent] Publish dialog: ${inputs.length} new form controls.`);

  // Title
  const title = buckets.title?.[0];
  if (title) {
    ok("[agent] Title field mapped.");
    d.steps.push({ id: "fill-title", action: "fill", selector: title.selector, property: "title", waitAfter: 400 });
  } else {
    d.missing.push("no title field in publish dialog");
  }

  // Short description (the full blog body lives in the Text block, so the
  // publish dialog's description field maps to the "shortDescription" input).
  const shortDesc = buckets.description?.[0];
  if (shortDesc) {
    ok("[agent] Short description field mapped.");
    d.steps.push({ id: "fill-modal-description", action: "fill", selector: shortDesc.selector, property: "shortDescription", waitAfter: 400 });
  }

  // Tags
  const tags = buckets.tags?.[0];
  if (tags) {
    ok("[agent] Tags field mapped.");
    d.steps.push({ id: "fill-tags", action: "fill", selector: tags.selector, property: "tags", waitAfter: 400 });
  } else {
    d.missing.push("no tags field in publish dialog");
  }

  // Visibility — Behance uses radio chips (Public / Private / Visible to everyone)
  const vis = buckets.visibility?.[0];
  if (vis && vis.tag === "select") {
    d.steps.push({ id: "toggle-visibility", action: "select", selector: vis.selector, property: "visibility" });
  } else {
    const radios = inputs.filter((f) => f.type === "radio");
    const pub = radios.find((f) => /public|visible to everyone|anyone can (see|view)|who can see/i.test([f.label, f.ariaLabel, f.name].join(" ")));
    if (pub) {
      ok("[agent] Visibility (radio) mapped.");
      d.steps.push({ id: "toggle-visibility", action: "click", selector: pub.selector, property: "visibility" });
    } else {
      const visChip = modalButtons.find((b) => /public|private|visible to everyone|anyone can (see|view)/i.test(b.text || ""));
      if (visChip && !vis) {
        ok("[agent] Visibility (chip) mapped.");
        d.steps.push({ id: "toggle-visibility", action: "click", selector: visChip.selector, text: visChip.text, property: "visibility" });
      } else if (!vis) {
        d.missing.push("no visibility control in publish dialog");
      }
    }
  }

  // Final confirm button (a second "Publish" that lives inside the dialog)
  const confirm = modalButtons.find(
    (b) => /^(publish|publish now|share|post)$/i.test((b.text || "").trim()) && b.selector !== publishBtn.selector
  );
  if (confirm) {
    ok("[agent] Confirm-publish button mapped.");
    d.steps.push({ id: "submit-post", action: "click", selector: confirm.selector, text: confirm.text, waitAfter: 9000 });
  }

  d.urlPatterns = await detectProfilePattern(page).catch(() => ["https://www.behance.net/gallery/*"]);
}

async function detectProfilePattern(page) {
  const url = page.url();
  const patterns = [];
  if (/gallery\//i.test(url)) patterns.push(url.split("/").slice(0, 5).join("/") + "/*");
  else patterns.push("https://www.behance.net/gallery/*");
  return patterns;
}

// ---------------------------------------------------------------------------
// Workflow assembly
// ---------------------------------------------------------------------------
function buildWorkflow(d, { siteUrl, siteName }, opts = {}) {
  const steps = [];
  for (const s of d.steps) {
    if (s.stepType === "login" || s.stepType === "signup") continue; // auth recorded separately
    const step = { id: s.id, action: s.action };
    if (s.selector) step.selector = s.selector;
    if (s.text) step.text = s.text;
    if (s.property) step.property = s.property;
    if (s.url) step.url = s.url;
    if (s.waitAfter) step.waitAfter = s.waitAfter;
    steps.push(step);
  }

  const fieldMappings = {};
  const mapField = (ids) => {
    for (const id of ids) {
      const step = steps.find((s) => s.id === id);
      if (step) {
        fieldMappings[step.property] = id;
        break;
      }
    }
  };
  for (const [prop, prefixes] of Object.entries({
    title: ["fill-title"],
    description: ["fill-description"],
    category: ["select-category"],
    tags: ["fill-tags"],
    visibility: ["toggle-visibility"],
  })) {
    mapField(prefixes);
  }
  const upload = steps.find((s) => s.action === "upload");
  if (upload) fieldMappings.image = upload.id;
  mapField(["append-backlink"]);

  const status = setStatus();
  const blocker = opts.partialContext ? { blocked: true, reason: opts.partialContext } : undefined;

  function setStatus() {
    if (opts.partialContext) return "partial";
    if (d.authRequired && !d.inputsSeen.length) return "partial";
    return d.missing?.length ? "needs-review" : "complete";
  }

  // Input configuration: how each site wants the blog content. Derived from
  // what discovery actually observed — a contenteditable/textarea body means
  // plain text; a document file-upload body means a document. Never hard-coded
  // per site; the collector reads this to choose its input form.
  const contentMode = d.steps.some((s) => s.property === "bodyDocument") ? "document" : "text";

  return {
    meta: {
      siteName: siteName || "Behance",
      siteUrl,
      siteKey: workflowKey(siteUrl),
      tool: "behance-backlink-automator",
      toolVersion: "1.0.0",
      generatedBy: "browser-agent",
      discoveredAt: new Date().toISOString(),
      discoveryUrls: [...d.visitedUrls],
    },
    auth: {
      required: d.authRequired,
      loginSteps: d.login.map((s) => ({ id: s.id, action: s.action, selector: s.selector, property: s.property })),
      signupSteps: d.signup.map((s) => ({ id: s.id, action: s.action, selector: s.selector, property: s.property })),
    },
    inputs: {
      content: { mode: contentMode },
    },
    steps,
    fieldMappings,
    publish: {
      submitStepIds: steps.filter((s) => s.action === "click" && /publish|submit|post/.test(s.text || "")).map((s) => s.id),
    },
    verification: {
      successSelectors: ["[data-testid='confirmation']", "[class*='success']", "[aria-label*='close']"],
      urlPatterns: d.urlPatterns || ["https://www.behance.net/gallery/*"],
      timeoutMs: 60_000,
    },
    cap: {
      supportsDescription: !!fieldMappings.description,
      supportsTags: !!fieldMappings.tags,
      supportsCategory: !!fieldMappings.category,
      supportsVisibility: !!fieldMappings.visibility,
      requiresImage: !!upload,
    },
    status,
    blocker,
    missing: d.missing || [],
    notes: d.metadataHints || "",
  };
}

// ---------------------------------------------------------------------------
// Best-effort validation: confirm key selectors still match in a live browser
// ---------------------------------------------------------------------------
async function validateAndPatch(d, workflow, page) {
  logSection("Workflow Validation (best-effort)");
  let okCount = 0;
  const problems = [];
  for (const step of workflow.steps) {
    if (!step.selector || !["fill", "select", "upload", "click", "check"].includes(step.action)) continue;
    const res = await page.evaluate((sel) => {
      try {
        const el = document.querySelector(sel);
        return { present: !!el, visible: !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)) };
      } catch {
        return { present: false, error: "invalid selector" };
      }
    }, step.selector);
    if (res.present) {
      okCount++;
      ok(`selector ok   -> ${step.id}  ${step.selector}`);
    } else {
      problems.push(`missing selector -> ${step.id}  ${step.selector}`);
    }
  }
  for (const p of problems) warn(p);
  if (!okCount) warn("No selectors could be validated on the current page state.");
  workflow.validation = {
    ranAt: new Date().toISOString(),
    ok: problems.length === 0 ? "pass" : "attention",
    checked: okCount,
    problems,
  };
  const valid = isValidWorkflow(workflow);
  ok(`schema valid: ${valid ? "yes" : "no"}`);
}

// ---------------------------------------------------------------------------
// Human readable summary
// ---------------------------------------------------------------------------
function summarizeWorkflow(w) {
  const lines = [
    "Workflow summary:",
    `  Site      : ${w.meta.siteName} (${w.meta.siteUrl})`,
    `  Status    : ${w.status}`,
    `  Auth      : ${w.auth.required ? "required (login steps recorded)" : "not required"}`,
    `  Steps     : ${w.steps.length}`,
  ];
  for (const s of w.steps) {
    const sel = s.selector ? ` [${s.selector}]` : s.text ? ` (${s.text.slice(0, 40)})` : "";
    lines.push(`    - ${s.id.padEnd(20)} ${s.action}${sel}`);
  }
  lines.push(`  Field map : ${JSON.stringify(w.fieldMappings, null, 2).replace(/\n/g, "\n    ")}`);
  if (w.missing?.length) {
    lines.push("  Missing   :");
    for (const m of w.missing) lines.push(`    - ${m}`);
  }
  return lines.join("\n");
}

/**
 * Ensure the current page is logged in as `email` — shared by the orchestrator
 * (npm start, fresh-login path) and run.live.behance. Behance/Adobe login:
 * find the sign-in entry, auto-fill email + password, handle CAPTCHA, then wait
 * for the user to finish manually if automation can't complete it. Persists the
 * fresh session + account record on success.
 */
export async function ensureLoggedIn({ page, context, email, password, siteName = "behance" } = {}) {
  await page.goto("https://www.behance.net/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(3000);
  if (await isLoggedIn(page)) { ok("Already logged in."); return; }
  warn("Not logged in — signing into Behance (Adobe)…");

  // AUTO-LOGIN is the default: the agent types email + password itself.
  // Only AUTOMATOR_MANUAL_LOGIN=1 switches to "user logs in by hand".
  const manualLoginOnly = process.env.AUTOMATOR_MANUAL_LOGIN === "1";
  if (manualLoginOnly) {
    warn("Login is yours: sign in yourself in the browser (Sign In -> email -> password -> any confirmation code). The agent will NOT type credentials — it waits and runs the workflow once you are in. The window STAYS OPEN (no timeout, no auto-close); press Ctrl+C to abort.");
    // NO deadline: never close the window "before sign in". Poll until the
    // user actually completes the login (or explicitly aborts with Ctrl+C).
    while (!isStopRequested()) {
      const pages = [page, ...(context?.pages ? Array.from(context.pages()) : [])];
      let signedIn = false;
      for (const p of pages) {
        if (await isLoggedIn(p).catch(() => false)) { signedIn = true; break; }
      }
      if (signedIn) break;
      await page.waitForTimeout(2000).catch(() => {});
    }
    if (!(await isLoggedIn(page).catch(() => false))) return; // aborted by user
    ok("Logged in.");
    await persistSession(context, { email, siteName }).catch(() => {});
    return;
  }

  // 1. Reach the Adobe sign-in page. Behance re-skins its header often, so
  //    don't guess CSS selectors — scan for a VISIBLE control whose text/href
  //    matches sign-in and click it natively.
  //    auth.services.adobe.com). Verify we actually LEFT behance.net each try.
  const clickVisibleSignIn = () =>
    page
      .evaluate(() => {
        const vis = (e) => {
          const r = e.getBoundingClientRect();
          const c = getComputedStyle(e);
          return r.width > 0 && r.height > 0 && c.display !== "none" && c.visibility !== "hidden";
        };
        const ok = (e) => e.offsetWidth && e.offsetHeight && vis(e);
        const byText = [...document.querySelectorAll("a, button")].filter(ok).find((e) => {
          const t = (e.textContent || "").replace(/\s+/g, " ").trim();
          const href = e.getAttribute("href") || "";
          return /^\s*(sign ?in|log ?in)\s*$/i.test(t) || /sign ?in|log ?in/i.test(e.getAttribute("aria-label") || "") || /auth\.services\.adobe|adobelogin|sso/i.test(href);
        });
        if (byText) { byText.click(); return true; }
        return false;
      })
      .catch(() => false);

  let moved = false;
  for (let i = 0; i < 5 && !moved; i++) {
    if (await clickVisibleSignIn()) {
      await page.waitForTimeout(3500);
      const allOpen = context?.pages ? Array.from(context.pages()) : [page];
      moved = allOpen.some((p) => /auth\.services\.adobe|adobelogin|accounts\.google\.com/i.test(p.url()));
    } else {
      await page.waitForTimeout(1500);
    }
  }
  if (moved) {
    ok("Reached the Adobe sign-in page.");
  } else {
    warn("Could not auto-reach the Adobe sign-in page — if a browser window is visible, click “Sign In”/“Continue with Google” yourself there, then I'll pick up from the Google page.");
  }

  // 2. Sign-in channel. Prefer "Continue with Google" when the Adobe page
  //    renders it — the user's Behance identity is a Gmail account, and the
  //    social flow usually has a lighter CAPTCHA gate than Adobe's password
  //    screen. Otherwise use Adobe email+password. Either way, FOLLOW the
  //    auth TRANSITIONS (email → password) across Adobe OR Google surfaces:
  //    the page can swap fields, spawn a popup, or show an account picker.
  const isLoginPage = (pg) => /auth\.services\.adobe|adobelogin|accounts\.google\.com/i.test(pg.url());

  // Only interact with a field that is genuinely VISIBLE on screen. Google
  // keeps hidden <input type=email> elements on its password page — acting on
  // them types into whatever is actually focused (the password box). Guarding
  // every branch with this prevents email ever landing in the password field.
  const locVisible = async (loc) => {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) return false;
    return el
      .evaluate((e) => {
        const r = e.getBoundingClientRect();
        const c = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && c.display !== "none" && c.visibility !== "hidden";
      })
      .catch(() => false);
  };

  // Anti-automation login forms reject programmatic .fill(). Type with REAL
  // key events, then VERIFY the box contains EXACTLY the intended string
  // (e.g. always "speedbotsseo@gmail.com", never a mangled variant). On any
  // mismatch the field is cleared and the text retyped (up to 4 attempts),
  // so a mangled/auto-completed value can never reach the browser silently.
  async function typeExact(pg, locator, text) {
    const el = locator.first();
    if (!(await locVisible(locator))) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      await el.click({ timeout: 5000 }).catch(() => {});
      await pg.waitForTimeout(300);
      await pg.keyboard.press("Control+A").catch(() => {});
      await pg.keyboard.press("Backspace").catch(() => {});
      await pg.waitForTimeout(150);
      try {
        await pg.keyboard.type(text, { delay: 45 });
      } catch {
        await el.fill(text).catch(() => {});
      }
      await pg.waitForTimeout(250);
      const v = await el.inputValue().catch(() => "");
      if (v === text) return true;
      warn(`Type check: box="${v.slice(0, 24)}" expected="${text.slice(0, 24)}" — clearing and retyping (try ${attempt + 1}/4).`);
    }
    return false;
  }

  const fillEmail = async (pg) => {
    if (!isLoginPage(pg)) return false; // never touch newsletter/contact boxes on the public site
    const box = pg
      .locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[id="identifierId"], input[autocomplete="username"]')
      .first();
    if (!(await box.count().catch(() => 0))) return false;
    return await typeExact(pg, box, email);
  };

  let googleRoute = false;
  const googleChosen = await page
    .evaluate(() => {
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        const c = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && c.display !== "none" && c.visibility !== "hidden";
      };
      const el = [...document.querySelectorAll("button, a, [role=button]")].find((e) =>
        visible(e) && /continue with google|google/i.test((e.getAttribute("aria-label") || "") + " " + (e.textContent || "").replace(/\s+/g, " ").trim())
      );
      if (!el) return false;
      el.setAttribute("data-automator-google", "hit");
      return true;
    })
    .catch(() => false);
  if (googleChosen) {
    // Spec: "enter an email id" first — type it into the Adobe/Behance sign-in
    // email box BEFORE clicking Continue with Google (Google then goes straight
    // to its password step for that account).
    const adobeEmail = page
      .locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="username"]')
      .first();
    if (await locVisible(adobeEmail)) {
      if (await typeExact(page, adobeEmail, email)) ok("Email id entered in the sign-in box.");
    }
    ok("Found “Continue with Google” — clicking it now (skipping Adobe email/password).");
    await page.locator('[data-automator-google="hit"]').first().click({ timeout: 8000 }).catch(() => {});
    googleRoute = true;
  } else {
    await page.waitForTimeout(2000);
  }
  if (!googleRoute) {
    warn("Google button not visible yet on this page — retrying for a few seconds before falling back.");
    for (let i = 0; i < 8 && !googleRoute; i++) {
      const again = await page
        .evaluate(() => {
          const visible = (e) => {
            const r = e.getBoundingClientRect();
            const c = getComputedStyle(e);
            return r.width > 0 && r.height > 0 && c.display !== "none" && c.visibility !== "hidden";
          };
          const el = [...document.querySelectorAll("button, a, [role=button]")].find((e) =>
            visible(e) && /continue with google|google/i.test((e.getAttribute("aria-label") || "") + " " + (e.textContent || "").replace(/\s+/g, " ").trim())
          );
          if (!el) return false;
          el.setAttribute("data-automator-google", "hit");
          return true;
        })
        .catch(() => false);
      if (again) {
        ok("Found “Continue with Google” — clicking it now.");
        await page.locator('[data-automator-google="hit"]').first().click({ timeout: 8000 }).catch(() => {});
        googleRoute = true;
      } else {
        await page.waitForTimeout(2000);
      }
    }
  }
  if (!googleRoute) warn("No Google button on this page variant — falling back to Adobe email+password.");

  const isGoogle = (p) => /accounts\.google\.com|google\.com\/signin/i.test(p.url());

  if (googleRoute) {
    // Google OAuth flow ONLY — no Adobe email/password. Phases:
    //   A) account chooser — click the row for speedbotsseo@gmail.com;
    //   B) email NOT in the list or clicking stalls → "Use another account",
    //      type the email, click Next;
    //   C) Google password page — the AGENT types Speedbots@2025 exactly
    //      (case-sensitive), then Enter.
    const gFrames = () => {
      // Google can render in a POPUP tab, the SAME tab, or an IFRAME inside the
      // Adobe page — scan every frame of every open page, not just page URLs.
      const roots = [page, ...(context?.pages ? Array.from(context.pages()) : [])];
      const out = [];
      for (const r of roots) {
        for (const f of r.frames()) {
          if (/accounts\.google\.com|google\.com\/signin|ssl\.gstatic/i.test(f.url())) out.push({ fr: f, root: r });
        }
      }
      return out;
    };
    const pwDeadline = Date.now() + Number(process.env.AUTOMATOR_GOOGLE_STEP_WAIT_MS || 150_000);
    let pwDone = false;
    let challengeNoted = false;
    let interstitialNoted = false;
    let triedOtherAccount = false;
    let probed = false;
    const bailToOtherAccountAt = Date.now() + 9000;
    while (Date.now() < pwDeadline && !pwDone) {
      const targets = gFrames();
      if (!probed) {
        probed = true;
        if (!targets.length) {
          const urls = [page, ...(context?.pages ? Array.from(context.pages()) : [])].map((p) => p.url().slice(0, 80));
          warn("No Google frame found yet (open: " + JSON.stringify(urls) + ") — Google may still be spinning up; retrying…");
        }
      }
      let handled = false;
      for (const { fr, root } of targets) {
        // identifier page ("Enter your email or phone"): type the EMAIL FIRST —
        // never the password. Only proceed to the password branch once Google
        // has moved past the email step. The email branch must ONLY run when a
        // VISIBLE password box is absent (Google keeps a hidden email input on
        // its password page; typing there leaks the email into the password box).
        const nextpg = fr.locator('#identifierNext').first();
        const boxpg = fr.locator('input[id="identifierId"], input[name="email"], input[type="email"]').first();
        const anyPwNow = fr.locator('input[type="password"], input[id="Passwd"]').first();
        if (await nextpg.count().catch(() => 0)
            && !(await locVisible(anyPwNow))
            && await locVisible(boxpg)) {
          if (await typeExact(root, boxpg, email)) {
            ok(`Google email typed (${email}).`);
          }
          await nextpg.click({ timeout: 5000 }).catch(() => {});
          await root.waitForTimeout(2500);
          handled = true;
          break;
        }
        // C) password page — only type when the password box is VISIBLE and any
        // remaining email box is hidden (guards against email->password leaks).
        const pwpg = fr.locator('input[type="password"], input[autocomplete="current-password"], input[id="Passwd"]').first();
        if (await locVisible(pwpg)) {
          if (await typeExact(root, pwpg, password)) {
            pwDone = true;
            ok("Google password auto-filled.");
            await root.keyboard.press("Enter").catch(() => {});
            await root.waitForTimeout(3500);
          }
          handled = true;
          break;
        }
        // A) account chooser row — DOM click (Google's row responds to it) + mouse fallback.
        const knownpg = fr.locator(`div[data-identifier="${email}"], [data-email="${email}"], li:has-text("${email}")`).first();
        if (await knownpg.count().catch(() => 0) && !triedOtherAccount) {
          ok("Choosing your Google account.");
          await knownpg.evaluate((el) => { const link = el.closest("div[data-identifier], li, [role=listbox] li") || el; (link.querySelector("a, [role=link], [data-value]") || link).click(); }).catch(() => {});
          await knownpg.click({ timeout: 4000 }).catch(() => {});
          await root.waitForTimeout(2500);
          handled = true;
          break;
        }
        // B) chooser present but our email missing (or stalled) — type it.
        const chooser = fr.locator('ul[role="listbox"], [role="listbox"] li, [data-value]').first();
        if (await chooser.count().catch(() => 0)) {
          if (Date.now() > bailToOtherAccountAt || !triedOtherAccount) {
            const otherpg = fr.locator('#identifierLink, text=Use another account, [data-testid*="identifierLink"]').first();
            if (await otherpg.count().catch(() => 0)) {
              ok("Email not in the account list — typing it manually.");
              await otherpg.click({ timeout: 5000 }).catch(() => {});
              triedOtherAccount = true;
              await root.waitForTimeout(2500);
              handled = true;
              break;
            }
          }
        }
        const needs2fa = await fr.evaluate(() => /Verify it.s you|Enter the code|Confirm you.re not a robot|verification code|Two\s*[- ]*Step|Enter the email address or phone/i.test(((document.body || {}).innerText || "").slice(0, 6000))).catch(() => false);
        const onGoogleFrame = /accounts\.google\.com|google\.com\/signin/i.test(fr.url());
        if ((needs2fa || onGoogleFrame) && !challengeNoted) {
          challengeNoted = true;
          warn("Google is verifying this device — check the email inbox for speedbotsseo@gmail.com and click the number/link there. The agent keeps watching and finishes automatically.");
        }
      }
      if (!handled && !pwDone) {
        if (!interstitialNoted && !(await isLoggedIn(page))) {
          interstitialNoted = true;
          warn("Waiting on a Google interstitial — I keep scanning for the password page so I can type it the moment it appears.");
        }
        await page.waitForTimeout(1200);
      }
    }
    if (!pwDone && !(await isLoggedIn(page))) warn("Google login needs your help — click the confirmation code in the email inbox (speedbotsseo@gmail.com), then I'll finish automatically.");
  } else {
    // NO Adobe email/password form, ever. The user wants: Behance -> Sign In ->
    // "Continue with Google" -> Gmail id + password. If the button wasn't
    // visible on first scan (Ahze/A-B variants), keep polling for it; once it
    // appears, click it and run the Google flow. If it never appears, wait for
    // the user to click it in the window — we never type Adobe credentials.
    warn("Looking for the “Continue with Google” button on the Adobe login page (no Adobe email/password will be used).");
    const gDeadline = Date.now() + Number(process.env.AUTOMATOR_GOOGLE_STEP_WAIT_MS || 90_000);
    let clicked = false;
    while (Date.now() < gDeadline && !clicked) {
      const pages = [page, ...(context?.pages ? Array.from(context.pages()) : [])];
      for (const pg of pages) {
        const btn = pg
          .locator('button:has-text("Continue with Google"), a:has-text("Continue with Google"), [role="button"]:has-text("Continue with Google"), button:has-text("Continue with Google"), [aria-label*="Contin" i][aria-label*="Google" i]')
          .first();
        if (await btn.count().catch(() => 0)) {
          ok("“Continue with Google” found — clicking it.");
          await btn.click({ timeout: 5000 }).catch(() => {});
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        if (!isStopRequested()) await page.waitForTimeout(1500).catch(() => {});
      }
    }
    googleRoute = clicked;
    if (!clicked) {
      warn("“Continue with Google” did not appear — click it in the browser window; I will keep waiting.");
      while (!isStopRequested() && !clicked) {
        for (const pg of [page, ...(context?.pages ? Array.from(context.pages()) : [])]) {
          const btn = pg.locator('button:has-text("Continue with Google"), a:has-text("Continue with Google")').first();
          if (await btn.count().catch(() => 0)) { await btn.click({ timeout: 5000 }).catch(() => {}); clicked = true; break; }
        }
        if (!clicked) await page.waitForTimeout(2000).catch(() => {});
      }
      googleRoute = clicked;
    }
    if (googleRoute) {
      // Run the Google OAuth flow (email -> password) once the button is clicked.
      const gFrames2 = () => {
        const roots = [page, ...(context?.pages ? Array.from(context.pages()) : [])];
        const out = [];
        for (const r of roots) {
          for (const f of r.frames()) {
            if (/accounts\.google\.com|google\.com\/signin|ssl\.gstatic/i.test(f.url())) out.push({ fr: f, root: r });
          }
        }
        return out;
      };
      const done = await (async () => {
        const deadline2 = Date.now() + Number(process.env.AUTOMATOR_GOOGLE_STEP_WAIT_MS || 150_000);
        while (Date.now() < deadline2 && !(await isLoggedIn(page).catch(() => false))) {
          let acted = false;
          for (const { fr, root } of gFrames2()) {
            const idn = fr.locator('input[id="identifierId"], input[name="email"], input[type="email"]').first();
            const next = fr.locator('#identifierNext').first();
            const anyPwNow = fr.locator('input[type="password"], input[id="Passwd"]').first();
            if (await next.count().catch(() => 0)
                && !(await locVisible(anyPwNow))
                && await locVisible(idn)) {
              if (await typeExact(root, idn, email)) ok(`Google email typed (${email}).`);
              await next.click({ timeout: 5000 }).catch(() => {});
              await root.waitForTimeout(2500).catch(() => {});
              acted = true;
              break;
            }
            const pw = fr.locator('input[type="password"], input[id="Passwd"]').first();
            if (await locVisible(pw)) {
              if (await typeExact(root, pw, password)) {
                ok("Google password auto-filled.");
                await root.keyboard.press("Enter").catch(() => {});
                await root.waitForTimeout(3500).catch(() => {});
              }
              acted = true;
              break;
            }
          }
          if (!acted) await page.waitForTimeout(1200).catch(() => {});
        }
        return true;
      })();
      if (!(await isLoggedIn(page).catch(() => false))) {
        warn(`Google emailed a confirmation code to ${email} — open that inbox, click the number, and Behance loads automatically. The window stays open; I keep watching. (Ctrl+C to abort.)`);
        let codeWarned = false;
        let lastRaise = 0;
        while (!isStopRequested() && !(await isLoggedIn(page).catch(() => false))) {
          if (!codeWarned) {
            for (const fr of page.frames()) {
              const code = fr
                .locator('input[inputmode="numeric"], input[type="tel"], input[autocomplete="one-time-code"], input[aria-label*="code" i], input[maxlength="6"]')
                .first();
              if (await locVisible(code)) {
                warn("Google is showing a one-time-code box IN THIS WINDOW — type the number it emailed to you into that box.");
                codeWarned = true;
                break;
              }
            }
          }
          if (Date.now() - lastRaise > 6000) {
            lastRaise = Date.now();
            const active = await page
              .evaluate(() => (window.__auto_activity__ ? Date.now() - window.__auto_activity__.last < 3000 : false))
              .catch(() => false);
            if (!active) await maximizeBrowserWindow(context).catch(() => {});
          }
          await page.waitForTimeout(2000).catch(() => {});
        }
      }
      if (!(await isLoggedIn(page).catch(() => false))) throw new Error("Login aborted by user.");
      googleRoute = true;
    }
  }

  if (!googleRoute && !(await isLoggedIn(page))) {
    // Keep clicking the submit while Adobe re-validates (Google route waits on
    // Google's callback — no Adobe Submit to press).
    const captchaWait = await page.evaluate(() => {
      const tags = [...document.querySelectorAll("iframe")].map((f) => (f.getAttribute("src") || "") + " " + (f.title || ""));
      const b = document.querySelector('iframe[title*="reCAPTCHA"], .g-recaptcha, .h-captcha, #captcha, [class*="captcha"]');
      return Boolean(b) || tags.some((t) => /recaptcha|hcaptcha|turnstile|captcha/i.test(t));
    }).catch(() => false);
    if (captchaWait) {
      ok("CAPTCHA detected — tick “I'm not a robot” in the browser window; I'll continue automatically once it clears.");
      await awaitCaptchaResolution(page, Number(process.env.AUTOMATOR_CAPTCHA_WAIT_MS || CAPTCHA_WAIT_MS));
    }
    const loggedInDeadline = Date.now() + 60_000;
    while (Date.now() < loggedInDeadline && !(await isLoggedIn(page))) {
      const submit = await page.locator('button[type="submit"], input[type="submit"], button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Sign In"), button:has-text("Log in")').first();
      if (await submit.count()) await submit.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(2500);
    }
  } else if (googleRoute && !(await isLoggedIn(page))) {
    const captchaWait2 = await page.evaluate(() => {
      const tags = [...document.querySelectorAll("iframe")].map((f) => (f.getAttribute("src") || "") + " " + (f.title || ""));
      return tags.some((t) => /recaptcha|hcaptcha|turnstile|captcha/i.test(t));
    }).catch(() => false);
    if (captchaWait2) {
      ok("CAPTCHA detected — tick “I'm not a robot” in the browser window; I'll continue automatically once it clears.");
      await awaitCaptchaResolution(page, Number(process.env.AUTOMATOR_CAPTCHA_WAIT_MS || CAPTCHA_WAIT_MS));
    }
    // FIRST-TIME login: after the password, Google emails a confirmation code.
    // Do NOT navigate away here — leaving the page aborts the pending Google
    // callback. Stay put and let the user open the code email and click the
    // number; Google/Adobe then auto-redirect back to Behance, which we detect
    // by polling (all open pages). No time limit: the window stays open and we
    // keep waiting until the confirmation happens (only Ctrl+C aborts).
    if (!isStopRequested()) {
      warn(`Google emailed a confirmation code to ${email} — open that inbox, click the number, and Behance loads automatically. The window stays open; I keep watching. (Ctrl+C to abort.)`);
      let codeWarned = false;
      let googleBlocked = false;
      let lastRaise = 0;
      while (!isStopRequested() && !(await isLoggedIn(page).catch(() => false))) {
        const pages = [page, ...(context?.pages ? Array.from(context.pages()) : [])];
        let signedIn = false;
        for (const p of pages) {
          if (await isLoggedIn(p).catch(() => false)) { signedIn = true; break; }
        }
        if (signedIn) {
          ok("Google confirmation completed — login detected.");
          break;
        }
        // If Google blocks the automated sign-in it NEVER sends the email code
        // ("This browser or app may not be secure"). Detect and say so loudly
        // instead of waiting forever for an email that will never arrive.
        if (!googleBlocked) {
          const blocked = await page
            .evaluate(() => {
              const t = (document.body ? document.body.innerText || "" : "").toLowerCase();
              return /may not be secure|disallowed user agent|couldn.?t verify|your computer|unusual traffic|not a robot|automated/.test(t);
            })
            .catch(() => false);
          if (blocked) {
            googleBlocked = true;
            warn("Google flagged this sign-in as automated (“This browser or app may not be secure”). THAT is why no email code arrived — Google is refusing the device, not emailing. Look at the open window: if an error/“Details” page is showing, close the Google tab and redo Sign In on Behance; if a safety prompt is visible, click it. Once Google accepts the device, the one-time code email will come.");
          }
        }
        // Google sometimes asks to TYPE the one-time code instead of clicking
        // a link (6-digit boxes on the page) — tell the user so it's not a
        // silent stall.
        if (!codeWarned) {
          for (const fr of page.frames()) {
            const code = fr
              .locator('input[inputmode="numeric"], input[type="tel"], input[autocomplete="one-time-code"], input[aria-label*="code" i], input[maxlength="6"]')
              .first();
            if (await locVisible(code)) {
              warn("Google is showing a one-time-code box IN THIS WINDOW — type the number it emailed to you into that box.");
              codeWarned = true;
              break;
            }
          }
        }
        // Push the window ABOVE the terminal every ~6s so the user can actually
        // see and use the confirmation page — but never while they are typing
        // in it (a restack would drop keystrokes).
        if (Date.now() - lastRaise > 6000) {
          lastRaise = Date.now();
          const active = await page
            .evaluate(() => (window.__auto_activity__ ? Date.now() - window.__auto_activity__.last < 3000 : false))
            .catch(() => false);
          if (!active) await maximizeBrowserWindow(context).catch(() => {});
        }
        await page.waitForTimeout(2000).catch(() => {});
      }
    }
  }

  if (isStopRequested()) throw new Error("Login aborted by user.");

  // Verify FOR REAL on behance.net — the Adobe auth page can make naive
  // "no login link = logged in" checks lie. Force the redirect/refresh.
  await page.goto("https://www.behance.net/", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(4000);
  if (!(await isLoggedIn(page))) {
    // Hand over: keep the window open, user completes login manually (via the
    // DevTools lifeline at the earlier URL if the WSLg window won't raise).
    warn("Auto-login didn't complete. The browser is OPEN — finish logging in manually.");
    const deadline = Date.now() + Number(process.env.AUTOMATOR_LOGIN_WAIT_MS || 180_000);
    while (Date.now() < deadline && !(await isLoggedIn(page))) {
      await page.goto("https://www.behance.net/", { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(3000).catch(() => {});
    }
  }

  if (!(await isLoggedIn(page))) throw new Error("Login could not be completed in time. The workflow will not run against a logged-out session.");
  ok("Logged in.");
  await persistSession(context, { email, siteName });
  ok("Session saved for " + email);
}

/**
 * Generic Google OAuth driver for sites that log in via "Sign in with Google"
 * (SharePresentation, etc.) — independent of Behance/Adobe. Type the account
 * email, then the password, on whatever Google screen is live (same tab, popup
 * tab, or iframe), click the OAuth consent "Continue/Allow", and wait until the
 * flow returns to the caller's site origin. Returns { done, siteReturned }.
 *
 * Once the password + Enter are typed, Google may still show a one-time-code /
 * device-verification interstitial. In that case we keep the window open, tell
 * the user to click the number from the email, and finish when Google redirects
 * back to the site (only Ctrl+C aborts).
 */
async function ensureGoogleSession({ page, context, email, password, siteOrigin = "" }) {
  const locVisible = async (loc) => {
    const el = loc.first();
    if (!(await el.count().catch(() => 0))) return false;
    return el
      .evaluate((e) => {
        const r = e.getBoundingClientRect();
        const c = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && c.display !== "none" && c.visibility !== "hidden";
      })
      .catch(() => false);
  };
  async function typeExact(pg, locator, text) {
    const el = locator.first();
    if (!(await locVisible(locator))) return false;
    for (let attempt = 0; attempt < 4; attempt++) {
      await el.click({ timeout: 5000 }).catch(() => {});
      await pg.waitForTimeout(300);
      await pg.keyboard.press("Control+A").catch(() => {});
      await pg.keyboard.press("Backspace").catch(() => {});
      await pg.waitForTimeout(150);
      try {
        await pg.keyboard.type(text, { delay: 45 });
      } catch {
        await el.fill(text).catch(() => {});
      }
      await pg.waitForTimeout(250);
      const v = await el.inputValue().catch(() => "");
      if (v === text) return true;
      warn(`Type check: box="${v.slice(0, 24)}" expected="${text.slice(0, 24)}" — clearing and retyping (try ${attempt + 1}/4).`);
    }
    return false;
  }
  const gFrames = () => {
    const roots = [page, ...(context?.pages ? Array.from(context.pages()) : [])];
    const out = [];
    for (const r of roots) {
      for (const f of r.frames()) {
        if (/accounts\.google\.com|google\.com\/signin|ssl\.gstatic/i.test(f.url())) out.push({ fr: f, root: r });
      }
    }
    return out;
  };
  const onSite = () => {
    const roots = [page, ...(context?.pages ? Array.from(context.pages()) : [])];
    return roots.some((p) => {
      const u = p.url();
      return /accounts\.google\.com|google\.com\/signin|ssl\.gstatic/i.test(u) === false && siteOrigin && u.startsWith(siteOrigin) && u !== "about:blank";
    });
  };

  const deadline = Date.now() + Number(process.env.AUTOMATOR_GOOGLE_STEP_WAIT_MS || 150_000);
  let typed = false;
  let notedChooser = false;
  const clickConsent = async () => {
    let clicked = false;
    for (const { fr, root } of gFrames()) {
      // OAuth consent: "Continue"/"Allow"/"Agree" closes the flow in a popup.
      const btn = fr
        .locator('button:has-text("Continue"), button:has-text("Allow"), button:has-text("Agree"), #submit_approve_access, button:has-text("Accept")')
        .first();
      if (await btn.count().catch(() => 0) && await locVisible(btn)) {
        await btn.click({ timeout: 4000 }).catch(() => {});
        if (clicked === false) {
          ok("Google OAuth consent accepted.");
          await root.waitForTimeout(2500).catch(() => {});
        }
        clicked = true;
      }
    }
    return clicked;
  };
  while (Date.now() < deadline && !typed && !onSite()) {
    await clickConsent().catch(() => {});
    if (onSite()) break;
    let acted = false;
    for (const { fr, root } of gFrames()) {
      const idn = fr.locator('input[id="identifierId"], input[name="email"], input[type="email"]').first();
      const next = fr.locator('#identifierNext').first();
      const anyPwNow = fr.locator('input[type="password"], input[id="Passwd"]').first();
      if (await next.count().catch(() => 0)
          && !(await locVisible(anyPwNow))
          && await locVisible(idn)) {
        if (await typeExact(root, idn, email)) ok(`Google email typed (${email}).`);
        await next.click({ timeout: 5000 }).catch(() => {});
        await root.waitForTimeout(2500).catch(() => {});
        acted = true;
        break;
      }
      const pw = fr.locator('input[type="password"], input[id="Passwd"]').first();
      if (await locVisible(pw)) {
        if (await typeExact(root, pw, password)) {
          typed = true;
          ok("Google password auto-filled.");
          await root.keyboard.press("Enter").catch(() => {});
          await root.waitForTimeout(3500).catch(() => {});
        }
        acted = true;
        break;
      }
      // Account chooser: click the matching account row, else "Use another account".
      const known = fr.locator(`div[data-identifier="${email}"], [data-email="${email}"], li:has-text("${email}")`).first();
      if (await known.count().catch(() => 0) && !notedChooser) {
        ok("Choosing your Google account.");
        await known.evaluate((el) => { const link = el.closest("div[data-identifier], li, [role=listbox] li") || el; (link.querySelector("a, [role=link], [data-value]") || link).click(); }).catch(() => {});
        await known.click({ timeout: 4000 }).catch(() => {});
        await root.waitForTimeout(2500).catch(() => {});
        acted = true;
        break;
      }
      const other = fr.locator('#identifierLink, text=Use another account').first();
      if (await other.count().catch(() => 0) && await locVisible(other)) {
        await other.click({ timeout: 4000 }).catch(() => {});
        notedChooser = true;
        await root.waitForTimeout(2500).catch(() => {});
        acted = true;
        break;
      }
    }
    if (!acted) await page.waitForTimeout(1200).catch(() => {});
  }

  // After the password, wait for the flow to return to the site (Google may
  // ask for a one-time code / device verification first — keep the window and
  // finish automatically once the user completes it).
  const returnDeadline = Date.now() + Number(process.env.AUTOMATOR_GOOGLE_STEP_WAIT_MS || 240_000);
  let codeWarned = false;
  let lastRaise = 0;
  while (!isStopRequested() && !onSite() && Date.now() < returnDeadline) {
    if (await clickConsent().catch(() => false)) continue;
    if (!codeWarned) {
      for (const { fr } of gFrames()) {
        const code = fr.locator('input[inputmode="numeric"], input[type="tel"], input[autocomplete="one-time-code"], input[aria-label*="code" i], input[maxlength="6"]').first();
        if (await locVisible(code)) {
          warn("Google is showing a one-time-code box IN THIS WINDOW — type the number from the email into that box.");
          codeWarned = true;
          break;
        }
      }
      if (!codeWarned) {
        const bodyTxt = await page.evaluate(() => (document.body ? (document.body.innerText || "").slice(0, 4000) : "")).catch(() => "");
        if (/enter the code|verify it.?s you|confirmation code/i.test(bodyTxt)) {
          warn(`Google confirms this device — open the inbox for ${email}, click the number, and the site loads automatically. Window stays open (Ctrl+C aborts).`);
          codeWarned = true;
        }
      }
    }
    if (Date.now() - lastRaise > 6000) {
      lastRaise = Date.now();
      const active = await page.evaluate(() => (window.__auto_activity__ ? Date.now() - window.__auto_activity__.last < 3000 : false)).catch(() => false);
      if (!active) await maximizeBrowserWindow(context).catch(() => {});
    }
    await page.waitForTimeout(2000).catch(() => {});
  }
  return { done: typed, siteReturned: onSite() };
}

export { listWorkflows, detectCaptcha, awaitCaptchaResolution, isLoggedIn, manualLoginTakeover, selectSignupEntry, scanSignupFields, acceptRequiredCheckboxes, attemptSignup, attemptLogin, findFormSubmit, ensureGoogleSession };