import { runAction, resolveClickLocator } from "../actions/actions.js";
import { isValidWorkflow } from "./repository.js";
import { ok, warn, error, logSection, screenshot, info } from "../common/util.js";
import { isStopRequested } from "../browser/browser.js";
import { generateBodyDocuments, downloadDocumentUrl, toUploadableDoc } from "../documents/bodyDocument.js";
import { awaitCaptchaResolution } from "./agent.js";
import path from "node:path";

/**
 * Workflow Engine
 * -----------------
 * 1. Validates the workflow schema.
 * 2. Maps user input onto workflow fields (via step.property and
 *    workflow.fieldMappings).
 * 3. Executes each step in a real browser using Playwright action primitives.
 * 4. Reports per-step results and any failures.
 */

export function mapInputToFields(workflow, input) {
  const mapping = {};
  for (const [field, stepId] of Object.entries(workflow.fieldMappings || {})) {
    const value = input[field];
    mapping[field] = { stepId, provided: value !== undefined && value !== null && value !== "" };
  }
  return mapping;
}

export async function executeWorkflow({ workflow, input, page }) {
  if (!isValidWorkflow(workflow)) {
    throw new Error(`Invalid workflow schema for "${workflow?.meta?.siteUrl}". Re-run discovery.`);
  }

  logSection(`Executing workflow: ${workflow.meta?.siteName}`);
  const results = [];
  const failures = [];

  // --- 0. Documents: some sites accept the blog body only as an uploaded
  // document (a file input, not a contenteditable). When the workflow declares
  // a body-document step, upload the user's Document URL, or fall back to
  // rendering the description into a .docx (anchor keyword wrapped as a real
  // hyperlink) plus a .txt fallback.
  if ((workflow.steps || []).some((s) => s.property === "bodyDocument")) {
    try {
      if (input.bodyDocumentUrl) {
        input.bodyDocumentPath = await downloadDocumentUrl(input.bodyDocumentUrl, { title: input.title });
        // Directory sites only accept presentation/document formats; a .txt
        // Document URL/local path would be rejected ("file format is not
        // supported"). Normalize unsupported text documents into a .docx.
        input.bodyDocumentPath = await toUploadableDoc({
          filePath: input.bodyDocumentPath,
          keyword: input.keyword,
          url: input.backlinkUrl,
          title: input.title,
        });
        ok(`Body document downloaded from URL -> ${input.bodyDocumentPath}`);
      } else if (input.description) {
        const docs = await generateBodyDocuments({
          text: input.description,
          keyword: input.keyword,
          url: input.backlinkUrl,
          title: input.title,
        });
        input.bodyDocumentPath = docs.docxPath;
        input.bodyDocumentTxtPath = docs.txtPath;
        ok(`Body document generated -> ${docs.docxPath} (keyword ${input.keyword ? `"${input.keyword}" linked to ${input.backlinkUrl}` : "not linked"})`);
      } else {
        warn("Workflow requires a body document but neither Document URL nor blog content was provided.");
      }
      // A bare .txt body (runner-supplied, e.g. bodyDocumentPath/bodyDocumentTxtPath
      // without a Document URL or description) still needs to become an uploadable
      // document with the anchor keyword hyperlink. toUploadableDoc is a no-op for
      // already-uploadable formats, so this is safe to run unconditionally.
      if (input.bodyDocumentPath) {
        input.bodyDocumentPath = await toUploadableDoc({
          filePath: input.bodyDocumentPath,
          keyword: input.keyword,
          url: input.backlinkUrl,
          title: input.title,
        });
      }
    } catch (err) {
      warn(`Could not prepare body document: ${err.message}`);
    }
  }

  // --- 0. Authentication (if workflow requires login) ----------------------
  if (workflow.auth?.required) {
    const creds = input.credentials || {};
    // Social sign-in (e.g. "Sign in with Google") needs no email/password.
    const social = workflow.auth.loginMethod === "social" ||
      /google|oauth|signin-with/i.test(JSON.stringify(workflow.auth.loginSteps || []).slice(0, 400));
    if (!creds.email || !creds.password) {
      if (social) {
        info("Sign-in via social button — relying on the browser session (no email/password entered).");
      } else {
        warn("Workflow requires login but no credentials provided. This step will likely fail.");
      }
    }
    const siteOrigin = (() => { try { return new URL(workflow.meta?.siteUrl || page.url()).origin; } catch { return ""; } })();
    const onSite = (p) => Boolean(siteOrigin) && p.url().startsWith(siteOrigin);

    // Opportunistic session check: the app frequently re-runs a saved workflow
    // while an earlier run already left the browser signed in (persistent
    // profile). The auth loginSteps then have NOTHING to click ("#uploadsession"
    // disappears once logged in) and would time out for 45s each. If none of the
    // declared login controls is VISIBLE and we are already on the site's
    // origin, assume the session is active: skip the login steps AND the
    // login-verify verdict instead of failing the run.
    let authSessionActive = false;
    const loginSteps = workflow.auth.loginSteps || [];
    const clickSteps = loginSteps.filter((s) => s.action === "click");
    if (clickSteps.length && onSite(page)) {
      let controlVisible = false;
      for (const s of clickSteps) {
        if (!s.selector) continue;
        try {
          const loc = page.locator(s.selector).first();
          if (await loc.count().catch(() => 0)) {
            if (await loc.isVisible().catch(() => false)) { controlVisible = true; break; }
          }
        } catch {}
      }
      if (!controlVisible) {
        info("No visible login control and already on the site — assuming the session is active; skipping the workflow's login steps.");
        authSessionActive = true;
      }
    }

    if (authSessionActive) {
      for (const step of loginSteps) {
        results.push({ stepId: step.id, action: step.action, phase: "auth", ok: true, skipped: true, reason: "session already active" });
      }
      await page.waitForTimeout(1500);
    } else {
      for (const step of loginSteps) {
        let value;
        if (step.property === "_email") value = creds.email;
        else if (step.property === "_password") value = creds.password;
        const credStep = { ...step, value };
        // Login-control resilience: jumping into a site that is ALREADY signed in
        // lands directly on a signed-in page (or a redirect to it) where the
        // login form never appears. A 45s wait on a fill/click control would
        // waste time and then count as a hard failure. Instead: after a short
        // grace wait, if we are back on the site origin and the control is still
        // not visible, skip this and the remaining login steps (session active).
        if (step.selector) {
          const loc = page.locator(step.selector).first();
          const visible = await loc.isVisible({ timeout: 3000 }).catch(() => false);
          if (!visible && onSite(page)) {
            ok(`step "${step.id}" skipped: no visible "${step.selector}" — session already active.`);
            results.push({ stepId: step.id, action: step.action, phase: "auth", ok: true, skipped: true, reason: "session already active" });
            for (const later of loginSteps.slice(loginSteps.indexOf(step) + 1)) {
              results.push({ stepId: later.id, action: later.action, phase: "auth", ok: true, skipped: true, reason: "session already active" });
            }
            break;
          }
        }
        results.push(await execOne(page, credStep, input, "auth"));
        if (results[results.length - 1].failed) failures.push(results[results.length - 1].stepId);
      }
      await page.waitForTimeout(2500);

      // Social sign-in navigates the browser out to the OAuth provider and back.
      // Wait for the redirect to return us to the site origin, accepting the
      // offered account / consent along the way, so we don't mistake the provider
      // page for a logged-in site.
      const oauthWait = await waitForLoginCompletion(page, siteOrigin, workflow);
      if (oauthWait.reason) {
        const reason = `login failed: ${oauthWait.reason}`;
        error(reason);
        results.push({ stepId: "login-verify", action: "verify-login", phase: "auth", ok: false, failed: true, error: reason, siteErrors: oauthWait.siteErrors });
        failures.push("login-verify");
      } else {
        // Login can "succeed" (the Sign in button was clicked) while the site still
        // rejects the credentials and renders an error inside the page. Surface the
        // real failure reason instead of quietly continuing into the body steps.
        const siteErrors = await detectLoginErrors(page, workflow);
        if (siteErrors.length) {
          const reason = `login failed: ${siteErrors[0]}${siteErrors.length > 1 ? ` (also: ${siteErrors.slice(1).join("; ")})` : ""}`;
          error(reason);
          results.push({ stepId: "login-verify", action: "verify-login", phase: "auth", ok: false, failed: true, error: reason, siteErrors });
          failures.push("login-verify");
        }
      }
    }
  }
  const authFailed = failures.includes("login-verify");

  // --- 1. Execute the body steps --------------------------------------------
  let dialogBroken = false;
  const stepIds = new Set(workflow.steps.map((s) => s.id));
  const dialogStepIds = new Set([
    "fill-title",
    "fill-modal-description",
    "fill-tags",
    "toggle-visibility",
    "submit-post",
  ]);
  for (const step of workflow.steps) {
    if (isStopRequested()) {
      results.push({ stepId: step.id, action: step.action, phase: "main", skipped: true, reason: "run stopped by user (Ctrl+C)" });
      break;
    }
    // If login was rejected, don't run body steps against a logged-out page —
    // report why instead of cascading meaningless per-step errors.
    if (authFailed) {
      const reason =
        results.find((r) => r.stepId === "login-verify")?.error ||
        "login failed — skipping body steps";
      results.push({ stepId: step.id, action: step.action, phase: "main", skipped: true, reason });
      continue;
    }
    // Skip optional body steps the user didn't provide content for
    // (e.g. tags, category) rather than failing on them.
    if (step.property && !isStepEligible(step, input)) {
      warn(`skipping "${step.id}" (no input provided for "${step.property}")`);
      results.push({ stepId: step.id, action: step.action, skipped: true, reason: `no value for ${step.property}` });
      continue;
    }
    // Pause automation while a "I'm not a robot" / CAPTCHA challenge needs the
    // USER. The agent keeps the window raised once, then FREEZES it so the
    // checkbox/grid stays still; it resumes the moment the user solves it.
    if (step.action === "captcha") {
      ok(`step "${step.id}": waiting for you to tick the “I'm not a robot” checkbox — solving it resumes the run automatically…`);
      await awaitCaptchaResolution(page, Number(process.env.AUTOMATOR_CAPTCHA_WAIT_MS || 150_000));
      results.push({ stepId: step.id, action: "captcha", phase: "main", ok: true });
      continue;
    }
    // If the publish dialog never opened, don't burn 45s per modal step.
    if (dialogBroken && dialogStepIds.has(step.id)) {
      results.push({ stepId: step.id, action: step.action, skipped: true, reason: "publish dialog did not open" });
      continue;
    }
    // Login steps recorded as MAIN steps (some workflows, e.g. blogfreely, keep
    // their form login in the main flow with stepType "login") assume a login
    // page shows the form. With a persistent profile that is ALREADY signed in,
    // /login redirects to the compose page where those controls never appear —
    // a 45s fill wait would fail for no reason. When the step's control isn't
    // visible after a short grace and we're back on the site origin, skip it
    // (the session is active) instead of failing.
    if (step.stepType === "login" && step.selector) {
      let loginOrigin = "";
      try { loginOrigin = new URL(workflow?.meta?.siteUrl || page.url()).origin; } catch {}
      if (loginOrigin && page.url().startsWith(loginOrigin)) {
        const loginControl = page.locator(step.selector).first();
        const loginControlVisible = await loginControl.isVisible({ timeout: 6000 }).catch(() => false);
        if (!loginControlVisible) {
          ok(`step "${step.id}" skipped: no visible "${step.selector}" — session already active, no login form on the page.`);
          results.push({ stepId: step.id, action: step.action, phase: "main", ok: true, skipped: true, reason: "login control absent — session active" });
          continue;
        }
      }
    }
    // Behance's final Publish is inert while the draft is still auto-saving.
    if (step.id === "submit-post") {
      await waitForSaveIdle(page);
    }
    // Review-then-publish mode (Behance only): fill the dialog, then STOP. The
    // user reviews the fields and clicks the final Publish themselves; we
    // detect the live gallery URL automatically. No auto-click on submit-post.
    // Other sites (e.g. sharepresentation) auto-publish — review-pausing there
    // would never complete the post.
    if (step.id === "submit-post" && input.reviewPublish && /behance/i.test(workflow.meta?.siteKey || "")) {
      ok(`step "${step.id}" paused — review the filled dialog, then click the final Publish yourself.`);
      results.push({ stepId: step.id, action: "await-review", phase: "main", ok: true, auto: true, reviewMode: true });
      continue;
    }
    // The publish dialog's description box takes a short description; the full
    // blog body lives in the Text block. Prefer shortDescription when provided.
    let execStep = step;
    if (step.id === "fill-modal-description" && input.shortDescription) {
      execStep = { ...step, property: "shortDescription" };
    }
    // Behance tags are an autocomplete: the tool types a word, waits for the
    // suggestion list, and clicks the suggestion (creating a real tag chip)
    // instead of pasting the whole string as raw text.
    if (step.id === "fill-tags" && /behance/i.test(workflow.meta?.siteKey || "")) {
      execStep = { ...step, action: "autocomplete" };
      // Behance renames/relocates its tag field between releases; the recorded
      // placeholder can go stale, and the publish modal can re-render while
      // media finishes processing (the tags row is briefly detached, or drawn
      // with a BLANK placeholder — session-specific). So poll ADAPTIVELY: each
      // pass, pick the live tags input by placeholder, by label, or by
      // position, then attempt the whole autocomplete against a fresh locator.
      const recorded = execStep.selector;
      const deadline = Date.now() + 90_000;
      const tagsProbe = () =>
        page.evaluate(() => {
          const good = (e) => (e.offsetWidth || e.offsetHeight) > 0;
          const hay = (e) =>
            [e.getAttribute("aria-label"), e.getAttribute("placeholder"), e.getAttribute("name"), (e.closest("label")?.textContent || "")].filter(Boolean).join(" ").toLowerCase();
          const all = [...document.querySelectorAll("input")].filter(good);
          let hit = null;
          const pl = all.find((e) => /10 keywords|keyword|tags?/i.test(e.getAttribute("placeholder") || ""));
          if (pl) hit = pl;
          if (!hit) {
            const labelled = all.filter((e) => /keywords|keyword|tags?/i.test(hay(e)));
            if (labelled.length) hit = labelled[labelled.length - 1];
          }
          if (!hit) {
            // Positional fallback: the tag field sits immediately after the
            // title field among the visible modal inputs.
            const titleIdx = all.findIndex((e) => /give your project a title/i.test(hay(e)));
            if (titleIdx >= 0 && all[titleIdx + 1]) {
              const next = all[titleIdx + 1];
              const nextHay = [next.getAttribute("placeholder"), next.getAttribute("aria-label"), next.getAttribute("name")].filter(Boolean).join(" ").toLowerCase();
              if (!/software|tool|co-owner|recogni|teams?/i.test(nextHay)) hit = next;
            }
          }
          if (!hit) return null;
          hit.setAttribute("data-automator-tags", "hit");
          return '[data-automator-tags="hit"]';
        }).catch(() => null);
      let tagsResult = null;
      let probedBy = null;
      while (Date.now() < deadline && !isStopRequested()) {
        let selector = null;
        if (recorded) {
          const recVis = await page.locator(recorded).first().isVisible().catch(() => false);
          if (recVis) selector = recorded;
        }
        if (!selector) selector = await tagsProbe();
        if (selector && selector !== probedBy) {
          probedBy = selector;
          execStep = { ...execStep, selector };
          if (selector !== recorded) ok(`tags input re-probed: "${selector}"`);
        }
        if (selector) {
          const vis = await page.locator(execStep.selector).first().isVisible().catch(() => false);
          if (!vis) { await page.waitForTimeout(1500); continue; }
          try {
            const outcome = await runAction(page, execStep, { input, credentials: input.credentials || {} });
            tagsResult = { stepId: step.id, action: "autocomplete", phase: "main", ok: true, ...outcome };
            break;
          } catch (e) {
            warn(`fill-tags attempt failed (${e.message.split("\n")[0]}) — re-probing and retrying...`);
            if (process.env.AUTOMATOR_DEBUG_TAGS === "1") {
              const diag = await page.evaluate(() => {
                const dialogs = [...document.querySelectorAll('[role="dialog"]')];
                const d = dialogs[0];
                const fields = (d ? [...d.querySelectorAll("input, textarea")] : []).map((e) => ({
                  t: e.tagName, ph: e.getAttribute("placeholder") || "", al: e.getAttribute("aria-label") || "",
                  w: Math.round(e.getBoundingClientRect().width) || 0,
                }));
                return {
                  dialogs: dialogs.length,
                  bodyClass: document.body.className.slice(0, 60),
                  fields,
                };
              }).catch(() => null);
              warn(`TAGS-DIAG: ${JSON.stringify(diag)}`);
            }
            await page.waitForTimeout(2500);
          }
        } else {
          await page.waitForTimeout(1500);
        }
      }
      if (!tagsResult) {
        // Tags are optional on Behance — publishing without them is fine, so a
        // content-state variant must not fail a run that already published.
        warn('tags input unavailable after 90s — skipping tags (project publishes without them).');
        tagsResult = { stepId: step.id, action: "autocomplete", phase: "main", ok: true, skipped: true, reason: "tags field absent" };
      }
      results.push(tagsResult);
      continue;
    }
    // The backlink is typed into the body editor, but sites like Behance steal
    // focus after the body is pasted. Re-focus the text block and park the
    // caret at its end so the URL always lands inside the body.
    if (step.id === "append-backlink") {
      const refocused = await focusBodyEnd(page, input.description);
      if (refocused) ok('Body editor refocused — appending the backlink at the end.');
      else warn("append-backlink: no editable body found — typing into the focused element.");
      // With an anchor keyword provided, turn the keyword inside the pasted
      // blog body into a clickable backlink (hypertext) instead of dumping the
      // raw URL as plain text.
      if (input.keyword) {
        execStep = {
          ...step,
          action: "hypertext",
          property: "keyword",
          value: input.keyword,
          url: input.backlinkUrl,
        };
      }
    }
    const before = results.length;
    results.push(await execOne(page, execStep, input, "main"));
    const done = results[results.length - 1];
    if (!done.skipped) {
      if (done.failed) error(`step "${step.id}" (${step.action}) FAILED`);
      else ok(`step "${step.id}" (${step.action})`);
    }
    if (done.failed) failures.push(step.stepId || done.stepId);
    // Gap-filling: patch over steps discovery could not record (Behance
    // creates file inputs / contenteditable editors lazily).
    if (!results[results.length - 1]?.failed && results.length === before + 1) {
      const gap = await fillGapsAfterClick(page, workflow, input, step.id, results);
      if (gap) {
        results.push(gap);
        if (gap.failed) failures.push(gap.stepId);
      }
    }
    // After any media upload, wait until Behance finishes processing the
    // image. Publish is inert until the upload is complete. Track the upload
    // step so the wait runs once right after it, not after every later step
    // (an auto-uploaded cover would otherwise stall each modal fill for the
    // full wait budget). Behance-only: other sites (e.g. sharepresentation)
    // gate their fields themselves, which the wait-for-enabled fill guard
    // already handles.
    const uploadedThisStep =
      (step.action === "upload" || step.id === "open-image" ||
        results.some((r) => r.stepId === "auto-upload-cover" && r.ok && !r.mediaWaited)) &&
      /behance/i.test(workflow.meta?.siteKey || "");
    if (uploadedThisStep) {
      await waitForMediaReady(page);
      const uploadResult = results.find((r) => r.stepId === "auto-upload-cover" || r.stepId === "open-image");
      if (uploadResult) uploadResult.mediaWaited = true;
    }
    if (step.id === "open-publish" && !dialogBroken) {
      dialogBroken = !(await ensurePublishDialog(page, workflow, stepIds));
      if (dialogBroken) {
        error("Publish dialog not available — skipping modal fields. You may need to attach media manually.");
        const photo = await screenshot(page, "publish-dialog-missing").catch(() => null);
        if (photo) warn(`Screenshot: ${photo}`);
      } else {
        ok("Publish dialog confirmed open.");
        // Best-effort auto-fills: a transient page hiccup must never abort the
        // whole run — these helpers succeed quietly or are skipped.
        try {
          const vis = await trySetVisibility(page, workflow, input);
          if (vis) results.push({ stepId: "auto-visibility", action: "click", phase: "main", ok: true, auto: true, set: vis });
        } catch (e) {
          warn(`auto-visibility skipped (${e.message.split("\n")[0]})`);
        }
        if (input.category && !stepIds.has("select-category")) {
          try {
            const cat = await trySetCategory(page, input);
            if (cat) results.push({ stepId: "auto-select-category", action: "select", phase: "main", ok: true, auto: true, set: cat });
          } catch (e) {
            warn(`auto-select-category skipped (${e.message.split("\n")[0]})`);
          }
        }
      }
    }
  }

  // Wait for Behance to finish publishing before we capture the final URL.
  const hasSubmitPost = workflow.steps.some((s) => s.id === "submit-post");
  const reviewRan =
    hasSubmitPost && input.reviewPublish && results.some((r) => r.stepId === "submit-post" && !r.skipped);
  const outcome = reviewRan
    ? await awaitManualPublish(page)
    : hasSubmitPost
      ? await waitForPublishOutcome(page, input.title)
      : // Only expensive post-publish polling for workflows that declare where
        // the live post should live. Everything else just takes the page URL.
        { galleryUrl: workflow.verification?.urlPatterns?.length ? "" : page.url() };

  return {
    workflow,
    results,
    failures,
    publishedUrl: outcome.galleryUrl || (await extractPublishedUrl(page, workflow)),
  };
}

