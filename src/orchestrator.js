import { launchBrowser, newPage, closeBrowser, raiseBrowserWindow, maximizeBrowserWindow, armUserActivity, isStopRequested, readSessionAccount, resolveStoredSession, persistSession, getOzonePlatform } from "./browser/browser.js";
import fs from "node:fs";
import path from "node:path";
import { startLiveView } from "./ui/liveview.js";
import { startWatch } from "./ui/watch.js";
import { holdOpenForReview } from "./ui/hold.js";
import { findWorkflow, listWorkflows } from "./workflow/repository.js";
import { runDiscovery, ensureLoggedIn, ensureGoogleSession } from "./workflow/agent.js";
import { executeWorkflow, mapInputToFields, extractSuccessUrl, findProfileHandle } from "./workflow/engine.js";
import { verifySubmission } from "./verify/verifier.js";
import { recordSubmission, summary } from "./storage/submissionStore.js";
import { ok, warn, logSection, ensureDirs, slugify } from "./common/util.js";
import { collectSiteInput, collectContentInput, collectDiscoveryInput } from "./input/collector.js";
import { config } from "./config.js";

/**
 * Orchestrator — full pipeline:
 *  collect site input -> (load | discover) workflow -> collect content input
 *  (driven by the workflow's content mode) -> execute -> verify -> record.
 */