/**
 * Behance disables the final Publish while the draft is auto-saving.
 * Wait until that spinner/modal disappears before confirming.
 */
/**
 * Re-focus the blog body editor and move the caret to its very end, so the
 * following "type backlink" step inserts the URL inside the body regardless of
 * which element currently holds focus. Picks the visible editable that best
 * matches the pasted description, else the longest one.
 */
async function focusBodyEnd(page, hint) {
  const loc = page.locator('[contenteditable]:not([contenteditable="false"]), [role="textbox"]');
  const n = await loc.count();
  let best = -1;
  let bestScore = -1;
  for (let i = 0; i < n; i++) {
    const info = await loc
      .nth(i)
      .evaluate((el) => ({
        vis: !!(el.offsetWidth || el.offsetHeight),
        text: ((el.innerText || el.value || "") + "").trim(),
      }))
      .catch(() => null);
    if (!info || !info.vis) continue;
    const hintTxt = hint ? String(hint).slice(0, 40).toLowerCase() : "";
    const hintBonus = hintTxt && info.text.toLowerCase().includes(hintTxt) ? 1_000_000 : 0;
    const score = hintBonus + info.text.length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0) return false;
  const el = loc.nth(best);
  try {
    await el.click();
    await page.keyboard.press("Control+End").catch(() => {});
  } catch {
    return false;
  }
  await page.waitForTimeout(300);
  return true;
}