export async function runPipeline({ discoverOnly = false } = {}) {
  ensureDirs();

  const siteInput = discoverOnly ? await collectDiscoveryInput() : await collectSiteInput();

  if (discoverOnly) {
    await runDiscovery({ siteUrl: siteInput.siteUrl, siteName: siteInput.siteName, credentials: siteInput.credentials });
    return { mode: "discover-only" };
  }

  // --- 1. Load workflow from repository, or discover it --------------------
  const existing = findWorkflow(siteInput.siteUrl);
  let workflow;
  let workflowSource;
  if (existing) {
    ok(`Workflow found in repository: ${existing.file}`);
    workflow = existing.workflow;
    workflowSource = "repository";
  } else {
    warn("No workflow in repository — browser agent will discover the website now.");
    const result = await runDiscovery({ siteUrl: siteInput.siteUrl, siteName: siteInput.siteName, credentials: siteInput.credentials });
    if (result.interrupted) return { status: "interrupted" };
    workflow = result.workflow;
    workflowSource = "discovered";
  }

  if (!workflow) throw new Error("No workflow available. Aborting.");

  if (workflow.status === "partial" && workflow.blocker?.blocked) {
    const hasCreds = !!(siteInput.credentials?.email && siteInput.credentials?.password);
    if (hasCreds && !config.browser.headless) {
      warn("Stored workflow is blocked (login-gated) — re-running browser-agent discovery with your credentials.");
      const result = await runDiscovery({
        siteUrl: siteInput.siteUrl,
        siteName: siteInput.siteName,
        credentials: siteInput.credentials,
      });
      if (result.interrupted) return { status: "interrupted" };
      workflow = result.workflow;
      workflowSource = "discovered";
    } else {
      throw new Error(
        `Workflow for ${siteInput.siteUrl} is blocked (login/${workflow.blocker.reason}). ` +
          "Behance needs a manual login (Adobe CAPTCHA/2FA), which only works in a visible browser. " +
          "Run this FIRST:\n\n    AUTOMATOR_HEADLESS=0 npm run discover\n\n" +
          "Log in in the browser window that opens. After it says 'Workflow saved', rerun: npm start"
      );
    }
  }

  if (workflow.status === "partial") {
    throw new Error(
      `Discovery for ${siteInput.siteUrl} did not complete (login/captcha/2FA). ` +
        "Run 'AUTOMATOR_HEADLESS=0 npm run discover' to log in manually and finish capturing the workflow."
    );
  }

  if (workflow.status === "needs-review") {
    warn("Workflow is marked 'needs-review' — some pieces were not detected. Running best-effort.");
  }

  // --- 2. Collect content input AFTER the workflow is known so the form can
  // decide whether the site takes the blog body as plain text or as a document.
  // The mode is derived from workflow.inputs.content.mode, never hard-coded.
  const content = await collectContentInput({
    siteName: siteInput.siteName,
    siteUrl: siteInput.siteUrl,
    workflow,
  });
  const input = { ...siteInput, ...content };

  // Show the plan (input -> field mapping) -----------------------------------
  logSection("Mapping input to website fields");
  const mapping = mapInputToFields(workflow, input);
  for (const [field, info] of Object.entries(mapping)) {
    ok(`${field.padEnd(12)} -> step "${info.stepId}"${info.provided ? "" : " (not provided)"}`);
  }

  // --- 3. Execute in the real browser ---------------------------------------
  const browser = await launchBrowser();
  let stepSummary;
  let publishedUrl = "";
  let status = "failed";
  let errorMsg = "";
  let raiseWatchdog = null;
  let liveView = null;
  let watch = null;
  let livePage = null;

  try {
    // Detect a credential switch: if the user supplied an email that is NOT the
    // account behind the stored session, don't replay the old session (that is
    // what made posts keep landing on the previous account). Fresh context →
    // the login form is seen → the new account is used. AUTOMATOR_FRESH_LOGIN=1
    // forces this even when the email matches.
    const providedEmail = String(siteInput.credentials?.email || "").trim();
    const storedAccount = readSessionAccount();
    const sessionResolve = resolveStoredSession({
      providedEmail,
      storedAccount,
      forceFresh: process.env.AUTOMATOR_FRESH_LOGIN === "1",
    });
    const accountSwitched = !sessionResolve.replay;
    if (accountSwitched) {
      warn(
        storedAccount?.email
          ? `New login email (${providedEmail}) differs from the stored session account (${storedAccount.email}) — logging in FRESH, not posting to the previous account.`
          : `No account recorded for the stored session — logging in FRESH with ${providedEmail} so the post uses the NEW account (${sessionResolve.reason}).`
      );
    }
    const { page } = await newPage(browser, {
      storageState: workflowSource === "repository" && config.browser.storageState && sessionResolve.replay && fs.existsSync(config.browser.storageState) ? config.browser.storageState : undefined,
    });
    livePage = page;
    await armUserActivity(page).catch(() => {});

    if (!config.browser.headless) {
      // Same guarantee as discovery: place the window on-screen (maximized, so
      // it can never hide behind the terminal), clamped to the real screen so
      // the user can watch the run and solve any CAPTCHA in a visible window.
      await maximizeBrowserWindow(page.context()).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 400));
      ok(`Headed browser active — watch the REAL Chrome-for-testing window on your desktop (maximized, ${getOzonePlatform()} backend).`);
      ok(`If you can't find it: press Win+Tab (Task View) → click it — it may be on another virtual desktop.`);
    }

    // Keep the real browser window raised all run long (every 5s) so the user
    // can watch the agent work in the live editor/website.
    if (!config.browser.headless) {
      raiseWatchdog = setInterval(() => {
        raiseBrowserWindow(page.context(), { gentle: true }).catch(() => {});
      }, 5000);
    }

    // Fresh-login guarantee: when there is NO saved session to replay (deleted,
    // other account, or never recorded), a logged-out run would fail its first
    // click (e.g. Behance hides "Share Work" from logged-out visitors). Sign in
    // FIRST using the supplied credentials so the workflow runs authenticated.
    const sessionAvailable = sessionResolve.replay && fs.existsSync(config.browser.storageState);
    if (!sessionAvailable && providedEmail && process.env.BEHANCE_PASSWORD && !config.browser.headless) {
      const siteKey = String(workflow?.meta?.siteKey || String(siteInput.siteUrl || "")).toLowerCase();
      logSection("Signing in (fresh session) — watch the browser window");
      const siteOrigin = (() => { try { return new URL(siteInput.siteUrl).origin; } catch { return ""; } })();
      if (/behance/.test(siteKey)) {
        await ensureLoggedIn({ page, context: page.context(), email: providedEmail, password: process.env.BEHANCE_PASSWORD, siteName: siteInput.siteName });
      } else {
        // Social-login site (e.g. SharePresentation): go to the site, click its
        // "Sign in with Google", and drive the generic Google OAuth (email ->
        // password -> consent). The engine's auth phase then sees an active
        // session and skips the workflow's own login steps.
        await page.goto(siteOrigin, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(2000);
        await maximizeBrowserWindow(page.context()).catch(() => {});
        const googleBtn = page
          .locator('a[href*="google/redirect"], a[href*="google"], button:has-text("Sign in with Google"), a:has-text("with Google"), #uploadsession')
          .first();
        if (await googleBtn.count().catch(() => 0)) {
          await googleBtn.click({ timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(2500);
        }
        await ensureGoogleSession({ page, context: page.context(), email: providedEmail, password: process.env.BEHANCE_PASSWORD, siteOrigin });
      }
    }

    // Live terminal view + (opt-in) crisp browser mirror.
    liveView = config.browser.headless ? null : startLiveView(page);
    watch = config.browser.headless ? null : startWatch(page);

    const execution = await executeWorkflow({ workflow, input, page });
    stepSummary = summarizeSteps(execution);

    const hasHardFail = execution.failures.length > 0;
    publishedUrl = execution.publishedUrl;

    if (hasHardFail) {
      status = "failed";
      errorMsg = execution.results.find((r) => r.failed)?.error || "one or more steps failed";
      warn(`Workflow finished with ${execution.failures.length} failed step(s). Running verification anyway.`);
    }

    // --- 4. Verify result ---------------------------------------------------
    // MediaFire: the public share link exists ONLY in the clipboard (the row's
    // "Copy share link" button); there is no URL in the DOM to reload and no
    // publish confirmation dialog. Resolve it right away — while the page is
    // still on the app — and confirm over HTTP. No human verification is ever
    // requested; the generic DOM verifier only applies to non-MediaFire sites.
    const isMediaFire = /mediafire/i.test(String(workflow.meta?.siteKey || ""));
    const isDochub = /dochub/i.test(String(workflow.meta?.siteKey || ""));
    const isJumpshare = /jumpshare/i.test(String(workflow.meta?.siteKey || ""));
    if (isMediaFire) {
      const fileName = input.bodyDocumentPath ? path.basename(input.bodyDocumentPath).replace(/\.[^.]+$/, "") : "";
      const url = await resolveMediaFireShareUrl(page, { fileName, title: input.title }).catch(() => "");
      if (url && await confirmHttpLive(url, { page }).catch(() => false)) {
        status = "published";
        publishedUrl = url;
        ok(`Published URL auto-resolved and confirmed over HTTP: ${url}`);
      } else {
        status = "pending"; // uploaded, could not resolve share link publicly
        publishedUrl = publishedUrl || "";
        warn(`File was uploaded but its share link could not be confirmed: ${publishedUrl || "unknown URL"}`);
      }
      const verification = { verified: status === "published", url: status === "published" ? publishedUrl : "" };
    } else if (isDochub) {
      const url = await resolveDochubShareUrl(page).catch(() => "");
      if (url && await confirmHttpLive(url, { page }).catch(() => false)) {
        status = "published";
        publishedUrl = url;
        ok(`Published URL auto-resolved and confirmed over HTTP: ${url}`);
      } else if (url) {
        status = "pending"; // share link found but not publicly reachable
        publishedUrl = url;
        warn(`DocHub share link captured but could not be confirmed publicly: ${url}`);
      } else {
        status = "pending"; // no share link (verification not completed, or doc not created)
        publishedUrl = publishedUrl || "";
        warn(`DocHub document was not confirmed: ${publishedUrl || "no shareable link (account verification or free-plan creation cap?)"}`);
      }
      const verification = { verified: status === "published", url: status === "published" ? publishedUrl : "" };
    } else if (isJumpshare) {
      const fileName = input.bodyDocumentPath ? path.basename(input.bodyDocumentPath) : "";
      const url = await resolveJumpshareShareUrl(page, { fileName, title: input.title }).catch(() => "");
      if (url && await confirmHttpLive(url, { page }).catch(() => false)) {
        status = "published";
        publishedUrl = url;
        ok(`Published URL auto-resolved and confirmed over HTTP: ${url}`);
      } else {
        status = "pending"; // uploaded, could not resolve /share/ URL
        publishedUrl = publishedUrl || "";
        warn(`File was uploaded but its Jumpshare share link could not be confirmed: ${publishedUrl || "unknown URL"}`);
      }
      const verification = { verified: status === "published", url: status === "published" ? publishedUrl : "" };
    } else {
      const verification = await verifySubmission({
        page,
        workflow,
        expectedUrl: publishedUrl,
        input,
      });

      if (verification.verified) {
        // The post is confirmed live regardless of failed intermediate steps
        // (e.g. tags autocomplete tripping over an overlay). Keep the failure on
        // record but don't mislabel a published post.
        if (hasHardFail) {
          warn(`Post verified live despite ${execution.failures.length} failed step(s); recording as published.`);
        }
        status = "published";
        publishedUrl = verification.url || publishedUrl;
        ok(`Post is live: ${publishedUrl}`);
      } else if (!hasHardFail) {
        // The engine may have already confirmed the publish itself: blogfreely's
        // "wait-published-url" step waits for the URL to become the real
        // /<blog>/<slug> post. The DOM-based verification can still miss it (the
        // site doesn't render the selectors we expect). If the workflow witnessed
        // the published URL, confirm it with a plain HTTP fetch instead of pausing
        // for a manual click.
        const engineConfirmed =
          !!publishedUrl &&
          execution.results.some((r) => r.stepId === "wait-published-url" && r.ok && !r.failed && !r.skipped);
        if (engineConfirmed && await confirmHttpLive(publishedUrl, { page }).catch(() => false)) {
          status = "published";
          ok(`Published URL confirmed over HTTP: ${publishedUrl}`);
        } else if (/behance/i.test(String(workflow.meta?.siteKey || ""))) {
          // Behance: resolve the live project URL automatically (no human pause).
          // The engine already waits for the /gallery/ page after the final Publish
          // click; when it couldn't, walk the user's profile for the newest gallery
          // link and confirm it over HTTP. This is fully automatic — nothing waits
          // on the user, and the browser closes itself afterwards.
          const url = await resolveBehanceGalleryUrl(page).catch(() => "");
          if (url && await confirmHttpLive(url, { page }).catch(() => false)) {
            status = "published";
            publishedUrl = url;
            ok(`Published URL auto-resolved and confirmed: ${url}`);
          } else {
            status = "pending"; // submitted, could not confirm publicly
            publishedUrl = publishedUrl || "";
            warn(`Post was submitted but could not be verified: ${publishedUrl || "unknown URL"}`);
          }
        } else {
          status = "pending"; // submitted, could not confirm publicly
          publishedUrl = publishedUrl || "";
          warn(`Post was submitted but could not be verified: ${publishedUrl || "unknown URL"}`);
        }
      }
    }

    // Persist the (possibly new) session + WHICH account it belongs to, so the
    // next run replays THIS account instead of silently falling back to the
    // previous one. Only persist on a clean run so a failed login never nukes
    // a known-good session.
    if (status !== "failed" && providedEmail) {
      await persistSession(page.context(), { email: providedEmail, siteName: input.siteName }).catch(() => {
        warn("Could not persist the updated session — next runs may reuse the previous account.");
      });
      ok(`Session updated for account ${providedEmail} — future runs will use this account.`);
    }
  } catch (err) {
    if (isStopRequested()) {
      status = "interrupted";
      warn("Run interrupted by user (Ctrl+C) — stopping cleanly.");
      return { status };
    }
    status = "failed";
    errorMsg = err.message;
    warn(`Pipeline error: ${err.message}`);
  } finally {
    if (raiseWatchdog) clearInterval(raiseWatchdog);
    if (watch) watch.stop();
    if (liveView) liveView.stop();

    // Usually the window CLOSES itself after the run (nothing waits on the user).
    // AUTOMATOR_HOLD_MS>0 opts into keeping it open for review instead.
    if (livePage && !config.browser.headless && !isStopRequested()) {
      const holdMs = Number(process.env.AUTOMATOR_HOLD_MS || 0);
      if (holdMs > 0) {
        logSection("Run finished — the live window is KEPT OPEN for you to review");
        ok(`The window shows the final page (${publishedUrl || "last page seen"}).`);
        ok(`It will close automatically in ${Math.round(holdMs / 1000)}s, or press Enter to close it now.`);
        await raiseBrowserWindow(livePage.context()).catch(() => {});
        await holdOpenForReview({ holdMs });
      }
    }

    await closeBrowser(browser);
  }

  // --- 5. Persist submission + status + published URL -----------------------
  const record = recordSubmission({
    site: input.siteName,
    siteUrl: input.siteUrl,
    title: input.title,
    category: input.category,
    tags: input.tags,
    visibility: input.visibility,
    backlinkUrl: input.backlinkUrl,
    bodyDocumentUrl: input.bodyDocumentUrl,
    bodyContentMode: input.bodyContentMode,
    status,
    publishedUrl,
    workflowUsed: workflowSource,
    stepSummary,
    error: errorMsg,
  });

  logSection("Submission record saved");
  console.log(`  id           : ${record.id}`);
  console.log(`  site         : ${record.site} (${record.siteUrl})`);
  console.log(`  title        : ${record.title}`);
  console.log(`  status       : ${status}`);
  console.log(`  publishedUrl : ${publishedUrl || "(none)"}`);
  console.log(`  recorded in  : ${config.submissionsFile}`);
  console.log(`  all-time     : ${JSON.stringify(summary())}`);

  return { record, status, publishedUrl };
}

/**
 * Minimal liveness probe for a published URL captured by the workflow itself
 * (e.g. a /<blog>/<slug> post that blogfreely's wait-published-url observed).
 * A 200 from the published page means the post is live — no human click needed.
 */
async function confirmHttpLive(url, { title = "", page = null } = {}) {
  // Preferred: Node fetch. Some environments override DNS for a single host
  // (e.g. www.mediafire.com -> a private IP) which the browser can re-map via
  // --host-resolver-rules but Node cannot — so fall back to the browser's own
  // network stack, which honors that mapping.
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      if (title) {
        const html = (await res.text()).slice(0, 300_000);
        if (html.toLowerCase().includes(title.toLowerCase())) return true;
      } else {
        return true;
      }
    }
  } catch {
    /* fall through to the browser check */
  }
  if (!page) return false;
  // page.request runs in the Node sidecar, so it does NOT honor the browser's
  // --host-resolver-rules. Actually navigate a throwaway browser tab instead —
  // its network stack applies the mapping.
  let vp = null;
  try {
    vp = await page.context().newPage();
    const resp = await vp.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000, referer: undefined });
    if (!resp || !resp.ok()) return false;
    if (title) {
      const html = (await vp.content()).slice(0, 300_000);
      return html.toLowerCase().includes(title.toLowerCase());
    }
    return true;
  } catch {
    return false;
  } finally {
    if (vp) await vp.close().catch(() => {});
  }
}