async function waitForSaveIdle(page) {
  const deadline = Date.now() + 30_000;
  const saving = async () =>
    page
      .locator('button:has-text("Saving..."), [role="dialog"]:has-text("Saving as Draft"), text=Saving as Draft')
      .first()
      .isVisible()
      .catch(() => false);
  while (Date.now() < deadline && (await saving())) {
    await page.waitForTimeout(1500);
  }
}

/**
 * After the final Publish click, watch for the published project to surface:
 * navigation to /gallery/, a new-tab popup, or a success dialog carrying a
 * project link (up to 45s). Returns the real public URL when detected.
 */
async function waitForPublishOutcome(page, titleHint) {
  const host = new URL(page.url()).hostname || "";
  const isBehance = /behance\.net/i.test(host);
  let viewClicked = false;
  const deadline = Date.now() + (isBehance ? 45_000 : 30_000);
  while (Date.now() < deadline) {
    if (/\/gallery\//.test(page.url())) return { galleryUrl: page.url() };
    if (isBehance) {
      // Behance may open the published project in a new tab/popup.
      const popup = page
        .context()
        .pages()
        .find((p) => p !== page && /behance\.net\/(?!portfolio\/editor)/.test(p.url()));
      if (popup) return { galleryUrl: popup.url() };
      // The success modal's "View project" control is often a JS button rather
      // than an <a>, so extractSuccessUrl can miss it. Click it once — Behance
      // then navigates to (or opens) the live /gallery/<id>/<slug> page, which
      // the loop's URL checks capture next.
      if (!viewClicked) {
        const clicked = await clickPublishSuccessLink(page);
        viewClicked = clicked;
        if (clicked) await page.waitForTimeout(2000);
      }
    }
    // A publish-success modal/dialog usually carries a link to the project.
    const extracted = await extractSuccessUrl(page).catch(() => null);
    if (extracted) {
      ok(`Published project URL detected: ${extracted}`);
      return { galleryUrl: extracted };
    }
    // Non-Behance sites (e.g. sharepresentation) redirect to a dashboard and
    // list the just-published presentation ("View Presentation" link). Resolve
    // that row's URL once it appears instead of returning the dashboard URL.
    if (!isBehance) {
      const deck = await extractPublishedUrlFromPage(page, titleHint);
      if (deck) {
        ok(`Published presentation URL detected: ${deck}`);
        return { galleryUrl: deck };
      }
    }
    await page.waitForTimeout(1500);
  }
  return { galleryUrl: page.url() };
}

/**
 * After an auto-published post, some sites land on a dashboard/profile page
 * listing the content as a row ("View Presentation"). Pick the best link whose
 * URL looks like a content page (host-relative path with >=2 segments whose
 * first segment is a username, not a reserved chrome page), preferring one that
 * embeds the just-published title's slug. Returns null when nothing qualifies.
 * NOTE: parsed WITHOUT the browser's URL constructor — sharepresentation's
 * dashboard shadows the global URL with a non-constructor, which made
 * `new URL()` throw for every anchor.
 */
async function extractPublishedUrlFromPage(page, titleHint) {
  return page
    .evaluate((titleHint) => {
      const reserved = /^(upload|login|register|signin|signup|dashboard|panel|home|search|blog|about|privacy|terms|contact-us|contact|explore|password|logout|index|google|admin|profile|settings|presentations?|presentation|category|tag|feed|trending|embed|share|create|edit|post|slide|deck)$/i;
      const slugify = (s) =>
        String(s || "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
      const title = slugify(titleHint);
      const clean = (rel) => (rel || "").split(/[?#]/)[0].replace(/\s+$/, "").trim();
      const scored = [];
      for (const a of document.querySelectorAll("a[href], a[data-path]")) {
        const rel = a.getAttribute("data-path") || a.getAttribute("href") || "";
        const target = clean(rel);
        if (!target) continue;
        let pathname = target;
        let hostname = "";
        const hm = target.match(/^https?:\/\/([^\/]+)(\/.*)?$/i);
        if (hm) {
          hostname = hm[1].toLowerCase();
          pathname = hm[2] || "/";
        } else if (target.startsWith("//")) {
          pathname = target.split(/^\/\/[^\/]+/)[1] || "/";
          hostname = "";
        }
        if (!pathname.startsWith("/")) pathname = `/${pathname.replace(/^\//, "")}`;
        if (hostname && hostname !== location.hostname.toLowerCase()) continue;
        const seg = pathname.split("/").filter(Boolean);
        if (seg.length < 2 || reserved.test(seg[0])) continue;
        const label = (a.textContent || "").replace(/\s+/g, " ").trim();
        const cls = typeof a.className === "string" ? a.className : "";
        const isView = /view|presentation|deck|slide|ppt/i.test(label + " " + cls);
        if (!isView && !a.getAttribute("data-path")) continue;
        let score = isView ? 200 : 100;
        if (/view|open/i.test(label)) score += 20;
        if (title && pathname.includes(title)) score += 50;
        if (/#/.test(rel)) score -= 300;
        scored.push({ score, href: `${location.origin}${pathname}`, label: label.slice(0, 40) });
      }
      if (!scored.length) return null;
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      return { href: best.href, label: best.label };
    }, titleHint || "")
    .catch(() => null)
    .then((r) => (r ? r.href : null));
}

/**
 * Click a publish-success "View project" control (Behance's success modal uses
 * a JS button, not an <a>, so extractSuccessUrl can't see it). Clicking it
 * navigates to /gallery/<id>/<slug> which the publish-outcome loop then
 * captures. Returns whether something was clicked.
 */
async function clickPublishSuccessLink(page) {
  return page.evaluate(() => {
    const visible = (e) => (e.offsetWidth || e.offsetHeight) > 0;
    const precededBySuccess = (e) => {
      const root = e.closest("[role='dialog'], [aria-modal='true'], [data-testid='confirmation'], [class*='Modal'], [class*='Dialog'], [class*='Toast'], [class*='Notification']");
      if (!root) return false;
      return /(publish|published|live|success|complete|thank|congratulations|draft)/i.test(root.textContent || "");
    };
    const label = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
    const isView = (e) => /view (your )?(project|presentation)|go to (the )?(project|presentation)|view project/i.test(label(e));
    // Prefer a real <a> to a gallery URL (never the editor).
    const anchor = ([...document.querySelectorAll("a[href]")]).find(
      (e) => visible(e) && isView(e) && /\/gallery\//.test(e.getAttribute("href") || "") && !/portfolio\/editor/.test(e.getAttribute("href") || "")
    );
    if (anchor) { anchor.click(); return true; }
    // Otherwise a visible "View project" button inside a success dialog.
    const btn = ([...document.querySelectorAll("button, a[href]")]).find(
      (e) => visible(e) && isView(e) && precededBySuccess(e)
    );
    if (btn) { btn.click(); return true; }
    return false;
  }).catch(() => false);
}

/**
 * Review-then-publish helper. The dialog is fully filled and left open for the
 * user to inspect. Waits (up to AUTOMATOR_FINISH_WAIT_MS, default 60s) for the
 * user to click the final Publish, then detects the live gallery URL from a
 * success modal, /gallery/ navigation, or a new-tab popup. Pressing Enter in
 * the terminal exits the wait early once the user has finished publishing.
 */
async function awaitManualPublish(page) {
  const waitMs = Number(process.env.AUTOMATOR_FINISH_WAIT_MS || 60_000);
  const isBehance = /behance\.net/i.test(new URL(page.url()).hostname || "");
  console.log("");
  ok("Your draft is ready. Review the filled dialog in the browser:");
  console.log("  1. Click the final Publish button in the dialog.");
  console.log("  2. On the success popup, click 'View your project'.");
  console.log(
    `  Waiting up to ${Math.round(waitMs / 1000)}s — the published URL is captured the moment you do.`
  );
  const deadline = Date.now() + waitMs;
  const enterP = process.stdin.isTTY
    ? new Promise((res) => {
        const onData = (c) => {
          process.stdin.off("data", onData);
          res(true);
        };
        process.stdin.on("data", onData);
      })
    : null;
  let entered = false;
  while (Date.now() < deadline && !entered) {
    if (/\/gallery\//.test(page.url())) return { galleryUrl: page.url() };
    if (isBehance) {
      const popup = page
        .context()
        .pages()
        .find((p) => p !== page && /behance\.net\/(?!portfolio\/editor)/.test(p.url()));
      if (popup) return { galleryUrl: popup.url() };
    }
    const extracted = await extractSuccessUrl(page).catch(() => null);
    if (extracted) {
      ok(`Published project URL detected: ${extracted}`);
      return { galleryUrl: extracted };
    }
    entered = enterP ? await Promise.race([page.waitForTimeout(1500), enterP]) : (await page.waitForTimeout(1500), false);
  }
  if (entered) ok("You pressed Enter — finishing the wait.");
  else warn("Timed out waiting for the final Publish click.");
  return { galleryUrl: page.url() };
}

/**
 * Look for a publish-success dialog/toast/notification and pull the project
 * URL out of any <a> inside it. Uses generic copy ("published", "live",
 * "success") so it doesn't depend on Behance's exact wording, and only accepts
 * links that look like project pages — never nav/search/editor links.
 */
export async function extractSuccessUrl(page) {
  return page.evaluate(() => {
    const isProjectHref = (href) => {
      try {
        const u = new URL(href, location.origin);
        if (!/^https?:$/.test(u.protocol)) return false;
        if (!/(^|\.)behance\.net$/i.test(u.hostname)) return false;
        if (u.pathname === "/" || u.pathname.startsWith("/portfolio/editor")) return false;
        if (/\b(search|explore|jobs|collections|followers|overview|graph|profile|settings)\b/i.test(u.pathname)) return false;
        if (/\/gallery\//i.test(u.pathname)) return true;
        const segments = u.pathname.split("/").filter(Boolean);
        return segments.length >= 2;
      } catch {
        return false;
      }
    };
    const candidates = document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [data-testid="confirmation"], [class*="Modal"], [class*="Dialog"], [class*="Toast"], [class*="Notification"]'
    );
    for (const m of candidates) {
      const text = (m.textContent || "").toLowerCase();
      if (!/(publish|published|live|success|complete|thank|congratulations)/.test(text)) continue;
      if (!(m.offsetHeight && m.offsetWidth)) continue;
      for (const a of m.querySelectorAll("a[href]")) {
        const href = (() => { try { return a.href; } catch { return ""; } })();
        if (isProjectHref(href)) return href;
      }
    }
    return null;
  });
}

/**
 * Find the logged-in user's Behance handle from the nav avatar/profile link so
 * we can point the manual-finish phase at their profile page.
 */
export async function findProfileHandle(page) {
  return page.evaluate(() => {
    const skip = new Set([
      "adobe", "insights", "search", "explore", "jobs", "joblist", "talents",
      "resources", "collections", "followers", "following", "settings",
      "notifications", "messages", "editor", "gallery", "for_you", "recommended",
      "premium", "overview", "graph", "contact", "about", "visitor", "press",
      "terms", "privacy", "help", "feedback", "asset", "profile", "invite",
    ]);
    const suffixOk = new Set(["projects", "followers", "following", "appreciations", "collections", "contact", "stats"]);
    const verdict = (u) => {
      const seg = u.pathname.split("/").filter(Boolean);
      if (!seg.length) return null;
      const handle = seg[0];
      if (!handle || /\d/.test(handle[0]) || skip.has(handle.toLowerCase())) return null;
      if (seg.length === 1) return handle;
      if (seg.length === 2 && suffixOk.has(seg[1].toLowerCase())) return handle;
      return null;
    };
    // Prefer the nav avatar link (anchor wrapping an image).
    for (const a of document.querySelectorAll("nav a[href] img, [data-qa*=\"avatar\"] a[href], nav a img")) {
      const anchor = a.closest("a[href]");
      if (!anchor) continue;
      try {
        const u = new URL(anchor.href);
        if (/(^|\.)behance\.net$/i.test(u.hostname)) {
          const h = verdict(u);
          if (h) return h;
        }
      } catch { /* skip */ }
    }
    // Fallback: any plausible single-segment profile link.
    for (const a of document.querySelectorAll("a[href]")) {
      try {
        const u = new URL(a.href);
        if (!/(^|\.)behance\.net$/i.test(u.hostname)) continue;
        const h = verdict(u);
        if (h) return h;
      } catch { /* skip */ }
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Gap-filling helpers (engine-side resilience)
// ---------------------------------------------------------------------------

async function fillGapsAfterClick(page, workflow, input, stepId, results) {
  const stepIds = new Set(workflow.steps.map((s) => s.id));

  // Cover media: Behance creates the file input only after the Image block is
  // opened. If discovery never recorded an upload step, attach it here.
  if (/^(open-image|open-uploader|open-media)/.test(stepId) && input.imagePath && !stepIds.has("upload-cover")) {
    const attached = await tryAttachCover(page, input.imagePath);
    if (attached) {
      ok("Cover image attached (gap-filled).");
      return { stepId: "auto-upload-cover", action: "upload", phase: "main", ok: true, auto: true };
    }
    warn("Cover not auto-attached — pausing for a manual upload.");
    const done = await manualMediaTakeover(page);
    return { stepId: "manual-cover", action: "none", phase: "main", ok: done, auto: true, manualMedia: true };
  }

  // Body content: the Text block's rich-text editor is only created on click.
  // If discovery never recorded a fill-description step, paste it here.
  if (stepId === "open-text" || /^open-text/.test(stepId)) {
    if (input.description && !stepIds.has("fill-description")) {
      const done = await tryFillBody(page, String(input.description));
      if (done) {
        ok("Body content pasted into Text block (gap-filled).");
        return { stepId: "auto-fill-description", action: "fill", phase: "main", ok: true, auto: true };
      }
      return { stepId: "auto-fill-description", action: "fill", phase: "main", ok: false, auto: true, failed: true, error: "no editable body element found" };
    }
  }

  return null;
}

async function tryAttachCover(page, imagePath) {
  const abs = path.isAbsolute(imagePath) ? imagePath : path.resolve(imagePath);
  for (let attempt = 0; attempt < 3; attempt++) {
    // 1) Direct attach when a file input already exists in the DOM.
    const input = page.locator('input[type="file"]').first();
    if (await input.count()) {
      try {
        await input.setInputFiles(abs);
        await page.waitForTimeout(3500);
        return true;
      } catch {
        /* fall through to chooser interception */
      }
    }
    // 2) Click an explicit upload action and intercept the file chooser.
    const chooserP = new Promise((res) => page.once("filechooser", res));
    const btn = page
      .locator(
        'button:has-text("Choose from computer"), button:has-text("Upload from device"), button:has-text("Choose files"), button:has-text("Browse"), button:has-text("Upload"), input[type="file"]'
      )
      .first();
    if (!(await btn.count())) return false;
    try {
      await btn.first().click({ timeout: 3000 });
      const fc = await Promise.race([chooserP, new Promise((r) => setTimeout(() => r(null), 4000))]);
      if (fc) {
        await fc.setFiles(abs);
        await page.waitForTimeout(3500);
        return true;
      }
    } catch {
      /* keep trying */
    }
    await page.waitForTimeout(1500);
  }
  return false;
}

async function manualMediaTakeover(page) {
  const waitMs = Number(process.env.AUTOMATOR_MEDIA_WAIT_MS || 180_000);
  ok("MANUAL STEP: please attach/upload the cover image in the browser.");
  warn(`Waiting up to ${Math.round(waitMs / 1000)}s for the cover image…`);
  await page.waitForTimeout(4000);
  const initial = await page.evaluate(() =>
    new Set([...document.querySelectorAll("img")].filter((i) => i.src).map((i) => i.src))
  );
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = await page
      .evaluate(
        (prev) =>
          [...document.querySelectorAll("img")].some(
            (i) => i.src && !prev.has(i.src) && (i.naturalWidth || i.width) > 0
          ),
        initial
      )
      .catch(() => false);
    if (found) {
      ok("Cover image detected in the editor.");
      return true;
    }
    await page.waitForTimeout(2000);
  }
  warn("Timed out waiting for a manual cover upload.");
  return false;
}

/**
 * Wait until Behance has finished processing an uploaded image. Until then
 * the editor is busy and the Publish button does nothing. Behance reveals
 * image toolbar actions (Add Caption / Replace Image) only once processing
 * is complete.
 */
async function waitForMediaReady(page) {
  const markers = [
    'button:has-text("Add Caption")',
    'button:has-text("Replace Image")',
    'button:has-text("Delete Image")',
    'button:has-text("Reorder Project")',
  ];
  // Media processing is a live-Behance concern; keep fixtures/tests fast by
  // giving non-Behance pages only a short budget.
  const host = new URL(page.url()).hostname || "";
  const deadlineMs = /behance\.net/i.test(host) ? 90_000 : 8_000;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const sel of markers) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) {
        return true;
      }
    }
    await page.waitForTimeout(2000);
  }
  if (/behance\.net/i.test(host)) warn("Timed out waiting for media processing (Behance may be slow). Continuing anyway.");
  return false;
}

async function tryFillBody(page, text) {
  const candidates = [
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    'textarea:not([placeholder])',
    'textarea',
  ];
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    if (!(await loc.count())) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    await loc.click();
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.insertText(text);
    await page.waitForTimeout(500);
    return true;
  }
  return false;
}

async function ensurePublishDialog(page, workflow, stepIds) {
  const dialogSelectors = ["fill-title", "fill-modal-description", "fill-tags", "toggle-visibility", "submit-post"]
    .map((id) => (workflow.steps || []).find((s) => s.id === id)?.selector)
    .filter(Boolean)
    .concat([
      // Behance renames its tag field between releases; recognize a tag/keyword
      // input by label even when the recorded placeholder went stale.
      'input[aria-label*="keyword" i]',
      'input[placeholder*="keyword" i]',
      'input[aria-label*="tag" i]',
      'input[placeholder*="tag" i]',
      'input[data-automator-tags="hit"]',
    ]);
  const anyVisible = async () => {
    for (const sel of dialogSelectors) {
      if (await page.locator(sel).first().isVisible().catch(() => false)) return true;
    }
    return dialogSelectors.length === 0;
  };
  const savingUp = async () =>
    page
      .locator('[role="dialog"]:has-text("Saving as Draft"), text=Saving as Draft, button:has-text("Saving...")')
      .first()
      .isVisible()
      .catch(() => false);
  const waitBtn = workflow.steps.find((s) => s.id === "open-publish");

  // Behance's first click usually kicks off a draft save; the dialog opens on
  // a subsequent click once that save finishes. Keep clicking for up to ~45s.
  const deadline = Date.now() + 45_000;
  let clicks = 0;
  while (Date.now() < deadline) {
    if (await anyVisible()) return true;
    // Don't click while the "Saving as Draft…" modal is blocking the UI.
    if (!(await savingUp())) {
      if (waitBtn && clicks < 6) {
        const loc = await resolveClickLocator(page, waitBtn);
        await loc.first().click().catch(() => {});
        clicks += 1;
        await page.waitForTimeout(2500);
      }
    } else {
      await page.waitForTimeout(2500);
    }
    if (clicks >= 6 && !(await anyVisible())) {
      // Give the save a little more time before giving up.
      await page.waitForTimeout(4000);
    }
  }
  return anyVisible();
}

async function trySetVisibility(page, workflow, input) {
  const values = String(input.visibility || "").toLowerCase();
  if (!values) return null;
  const seen = new Set((workflow.steps || []).map((s) => s.id));
  if (seen.has("toggle-visibility")) return null;
  const pick = (values.includes("public") || values.includes("everyone") || values.includes("anyone")) ? "public" : "private";
  const radios = await page.locator('input[type="radio"]').all();
  for (const r of radios) {
    const desc = await r.evaluate((n) =>
      [n.getAttribute("aria-label"), n.getAttribute("name"), (n.closest("label")?.textContent || "")].filter(Boolean).join(" ").toLowerCase()
    );
    if (desc && desc.includes(pick)) {
      await r.click({ force: true }).catch(() => {});
      return pick;
    }
  }
  const btn = pick === "public"
    ? page.locator('button:has-text("Public"), [role="radio"]:has-text("Everyone")').first()
    : page.locator('button:has-text("Private")').first();
  if (await btn.count()) {
    await btn.first().click({ force: true }).catch(() => {});
    return pick;
  }
  return null;
}

/**
 * Pick the project category in the publish dialog. Accepts values like
 * "Branding/Technology" and selects each slash-separated token. Handles:
 *  1. A dedicated category modal (Behance: a button labelled "Open project
 *     category select modal" opens a dialog with a live search field and
 *     checkbox options), e.g. button[role="checkbox"][aria-label="Branding"].
 *  2. Plain <select> fields.
 *  3. Combobox / dropdown buttons.
 * Returns the picked label(s) or null when nothing matched.
 */
async function trySetCategory(page, input) {
  const wanted = String(input.category || "")
    .split("/")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return null;

  // --- 1. Dedicated category modal (Behance) -------------------------------
  const modalDone = await trySetCategoryViaModal(page, wanted);
  if (modalDone) return modalDone;

  // --- 2. Plain <select> field ----------------------------------------------
  const viaSelect = await page.evaluate((wanted) => {
    const haystack = (sel) =>
      [sel.getAttribute("aria-label"), sel.getAttribute("placeholder"), sel.getAttribute("name"), (sel.closest("label")?.textContent || "")].join(" ").toLowerCase();
    for (const sel of document.querySelectorAll("select")) {
      if (!(sel.offsetWidth || sel.offsetHeight)) continue; // hidden — not the real control
      if (!/categor|disciplin|field|type|industry/.test(haystack(sel))) continue;
      const options = [...sel.options].map((o) => o.textContent.trim());
      const pick = (o) => wanted.some((w) => o.toLowerCase().includes(w) || w.includes(o.toLowerCase()));
      const target = options.find(pick) || options.find((o) => o && !/select|choose|pick|none/i.test(o));
      if (target) {
        sel.value = [...sel.options].find((o) => o.textContent.trim() === target)?.value ?? target;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return target;
      }
    }
    return null;
  }, wanted);
  if (viaSelect) return viaSelect;

  // --- 3. Combobox / dropdown button ----------------------------------------
  // Behance's modal button shows only placeholder text ("How Would You
  // Categorize This Project?") once options are picked, so the modal branch
  // above is authoritative for sites matching it; this combobox branch is the
  // generic fallback for other dialog types.
  return page.evaluate(async (wanted) => {
    const pick = (txt) => {
      const a = txt.toLowerCase();
      return wanted.some((w) => a.includes(w) || (w.length > 2 && w.includes(a.slice(0, 8))));
    };
    const labelOf = (e) =>
      [e.getAttribute("aria-label"), e.getAttribute("data-testid"), e.getAttribute("data-qa"), e.getAttribute("placeholder"), (e.closest("label")?.textContent || "")].filter(Boolean).join(" ");
    const controls = [...document.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"], button')].filter(
      (e) => /categor|disciplin|field|type|industr/i.test(labelOf(e) || "")
    );
    for (const c of controls) {
      if (!(c.offsetWidth || c.offsetHeight)) continue;
      c.click();
      for (let t = 0; t < 20; t++) {
        await new Promise((r) => setTimeout(r, 120));
        const opts = [...document.querySelectorAll('[role="option"], [role="menuitem"], li[data-value]')].filter(
          (o) => o.offsetWidth || o.offsetHeight
        );
        const target = opts.find((o) => pick(o.textContent.trim()));
        if (target) {
          target.click();
          return target.textContent.trim();
        }
        if (t >= 6 && !opts.length) break;
      }
    }
    return null;
  }, wanted);
}

/**
 * Behance's category UI is a modal: a button labelled "Open project category
 * select modal" (showing "How Would You Categorize This Project?" / "View all")
 * opens a dialog with a "Search Creative Fields" input whose results are
 * checkbox rows. Type each token, click its checkbox, then close with "Done".
 */
async function trySetCategoryViaModal(page, wanted) {
  const opener = await page
    .evaluate(() => {
      const good = (e) => (e.offsetWidth || e.offsetHeight) > 0;
      const pin = (e, label) => {
        e.setAttribute("data-automator-target", label);
      };
      window.document
        .querySelectorAll("[data-automator-target]")
        .forEach((e) => e.removeAttribute("data-automator-target"));
      const hay = (e) =>
        [e.getAttribute("aria-label"), e.getAttribute("placeholder"), (e.closest("label")?.textContent || "")].filter(Boolean).join(" ").toLowerCase();
      const btn = [...document.querySelectorAll("button")].find(
        (e) => good(e) && /open project category select modal|how would you categorize this project|categorize this project/i.test(hay(e))
      );
      if (btn) pin(btn, "opener");
      return { hit: !!btn };
    })
    .catch(() => ({ hit: false }));
  if (!opener.hit) return null;

  const openBtn = page.locator('[data-automator-target="opener"]').first();
  await openBtn.click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const search = page
    .locator('[aria-label="Search Creative Fields"], input[type="search"], input[placeholder*="Creative Fields" i]')
    .first();
  if (!(await search.count())) {
    await page.keyboard.press("Escape").catch(() => {});
    return null;
  }

  const picked = [];
  for (const token of wanted) {
    await search.click({ timeout: 8000 }).catch(() => {});
    await search.press("Control+A").catch(() => {});
    await search.type(token);
    await page.waitForTimeout(1100);
    const clicked = await page
      .evaluate(({ token, picked }) => {
        const good = (e) => (e.offsetWidth || e.offsetHeight) > 0;
        const norm = (t) => (t || "").toLowerCase().replace(/\s+/g, " ").trim();
        const want = norm(token);
        const already = new Set(picked.map((p) => norm(p)));
        const cands = [...document.querySelectorAll('button[role="checkbox"], button[aria-checked]')].filter(
          (e) => good(e) && [e.getAttribute("aria-label"), e.textContent || ""].some((t) => {
            const a = norm(t);
            if (!a || a === want) return a !== "";
            return a === want || a.startsWith(want + " ");
          })
        );
        const unpicked = cands.filter((e) => !already.has(norm(e.getAttribute("aria-label") || e.textContent)));
        const pool = unpicked.length ? unpicked : cands;
        const target = pool.find((e) => e.getAttribute("aria-checked") === "false") || pool[0];
        if (!target) return null;
        target.click();
        return (target.getAttribute("aria-label") || target.textContent).trim();
      }, { token, picked })
      .catch(() => null);
    if (clicked) picked.push(clicked);
  }

  // Close the modal. Behance accepts the selection on "Done".
  const done = page
    .evaluate(() => {
      const good = (e) => (e.offsetWidth || e.offsetHeight) > 0;
      const btn = [...document.querySelectorAll('button:not([class*="disabled"])')].find(
        (e) => good(e) && (e.textContent || "").trim() === "Done"
      );
      if (!btn) return false;
      btn.click();
      return true;
    })
    .catch(() => false);
  if (done) await page.waitForTimeout(800);
  else await page.keyboard.press("Escape").catch(() => {});

  return picked.length ? picked.join(", ") : null;
}

function isStepEligible(step, input) {
  // A field step is eligible if the user provided a value for the mapped field,
  // or if it's an action with no property requirement (clicks, waits, uploads).
  // Sites like blogfreely take credentials straight from the .env/credentials.
  if (step.property === "email") return !!(input.email || input.credentials?.email);
  if (step.property === "password") return !!(input.password || input.credentials?.password);
  if (step.action === "upload") return !!(input.imagePath || input.bodyDocumentPath || input.bodyDocumentTxtPath);
  if (step.property === "image") return !!input.imagePath;
  if (step.property === "bodyDocument") return !!(input.bodyDocumentPath || input.bodyDocumentTxtPath);
  if (step.property === "backlinkUrl") return !!input.backlinkUrl;
  if (step.property === "shortDescription") return !!(input.shortDescription || input.description);
  if (step.property) {
    const value = input[step.property];
    if (step.property === "tags") return Array.isArray(value) ? value.length > 0 : !!value;
    return value !== undefined && value !== null && value !== "";
  }
  return true;
}

async function execOne(page, step, input, phase) {
  try {
    const outcome = await runAction(page, step, { input, credentials: input.credentials || {} });
    return { stepId: step.id, action: step.action, phase, ok: true, ...outcome };
  } catch (err) {
    // Workflow steps may be flagged optional: a click that targets a control
    // which only appears sometimes (e.g. JumpShare's "Duplicate" resolution
    // dialog that shows when an uploaded file name already exists) should be
    // skipped rather than failing the whole run when the control is absent.
    if (step.optional) {
      ok(`step "${step.id}" skipped: optional target absent (${err.message})`);
      return { stepId: step.id, action: step.action, phase, ok: true, skipped: true, optional: true, reason: err.message };
    }
    error(`step "${step.id}" (${step.action}) failed: ${err.message}`);
    await screenshot(page, `fail-${step.id}`).catch(() => {});
    return { stepId: step.id, action: step.action, phase, ok: false, failed: true, error: err.message };
  }
}

/**
 * After the login steps run, many sites render a rejection reason into the
 * page rather than throwing (e.g. "password is wrong" beside a form field).
 * Collect visible error text from selectors the workflow declares
 * (auth.errorSelectors) plus a few generic patterns, so the engine can report
 * WHY login failed instead of moving blindly into the body steps.
 */
async function detectLoginErrors(page, workflow) {
  const custom = (workflow.auth?.errorSelectors || [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  const generic = [
    "[data-automator-login-error]",
    "[class~='error']", "[class*='alert']", "[role='alert']", "[aria-live]",
    "[id*='error']", "[name*='error']",
  ];
  try {
    return await page.evaluate((selectors) => {
      const norm = (t) => (t || "").replace(/\s+/g, " ").trim();
      const out = new Set();
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const text = norm(el.textContent);
          if (!text || text.length > 200) continue;
          const r = el.getBoundingClientRect();
          const visible =
            el.offsetWidth > 0 || el.offsetHeight > 0 ||
            (r.width > 0 && r.height > 0) ||
            (getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden");
          if (!visible) continue;
          const kw = /password|credential|wrong|incorrect|invalid|failed|not (found|match)|denied|unauthori|did not|can'?t (sign|log|access)|authentication|expired/i;
          if (kw.test(text)) out.add(text);
        }
      }
      return [...out];
    }, [...custom, ...generic]).catch(() => []);
  } catch {
    return [];
  }
}

/**
 * Social sign-in (Google etc.) takes the browser to a different origin to
 * authorize, then redirects back. Wait up to oauthWaitMs (default 45s) for the
 * origin to return to the site; while on the provider page, keep trying to
 * accept the offered account / consent. If we never come back, or the provider
 * page itself shows a rejection ("Access denied"), return a reason for the
 * failure instead of letting the body steps run on a logged-out tab.
 */
async function waitForLoginCompletion(page, siteOrigin, workflow) {
  const deadline = Date.now() + (workflow.auth?.oauthWaitMs || 45000);
  let sawProvider = false;
  while (Date.now() < deadline) {
    let url = "";
    try { url = page.url(); } catch { return { reason: "page was closed during sign-in" }; }
    let origin = "";
    try { origin = new URL(url).origin; } catch { return {}; }
    if (siteOrigin && origin === siteOrigin) {
      if (sawProvider) await page.waitForTimeout(1500);
      return {};
    }
    sawProvider = true;
    const providerErrors = await detectLoginErrors(page, workflow);
    if (providerErrors.length) {
      return { reason: providerErrors.join(" | "), siteErrors: providerErrors };
    }
    await acceptOAuthAccount(page).catch(() => {});
    await page.waitForTimeout(1200);
  }
  let host = "the OAuth provider";
  try { host = new URL(page.url()).host; } catch {}
  return { reason: `sign-in did not complete — still on ${host} after ${workflow.auth?.oauthWaitMs || 45000}ms (browser needs a logged-in Google/social session)` };
}

/**
 * Heuristics for common OAuth provider screens: pick the first listed account
 * on the account chooser, and click Continue / Allow / Next buttons. Best-effort
 * and non-fatal — a valid browser session usually auto-completes anyway.
 */
async function acceptOAuthAccount(page) {
  return page.evaluate(() => {
    const visible = (e) => (e.offsetWidth > 0 || e.offsetHeight > 0) && getComputedStyle(e).visibility !== "hidden";
    const accounts = [...document.querySelectorAll('[data-identifier], [data-account-item], [data-id]')].filter(visible);
    if (accounts.length) { accounts[0].click(); return true; }
    for (const btn of [...document.querySelectorAll('button[role="button"], button')].filter(visible)) {
      const t = (btn.textContent || "").replace(/\s+/g, " ").trim();
      if (/^(Continue|Allow|Next|Sign in with Google)$/i.test(t)) { btn.click(); return true; }
    }
    return false;
  }).catch(() => false);
}

async function extractPublishedUrl(page, workflow) {
  const patterns = workflow.verification?.urlPatterns || [];
  const isCandidate = (url) => {
    try {
      const u = new URL(url);
      const seg = u.pathname.split("/").filter(Boolean);
      return (
        (!patterns.length || patterns.some((p) => matchesGlob(url, p))) &&
        seg.length >= 2
      );
    } catch {
      return false;
    }
  };
  let safeUrl = async () => {
    try {
      return page.url();
    } catch {
      return "";
    }
  };
  if (isCandidate(await safeUrl())) return await safeUrl();

  // Publish navigation can lag a step or two (e.g. -> blog index before the
  // specific post URL). Poll briefly for a deeper, pattern-matching URL.
  const until = Date.now() + 12_000;
  while (Date.now() < until) {
    await page.waitForTimeout(600).catch(() => {});
    const current = await safeUrl();
    if (!current) break;
    if (isCandidate(current)) return current;
  }

  // Last resort: pull the freshest same-origin link that fits the pattern so we
  // never hand back the bare blog/all-posts URL.
  const dug = await page
    .evaluate((patterns) => {
      const host = location.hostname;
      const out = [];
      for (const a of document.querySelectorAll("a[href]")) {
        const raw = (a.getAttribute("href") || "").trim();
        if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) continue;
        let full;
        try {
          full = new URL(raw, location.href).href;
        } catch {
          continue;
        }
        if (/^(mailto|tel|javascript|data|blob):/i.test(full)) continue;
        const u = new URL(full);
        if (u.hostname !== host) continue;
        if (patterns.some((p) => new RegExp(p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")).test(full)) === false) continue;
        out.push(u.href.replace(/\/$/, ""));
      }
      return out;
    }, patterns)
    .catch(() => []);
  return dug.length ? dug[0] : (await safeUrl()) || "";
}

function matchesGlob(url, pattern) {
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(url);
}