function summarizeSteps(execution) {
  return execution.results.map((r) => ({
    step: r.stepId,
    ok: r.ok || r.skipped,
    skipped: !!r.skipped,
    error: r.error || "",
  }));
}

/**
 * Fully automatic Behance published-URL resolution (no human pause):
 * 1. If the current page is already a /gallery/ URL, use it.
 * 2. Look for a publish-success modal / toast carrying the gallery link.
 * 3. Else navigate to the user's profile and take the newest gallery link.
 * Returns the gallery URL or "" — never waits on the user.
 */
async function resolveBehanceGalleryUrl(page) {
  if (/behance\.net\/gallery\//.test(page.url())) return page.url();
  const extracted = await extractSuccessUrl(page).catch(() => null);
  if (extracted && /behance\.net\/gallery\//.test(extracted)) return extracted;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (/behance\.net\/gallery\//.test(page.url())) return page.url();
    const found = await extractSuccessUrl(page).catch(() => null);
    if (found && /behance\.net\/gallery\//.test(found)) return found;
  }
  const handle = await findProfileHandle(page).catch(() => null);
  if (!handle) return "";
  try {
    await page.goto(`https://www.behance.net/${handle}/projects`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3000);
  } catch { return ""; }
  return page
    .evaluate(() => {
      const links = [...document.querySelectorAll('a[href*="/gallery/"]')]
        .map((a) => { try { return a.href; } catch { return ""; } })
        .filter((h) => /behance\.net\/gallery\//.test(h));
      return links.length ? links[0] : "";
    })
    .catch(() => "");
}

/**
 * Fully automatic MediaFire published-URL resolution (no human pause).
 * MediaFire exposes the public share link ONLY via the "Copy share link"
 * clipboard action on a file row — there is no navigable URL in the DOM.
 * Strategy: find the copy button whose row (nearest ancestor containing that
 * button) mentions the uploaded file's display name, click it, then read the
 * clipboard for a /file/<key>/<name> URL. Returns the URL or "".
 */
export async function resolveMediaFireShareUrl(page, { fileName = "", title = "" } = {}) {
  const names = [fileName, title].filter(Boolean);
  const deadline = Date.now() + 60_000;

  // The verifier may have navigated the shared page away from the MediaFire
  // app (e.g. to a glob-stripped /file/ candidate). Always come back to My
  // Files first so the copy buttons are on-screen, session cookies intact.
  try {
    await page.goto("https://app.mediafire.com/folder/myfiles", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);
  } catch { /* page unreachable — fall through and try in place */ }

  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://app.mediafire.com" });
  } catch { /* clipboard perm unavailable — automation may still work */ }

  // MediaFire virtualizes its file list: rows below the fold don't exist in the
  // DOM. Scroll the list container step by step, scanning for our copy button at
  // each position, until found or the deadline passes.
  const scroll = async (dir) => {
    await page
      .evaluate((dir) => {
        // The scrollable container holds the transform-virtualized rows.
        const scrollers = [...document.querySelectorAll("*")].filter((e) => {
          const st = getComputedStyle(e);
          return (st.overflowY === "auto" || st.overflowY === "scroll") && e.scrollHeight > e.clientHeight + 50;
        });
        const sc = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        if (sc) sc.scrollTop += dir * Math.max(sc.clientHeight - 60, 240);
      }, dir)
      .catch(() => {});
    await page.waitForTimeout(350);
  };

  const findCopy = async (names) =>
    page
      .evaluate((names) => {
        const btns = [...document.querySelectorAll('button[aria-label="Copy share link"]')];
        for (const b of btns) {
          let el = b;
          for (let i = 0; i < 6 && el; i++) {
            const text = (el.textContent || "").replace(/\s+/g, " ").trim();
            if (names.some((n) => n && n.length >= 3 && text.includes(n))) {
              b.setAttribute("data-mf-marker", "mf-copy");
              return true;
            }
            el = el.parentElement;
          }
        }
        return false;
      }, names)
      .catch(() => false);

  while (Date.now() < deadline) {
    // Newest uploads sit at the TOP of My Files; scan from the top downward.
    let clicked = await findCopy(names);
    if (!clicked) {
      for (let step = 0; step < 40 && !clicked && Date.now() < deadline; step++) {
        await scroll(1);
        clicked = await findCopy(names);
      }
    }
    if (!clicked) {
      // Could have scrolled past it (or the list re-sorted). Reset to top.
      await page.evaluate(() => {
        const scrollers = [...document.querySelectorAll("*")].filter((e) => {
          const st = getComputedStyle(e);
          return (st.overflowY === "auto" || st.overflowY === "scroll") && e.scrollHeight > e.clientHeight + 50;
        });
        const sc = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        if (sc) sc.scrollTop = 0;
      }).catch(() => {});
      await page.waitForTimeout(400);
    }

    if (clicked) {
      const btn = page.locator('button[data-mf-marker="mf-copy"]').first();
      await btn.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
      let ok = await btn
        .click({ timeout: 8000 })
        .catch(() => false)
        .then((v) => v === true || v === undefined);
      if (!ok) {
        // An overlay/toast can block Playwright's actionability check even
        // though the browser would accept the click. Retry with a raw DOM
        // click on the marked button.
        ok = await btn
          .evaluate((n) => { const r = n.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false; n.click(); return true; })
          .catch(() => false);
      }
      if (ok) {
        for (let i = 0; i < 6; i++) {
          await page.waitForTimeout(1000);
          try {
            const clip = (await page.evaluate(() => navigator.clipboard.readText()) || "").trim();
            if (clip && /mediafire\.com\/file\//.test(clip)) {
              // Accept only links to OUR file: the /file/<key>/<name> slug
              // carries the uploaded file's display name. MediaFire re-encodes
              // it (spaces -> "_", "(" -> "%2528"), so compare normalized.
              const matches = names.some((n) => {
                if (!n || n.length < 3) return false;
                if (clip.includes(n)) return true;
                const norm = (s) => {
                  let out = s;
                  try { out = decodeURIComponent(out); out = decodeURIComponent(out); } catch { /* no-op */ }
                  out = out.toLowerCase().replace(/_/g, " ");
                  return out.replace(/[^a-z0-9]/g, "");
                };
                const cn = norm(clip);
                const nn = norm(n);
                return nn.length >= 3 && cn.includes(nn);
              });
              if (matches) return clip;
            }
          } catch { /* clipboard read blocked — retry */ }
        }
      }
    }
    await page.waitForTimeout(2000);
  }
  return "";
}

/**
 * DocHub exposes the public URL in a readonly input (#shareLink) inside the
 * editor's Share dialog, but only AFTER a "Get Shareable Link" token has been
 * created (gated by one-time account verification the very first time). This
 * resolver: makes sure the editor is on screen, dismisses the onboarding
 * overlay, opens Share, clicks "Get Shareable Link" when needed, and returns
 * the value of #shareLink (https://dochub.com/m/shared-document/...?dt=...).
 * Returns "" when the account is unverified or no doc was created.
 */
export async function resolveDochubShareUrl(page) {
  let deadline = Date.now() + 75_000;
  let verificationClicked = false;

  const dismissOverlays = async () => {
    await page
      .evaluate(() => {
        const skip = [...document.querySelectorAll("button, [role='button'], a")].find(
          (e) => /^Skip$/i.test((e.textContent || "").trim()) && e.getBoundingClientRect().width > 0
        );
        if (skip) skip.click();
      })
      .catch(() => {});
  };
  const clickGetLink = async () =>
    page
      .evaluate(() => {
        const vis = (e) => e.getBoundingClientRect().width > 0;
        const cands = [...document.querySelectorAll("button, [role='button'], a, div, span")].filter(
          (e) => vis(e) && /^get shareable link\b/i.test((e.textContent || "").replace(/\s+/g, " ").trim())
        );
        if (!cands.length) return false;
        // The menu item's text carries a description ("Get Shareable Link
        // Share this document with..."), so an exact match never fires.
        // Pick the most specific node and click its interactive ancestor.
        cands.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
        const el = cands[0];
        const target = el.closest("button, [role='button'], a, [tabindex]") || el;
        target.click();
        return true;
      })
      .catch(() => false);

  // DocHub gates the FIRST share token behind a one-time account verification
  // ("verify your account by creating a DocHub Pro subscription, or by adding
  // Phone Verification. Alternatively, you can verify temporarily using
  // reCAPTCHA."). Click the free reCAPTCHA route so the human watching the
  // live window can solve it; automation then continues.
  const clickRecaptcha = async () =>
    page
      .evaluate(() => {
        const vis = (e) => e.getBoundingClientRect().width > 0;
        const el = [...document.querySelectorAll("button, [role='button'], a, div, span")]
          .filter(vis)
          .find((e) => /continue with recaptcha/i.test((e.textContent || "").replace(/\s+/g, " ").trim()));
        if (!el) return false;
        (el.closest("button, [role='button'], a, [tabindex]") || el).click();
        return true;
      })
      .catch(() => false);

  await dismissOverlays();
  await page.waitForTimeout(1200);

  // The workflow's last step waits for #share-send-btn (the editor toolbar's
  // Share control); if that never appeared, no document was created.
  const inEditor = await page.locator("#share-send-btn").first().isVisible({ timeout: 15_000 }).catch(() => false);
  if (!inEditor) return "";

  await page.evaluate(() => { const b = document.querySelector("#share-send-btn"); if (b) b.click(); }).catch(() => {});
  await page.waitForTimeout(4000);

  while (Date.now() < deadline) {
    const existing = await page
      .evaluate(() => {
        const el = document.querySelector("#shareLink");
        const v = (el && el.value) || "";
        return /^https:\/\/dochub\.com\/m\/shared-document\//.test(v) ? v : "";
      })
      .catch(() => "");
    if (existing) return existing;

    const state = await page
      .evaluate(() => {
        const body = document.body?.innerText || "";
        return {
          hasGetLink: [...document.querySelectorAll("button, [role='button'], a, div, span")].some(
            (e) =>
              /^get shareable link\b/i.test((e.textContent || "").replace(/\s+/g, " ").trim()) &&
              e.getBoundingClientRect().width > 0
          ),
          hasCopyLink: !!document.querySelector("#shareLinkButton"),
          verification: /Verification Required|reCAPTCHA|further verified/i.test(body.slice(-1600)),
        };
      })
      .catch(() => ({ hasGetLink: false, hasCopyLink: false, verification: false }));

    if (state.verification) {
      // One-time verification gate. Open the free reCAPTCHA challenge ONCE and
      // extend the deadline so the human can solve it in the visible window;
      // keep polling (after solving, "Get Shareable Link" reappears and yields
      // #shareLink).
      if (!verificationClicked) {
        verificationClicked = await clickRecaptcha();
        if (verificationClicked) {
          warn("DocHub requires a one-time account verification — opened the reCAPTCHA; please solve it in the live browser window.");
          deadline = Math.max(deadline, Date.now() + 180_000);
        } else {
          return "";
        }
      }
      await page.waitForTimeout(3000);
      continue;
    }
    if (state.hasGetLink) await clickGetLink();
    await dismissOverlays();
    await page.waitForTimeout(3500);
  }
  return "";
}

/**
 * JumpShare exposes each uploaded file's public share URL as a row anchor:
 * <a class="thumb-title" href="/share/<token>" data-id="<token>"
 *    title="<filename>">. This resolver returns to the personal library
 * (https://jumpshare.com/ redirects there once logged in), waits for the row
 * that carries our uploaded file's name, and returns the absolute /share/ URL.
 */
export async function resolveJumpshareShareUrl(page, { fileName = "", title = "" } = {}) {
  const names = [fileName, (fileName || "").replace(/\.[^.]+$/, ""), title].filter(Boolean);
  const deadline = Date.now() + 75_000;

  try {
    await page.goto("https://jumpshare.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);
  } catch { /* page unreachable — fall through and scan where we are */ }

  const norm = (s) => String(s || "").toLowerCase().replace(/[_\/]/g, " ").trim();

  while (Date.now() < deadline) {
    const hit = await page
      .evaluate((names) => {
        const norm = (s) => String(s || "").toLowerCase().replace(/[_\/]/g, " ").trim();
        const nodes = [...document.querySelectorAll('a.thumb-title')];
        for (const a of nodes) {
          const label = a.getAttribute("title") || (a.textContent || "").trim();
          const href = (a.getAttribute("href") || "").trim();
          const m = href.match(/^\/(share\/[A-Za-z0-9]{10,})(?:\?[A-Za-z0-9=&]*)?$/);
          if (!m) continue;
          if (names.some((n) => n && norm(n).length >= 3 && (norm(label).includes(norm(n)) || norm(n).includes(norm(label))))) {
            return "/" + m[1];
          }
        }
        return "";
      }, names)
      .catch(() => "");
    if (hit) return "https://jumpshare.com" + hit;
    await page.waitForTimeout(2500);
  }
  return "";
}

export function printSavedWorkflows() {
  const wfs = listWorkflows();
  if (!wfs.length) {
    console.log("No workflows saved yet.");
    return;
  }
  logSection("Workflow repository");
  for (const w of wfs) {
    console.log(`  ${w.meta?.siteName || "?"}: ${w.meta?.siteUrl}`);
    console.log(`    steps=${w.steps?.length || 0}  status=${w.status || "?"}  saved=${w.savedAt || "?"}`);
  }
}