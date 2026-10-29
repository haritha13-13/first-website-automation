import { error as logError, warn } from "../common/util.js";
import { screenshot } from "../common/util.js";

/**
 * Low-level Playwright action primitives. Each action receives the current
 * page plus the step definition; unknown/unsupported actions throw so the
 * engine can record the failure.
 */

const WAIT = { timeout: 45_000 };

async function visible(page, selector) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout: WAIT.timeout });
  } catch (err) {
    throw new Error(`element not visible: ${selector} (${err.message.split("\n")[0]})`);
  }
}

/**
 * The sharepresentation upload form (and similar directory sites) keeps its
 * fields DISABLED until an uploaded document finishes processing server-side.
 * Wait for the target element to become enabled (up to a generous budget)
 * rather than failing the step the moment Playwright tries to interact with a
 * disabled control.
 */
async function waitEnabled(page, el, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await el
      .evaluate((n) => ({ disabled: n.disabled === true, readOnly: n.readOnly === true }))
      .catch(() => ({ disabled: true, readOnly: true }));
    if (!state.disabled && !state.readOnly) return;
    await page.waitForTimeout(1000);
  }
  throw new Error("element stayed disabled/readonly (is the upload finished processing?)");
}

export async function runAction(page, step, ctx) {
  const { action } = step;
  switch (action) {
    case "goto":
      return actionGoto(page, step, ctx);
    case "click":
      return actionClick(page, step, ctx);
    case "fill":
      return actionFill(page, step, ctx);
    case "select":
      return actionSelect(page, step, ctx);
    case "upload":
      return actionUpload(page, step, ctx);
    case "wait":
      return actionWait(page, step, ctx);
    case "press":
      return actionPress(page, step, ctx);
    case "type":
      return actionType(page, step, ctx);
    case "autocomplete":
      return actionAutocomplete(page, step, ctx);
    case "tags":
      return actionTokenTags(page, step, ctx);
    case "hypertext":
      return actionHypertext(page, step, ctx);
    case "check":
      return actionCheck(page, step, ctx);
    default:
      throw new Error(`unsupported action: ${action}`);
  }
}

async function actionGoto(page, step, ctx) {
  let url = step.url;
  if (step.urlTemplate) {
    const value = String(resolveValue(step.property, ctx) ?? "");
    url = step.urlTemplate.replace("{value}", encodeURIComponent(value));
  }
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: WAIT.timeout });
  await page.waitForTimeout(1500);
  return { url, navigated: true };
}

/**
 * Structural nth-child selectors drift when the page mutates (e.g. Behance
 * inserts a "Preview" button into the EDITOR nav after a media upload, which
 * shifts every child index). Only navs that gain/lose buttons need the
 * text-based click; the Site Wide nav and editor control panels are stable.
 */
export async function resolveClickLocator(page, step) {
  const text = step.text ? String(step.text).trim() : "";
  const candidates = [
    ...new Set([text, ...(step.alts || []).map((t) => String(t).trim())].filter(Boolean)),
  ];
  const selector = (step.selector || "").trim();
  // Top-right controls (Behance's editor "Publish") must be found by their
  // exact text near the top-right of the viewport. Structural selectors drift
  // and can land on a sibling like "Prototype".
  if (text && step.topRight) {
    const loc = await topRightByText(page, text);
    if (loc) return loc;
  }
  // Dialog-scoped controls (the final Publish inside the publish modal).
  if (text && step.inDialog) {
    const loc = await dialogByText(page, text);
    if (loc) return loc;
  }
  // Any step carrying a text label prefers that label over a recorded
  // structural selector — a drifting nth-child path must never click a
  // sibling control (e.g. "Prototype") when we know the intended text.
  // Retry briefly: the template may still be rendering when the step runs.
  if (candidates.length) {
    const dead = Date.now() + 4600;
    while (Date.now() < dead) {
      for (const t of candidates) {
        const ancestor = (selector.split(">")[0] || "").trim();
        const scoped = ancestor ? await clickableByText(page, t, ancestor) : null;
        if (scoped) return scoped;
        const global = await clickableByText(page, t);
        if (global) return global;
      }
      if (Date.now() >= dead) break;
      await page.waitForTimeout(700);
    }
    // Last resort: a visible control whose text *starts with* the label (the
    // label may have drifted, e.g. "Create a project" -> "Create a project…").
    for (const t of candidates) {
      if (t.length < 5) continue;
      const ancestor = (selector.split(">")[0] || "").trim();
      const loc = await clickableByPrefix(page, t, ancestor);
      if (loc) return loc;
    }
  }
  if (!selector) throw new Error(`click "${step.id}": no selector or text`);
  return page.locator(selector);
}

/**
 * Resolve the clickable element carrying `text`, walking up to an interactive
 * ancestor (button/a[href]/[role=button]/[tabindex]) and skipping zero-sized
 * matches — Behance often hides the real sized control behind a 0x0
 * accessibility node that Playwright's own getByText match would time out on.
 */
export async function clickableByText(page, text, ancestorSelector) {
  return textLocator(page, text, ancestorSelector, 0);
}

/**
 * Like clickableByText but matches controls whose text STARTS with `text`
 * (`lenient=1`). Used when the on-page label has drifted (e.g. "Create a
 * project" rendered as "Create a project…"). Exact matches always win; this is
 * only consulted after every exact candidate missed.
 */
export async function clickableByPrefix(page, text, ancestorSelector) {
  return textLocator(page, text, ancestorSelector, 1);
}

async function textLocator(page, text, ancestorSelector, lenient) {
  const sel = await page
    .evaluate(({ text, ancestorSelector, lenient }) => {
      // Playwright-visible semantics: non-empty bounding box + neither
      // display:none nor visibility:hidden. A mobile-drawer <li> hidden with
      // visibility:hidden still reports offsetWidth/offsetHeight — skipping it
      // here is what prevents clicking the WRONG hidden "Share Work" control.
      const isVisible = (e) => {
        if (!e) return false;
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const c = getComputedStyle(e);
        if (c.display === "none" || c.visibility === "hidden" || c.visibility === "collapse") return false;
        return true;
      };
      const norm = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
      const want = String(text).replace(/\s+/g, " ").trim();
      const root = ancestorSelector ? document.querySelector(ancestorSelector) : document;
      if (!root) return null;
      const matches = [...root.querySelectorAll("button, a, [role=button], [role=link], [tabindex], div, span, li")].filter(
        (e) => {
          const n = norm(e);
          return lenient ? n.startsWith(want) : n === want;
        }
      );
      if (!matches.length) return null;
      const interactive = (e) => e.closest("button, a[href], [role=button], [role=link], [tabindex]");
      const clickable = matches
        .map((e) => interactive(e) || e)
        .filter((e, i, arr) => arr.indexOf(e) === i && isVisible(e));
      if (!clickable.length) return null;
      const best = clickable.reduce((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height <= rb.width * rb.height ? a : b;
      });
      document
        .querySelectorAll("[data-automator-target]")
        .forEach((x) => x.removeAttribute("data-automator-target"));
      best.setAttribute("data-automator-target", "hit");
      return '[data-automator-target="hit"]';
    }, { text, ancestorSelector, lenient })
    .catch(() => null);
  if (!sel) return null;
  return page.locator(sel);
}

/**
 * Locate a visible control whose text matches, sitting in the top-right region
 * of the viewport (e.g. the editor's Publish button). Returns a locator tagged
 * with a temporary attribute, or null when nothing matches.
 */
export async function topRightByText(page, text) {
  const sel = await page
    .evaluate((text) => {
      const norm = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isVisible = (e) => {
        if (!e) return false;
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const c = getComputedStyle(e);
        return c.display !== "none" && c.visibility !== "hidden" && c.visibility !== "collapse";
      };
      const base = 'button, a, [role="button"], [role="link"], [tabindex]';
      let nodes = [...document.querySelectorAll(base)].filter(
        (e) => norm(e) === text && isVisible(e)
      );
      if (!nodes.length) {
        // Nested labels (e.g. <button><span>Publish</span></button>): keep the
        // deepest elements that exactly carry the label.
        const all = [...document.querySelectorAll(base + ", span, div")].filter(
          (e) => norm(e) === text && isVisible(e)
        );
        nodes = all.filter(
          (e) => ![...e.children].some((c) => norm(c) === text)
        );
      }
      if (!nodes.length) return null;
      const inTopRight = nodes.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.top >= 0 && r.top < vh * 0.4 && r.left > vw * 0.5;
      });
      const pool = inTopRight.length ? inTopRight : nodes;
      pool.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.left - ra.left || ra.top - rb.top;
      });
      document
        .querySelectorAll("[data-automator-target]")
        .forEach((e) => e.removeAttribute("data-automator-target"));
      pool[0].setAttribute("data-automator-target", "hit");
      return '[data-automator-target="hit"]';
    }, text)
    .catch(() => null);
  if (!sel) return null;
  return page.locator(sel);
}

/**
 * Locate a visible control with the given exact text inside an open modal
 * dialog (the final Publish button), ignoring lookalikes elsewhere on the page.
 */
export async function dialogByText(page, text) {
  const scopes = ['[role="dialog"]', '[aria-modal="true"]', 'section[aria-label*="Publish" i]'];
  for (const scope of scopes) {
    const dlg = page.locator(scope).filter({ hasText: text });
    if (!(await dlg.count())) continue;
    const target = dlg.last().getByText(text, { exact: true }).last();
    if (await target.count()) return target;
  }
  return null;
}

async function actionClick(page, step, ctx) {
  const loc = await resolveClickLocator(page, step);
  if (!loc) throw new Error(`click "${step.id}": could not resolve target`);
  // nav-anchored text targets may resolve to hidden labels; don't burn the
  // full 45s on them — fail fast and let the DOM fallback handle it.
  const topAncestor = (step.selector || "").trim().split(">")[0].trim();
  const timeout = /^nav(\[|$)/.test(topAncestor) ? 10_000 : WAIT.timeout;
  try {
    await loc.waitFor({ state: "visible", timeout });
    // Some sites keep the submit/enable controls disabled until an async task
    // (e.g. document conversion) finishes; wait for the click target to be
    // interactive rather than clicking a dead button.
    await waitEnabled(page, loc, timeout);
    await loc.click({ timeout });
  } catch (err) {
    // Some sites overlay a cookie banner; try to dismiss and retry once.
    await dismissCookieBanner(page);
    try {
      await loc.click({ timeout });
    } catch {
      // Playwright can refuse to click elements it deems covered/hidden even
      // though browsers accept a functional click on them — e.g. MediaFire's
      // "Upload files" button, whose own inner rich-text <div> "intercepts"
      // pointer events so the hit-target check fails. Try, in order: a
      // force-click (skips the hit-target check), a raw DOM click on the
      // resolved element, then a text-based DOM click on the nearest
      // interactive ancestor scoped to the step's nav ancestor.
      let clicked = await loc.first().click({ force: true, timeout: 10_000 }).then(() => true).catch(() => false);
      if (!clicked) {
        clicked = await loc.first().evaluate((el) => { el.click(); return true; }).catch(() => false);
      }
      if (!clicked) clicked = await domClickByText(page, step.text, topAncestor);
      if (!clicked) throw err;
    }
  }
  if (step.waitAfter) await page.waitForTimeout(Number(step.waitAfter) || 1000);
  return { clicked: true };
}

/**
 * Click an element matching `text` via a raw browser click. Walks up to the
 * nearest interactive ancestor (button/a/[role=button]/label/[tabindex]) like
 * a human would, skipping zero-size matches. Returns true if something clicked.
 */
export async function domClickByText(page, text, ancestorSelector) {
  if (!text) return false;
  return page.evaluate(({ text, ancestorSelector }) => {
    const root = ancestorSelector ? document.querySelector(ancestorSelector) : document;
    const scan = root && root.querySelectorAll
      ? root.querySelectorAll("span,button,a,[role='button'],div,li,[tabindex],label")
      : [];
    const exact = text.trim();
    const interactive = (e) =>
      e.matches("button,a,[role='button'],input,[tabindex]")
        ? e
        : e.closest("button,a,[role='button'],label,[tabindex]") || e;
    for (const e of scan) {
      if ((e.textContent || "").trim() !== exact) continue;
      const target = interactive(e) || e;
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      target.click();
      return true;
    }
    return false;
  }, { text, ancestorSelector });
}

async function actionFill(page, step, ctx) {
  const value = resolveStepValue(step, ctx);
  if (value === undefined || value === null) {
    throw new Error(`fill "${step.id || step.property}": no value for step ${JSON.stringify(step)}`);
  }
  try {
    return await doFill(page, step, ctx, String(value));
  } catch (err) {
    // Self-heal: the recorded selector can go stale (e.g. per-session UUID
    // ids on Behance). Re-probe the page for a field matching this step's
    // semantic property and retry once.
    const salvaged = await salvageFill(page, step, ctx, String(value));
    if (!salvaged) throw err;
    return salvaged;
  }
}

async function doFill(page, step, ctx, value) {
  await visible(page, step.selector);
  const el = page.locator(step.selector).first();
  const isContentEditable = await el.evaluate((n) => n.isContentEditable === true);
  await waitEnabled(page, el);
  await el.scrollIntoViewIfNeeded({ timeout: WAIT.timeout });
  if (isContentEditable) {
    await clickField(page, el);
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.insertText(value);
  } else {
    // A live dialog can briefly cover the field (open animation, sticky
    // footer, cookie banner), which makes Playwright's actionable click time
    // out even though the input is usable. fill() sets the value via DOM
    // events without demanding "receives pointer events", so use it first and
    // only fall back to a defensive click + typing when the site rejects it.
    const readBack = async () => {
      try {
        const v = await el.inputValue();
        return v === value;
      } catch {
        return false;
      }
    };
    try {
      await el.fill(value);
      if (!(await readBack())) throw new Error("fill() did not stick");
    } catch {
      await clickField(page, el);
      await page.keyboard.press("Control+A").catch(() => {});
      await page.keyboard.insertText(value);
      await page.waitForTimeout(150);
    }
  }
  if (step.pressEnterAfter) {
    await el.press("Enter");
    await page.waitForTimeout(800);
  }
  return { filled: true, value };
}

async function salvageFill(page, step, ctx, value) {
  if (!step.property) return null;
  const { collectInputs } = await import("../browser/domProbe.js");
  let inputs = [];
  try {
    inputs = await page.evaluate(collectInputs);
  } catch {
    return null;
  }
  // Only text-fillable fields; skip radios/checkboxes/files/buttons — on the
  // Behance publish dialog those would otherwise be "matched" by their labels.
  inputs = inputs.filter(
    (f) => !/^(radio|checkbox|file|button|submit|reset|hidden)$/.test(f.type || "") && f.tag !== "select"
  );
  const haystack = (f) => [f.name, f.placeholder, f.ariaLabel, f.label, f.id, f.dataPlaceholder].filter(Boolean).join(" ").toLowerCase();
  const find = (pattern) => {
    const candidates = inputs.filter((f) => pattern.test(haystack(f)) && !/title/.test(haystack(f)));
    // Prefer a plain textarea over a contenteditable rich-text body, and a
    // real input over text-bearing divs, so the publish-dialog field wins.
    return (
      candidates.find((f) => f.tag === "textarea") ||
      candidates.find((f) => f.tag === "input") ||
      candidates[0]
    );
  };
  let hit = null;
  if (step.property === "title") {
    const matches = inputs.filter((f) => /title|project name|heading/.test(haystack(f)));
    hit =
      matches.find((f) => /add.*title|give.*title|project.*title/.test(haystack(f))) ||
      matches.find((f) => f.tag === "input") ||
      matches[0];
  } else if (step.property === "description" || step.property === "shortDescription") {
    hit = find(/description|about|story|write|details|body/);
  } else if (step.property === "tags") {
    hit = find(/tag|keyword|label/);
  } else if (step.property === "email") {
    hit = inputs.find((f) => /email|username|e-mail|mail/.test(haystack(f)));
  }
  if (!hit) return null;
  const fallback = { ...step, selector: hit.selector };
  const out = await doFill(page, fallback, ctx, value);
  warn(`selector "${step.selector}" stale — re-probed and filled via "${hit.selector}"`);
  return { ...out, salvaged: true, from: step.selector, to: hit.selector };
}

async function actionSelect(page, step, ctx) {
  const value = String(step.value ?? resolveValue(step.property, ctx) ?? "");
  await visible(page, step.selector);
  const el = page.locator(step.selector).first();
  await waitEnabled(page, el);
  if (value) {
    const target = String(value).trim().toLowerCase();
    const opts = el.locator("option");
    const n = await opts.count();
    let index = -1;
    for (let i = 0; i < n && index < 0; i++) {
      const o = opts.nth(i);
      const vText = ((await o.getAttribute("value")) || "").trim().toLowerCase();
      const lText = ((await o.textContent()) || "").trim().toLowerCase();
      if (vText === target || lText === target) index = i;
    }
    if (index < 0) {
      for (let i = 0; i < n; i++) {
        const lText = ((await opts.nth(i).textContent()) || "").trim().toLowerCase();
        if (lText.includes(target)) { index = i; break; }
      }
    }
    if (index < 0) throw new Error(`option not found: ${value}`);
    await el.selectOption({ index }).catch(async () => {
      await opts.nth(index).evaluate((o) => {
        o.selected = true;
        o.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
  }
  return { selected: value };
}

async function actionUpload(page, step, ctx) {
  const filePath = resolveValue(step.property === "image" ? "imagePath" : step.property, ctx);
  if (!filePath) throw new Error(`upload "${step.id}": no file path provided`);
  const loc = page.locator(step.selector);
  // File inputs are commonly hidden behind a styled label/dropzone (DocHub's
  // #ember*-upload-document is display:none; the clickable element is the
  // label). setInputFiles works on a hidden input, so wait for it to be
  // ATTACHED rather than visible — demanding "visible" timed out and made the
  // whole upload (and everything after it) fail. Prefer a visible input when
  // the page renders several (e.g. MediaFire's dialog), else use the first.
  try {
    await loc.first().waitFor({ state: "attached", timeout: WAIT.timeout });
  } catch (err) {
    throw new Error(`upload "${step.id}": no ${step.selector} present (${err.message.split("\n")[0]})`);
  }
  let el = null;
  const count = await loc.count();
  for (let i = 0; i < count; i++) {
    const cand = loc.nth(i);
    if (await cand.isVisible().catch(() => false)) { el = cand; break; }
  }
  if (!el) el = loc.first();
  await el.setInputFiles(filePath);
  if (step.waitAfter) await page.waitForTimeout(Number(step.waitAfter) || 4000);
  return { uploaded: filePath };
}

async function actionWait(page, step, ctx) {
  if (step.untilURLRegExp) {
    const re = new RegExp(step.untilURLRegExp);
    const until = Number(step.timeoutMs || step.timeout || 20_000);
    const deadline = Date.now() + until;
    while (Date.now() < deadline) {
      const current = page.url();
      if (re.test(current)) {
        if (step.waitAfter) await page.waitForTimeout(Number(step.waitAfter) || 1000);
        return { waited: true, url: current };
      }
      await page.waitForTimeout(700);
    }
    throw new Error(`wait "${step.id}": URL never matched ${step.untilURLRegExp} (current: ${page.url()})`);
  }
  if (step.untilVisible) {
    await visible(page, step.untilVisible);
  } else if (step.timeout) {
    await page.waitForTimeout(Number(step.timeout));
  } else {
    await page.waitForTimeout(2000);
  }
  return { waited: true };
}

async function actionPress(page, step, ctx) {
  await page.keyboard.press(step.key || "Enter");
  if (step.waitAfter) await page.waitForTimeout(Number(step.waitAfter) || 800);
  return { pressed: step.key || "Enter" };
}

/**
 * Types text into whatever is currently focused (works on rich-text /
 * contenteditable editors). Used to inject the backlink URL at the end of
 * the blog content.
 */
async function actionType(page, step, ctx) {
  const value = String(step.value ?? resolveValue(step.property, ctx) ?? "");
  if (!value) {
    throw new Error(`type "${step.id}": no text to type`);
  }
  if (step.goToEnd) await page.keyboard.press("Control+End").catch(() => {});
  if (step.prefixNewline) await page.keyboard.press("Enter").catch(() => {});
  const text = step.prefixNewline ? `\n${value}` : value;
  await page.keyboard.insertText(text);
  if (step.waitAfter) await page.waitForTimeout(Number(step.waitAfter) || 600);
  return { typed: text.slice(0, 60) + (text.length > 60 ? "…" : "") };
}

/**
 * Click a field defensively: scroll it into view, try a normal Playwright
 * click, then a force-click, and finally a raw DOM click + focus. Live sites
 * sometimes cover the tags input (sticky dialog footer/overlay) which makes
 * Playwright's actionability checks fail even though the field is usable.
 */
async function clickField(page, el) {
  try {
    await el.scrollIntoViewIfNeeded({ timeout: 10_000 });
  } catch {}
  try {
    await el.click({ timeout: 15_000 });
    return true;
  } catch {}
  try {
    await el.click({ force: true, timeout: 10_000 });
    return true;
  } catch {}
  return el.evaluate((n) => {
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    n.focus();
    n.click();
    return true;
  });
}

/**
 * Behance-style tag autocomplete: type a tag word (real keystrokes so the
 * suggestion list appears), then click the visible suggestion — the tag is
 * committed by the site as a chip instead of pasting raw text. Falls back to
 * Enter when no suggestion is offered so a plain input still works.
 */
async function actionAutocomplete(page, step, ctx) {
  const raw = step.value ?? resolveValue(step.property, ctx);
  const tokens = (Array.isArray(raw) ? raw : String(raw || "").split(/[,\n]/))
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) throw new Error(`autocomplete "${step.id}": no tags to type`);
  await visible(page, step.selector);
  const picked = [];
  for (const token of tokens) {
    // Behance re-renders its Vue tags input after the first chip commits, which
    // detaches the placeholder-scoped element we started with. Re-resolve the
    // LIVE input inside the tags component before EVERY word so the next token
    // can never land on a stale/detached node (and never merge into a previous
    // word's residue).
    const live = await page.evaluate(() => {
      const vis = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 8 && r.height > 8 && getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden";
      };
      const inTagger = (e) => !!e.closest(".ti-input, .vue-tags-input, [class*='ti-input']");
      const bad = (e) => /recogni|belong|co-owner|team|credits|tools used/i.test(
        [e.getAttribute("placeholder") || "", e.getAttribute("aria-label") || "", (e.closest("label")?.textContent || "")].join(" ")
      );
      const inputs = [...document.querySelectorAll("input")].filter((e) => vis(e) && inTagger(e) && e.type !== "file");
      let pick = inputs.find((e) => e.value === "" && !bad(e)) || inputs.find((e) => !bad(e)) || inputs[0];
      if (!pick) return "";
      pick.setAttribute("data-automator-livetags", "");
      return '[data-automator-livetags]';
    }).catch(() => "");
    if (!live) throw new Error(`autocomplete "${step.id}": live tags input not found`);
    const el = page.locator(live).first();
    if (!(await clickField(page, el))) {
      throw new Error(`autocomplete "${step.id}": tags input not clickable`);
    }
    await clearField(page, el);
    await el.type(token);
    await page.waitForTimeout(700);
    const choice = await clickSuggestion(page, token);
    if (choice) picked.push(choice);
    else await el.press("Enter").catch(() => {});
    await page.waitForTimeout(350);
    // Wipe any residue the commit left behind (a failed Enter leaves the raw
    // word in the input; the next word must start from an empty field). The
    // clear below is guarded so it only deletes TEXT — never a chip.
    await clearField(page, el).catch(() => {});
  }
  await page.evaluate(() => { window.__automatorTagsDone = true; }).catch(() => {});
  return { typed: tokens.join(", "), picked, count: picked.length };
}

/**
 * Deterministically empty a tag/autocomplete input: focus it, select every
 * character and delete it. Every token starts (and leaves) a clean input, so
 * separate words can never concatenate into one tag.
 */
async function clearField(page, el) {
  try {
    await clickField(page, el);
    const value = await el.inputValue().catch(() => "");
    // Empty input → do nothing. Pressing Backspace on an empty field makes
    // Vue Tags Input delete its LAST CHIP instead of text (which silently
    // wiped every previously committed tag). Only delete when there is real
    // residue text to remove, so each word always starts clean but chips
    // survive.
    if (!value) return;
    await page.keyboard.press("Control+A").catch(() => {});
    await el.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
  } finally {
    await page.waitForTimeout(60);
  }
}

/**
 * Tokenfield-style tags (Bootstrap tokenfield, tag inputs, etc.): each tag is
 * typed into the visible autocomplete input and committed with Enter — the
 * widget turns it into a chip and keeps the hidden comma-separated value field
 * in sync (e.g. sharepresentation's #tags + #tags-tokenfield.tt-input).
 */
async function actionTokenTags(page, step, ctx) {
  const raw = step.value ?? resolveValue(step.property, ctx);
  const tokens = (Array.isArray(raw) ? raw : String(raw || "").split(/[,\n]/))
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) throw new Error(`tags "${step.id}": no tags to enter`);
  await visible(page, step.selector);
  const el = page.locator(step.selector).first();
  await waitEnabled(page, el);
  const entered = [];
  for (const token of tokens) {
    if (!(await clickField(page, el))) {
      throw new Error(`tags "${step.id}": tags input not clickable`);
    }
    await clearField(page, el);
    await el.type(token, { delay: 30 });
    await page.waitForTimeout(250);
    // Commit the tag: Enter on the tokenfield input; fall back to a click on a
    // visible suggestion when one popped up.
    const suggestion = await clickSuggestion(page, token).catch(() => null);
    if (!suggestion) await el.press("Enter").catch(() => {});
    await page.waitForTimeout(350);
    // Leave a clean input so the next word can never merge into this one.
    await clearField(page, el).catch(() => {});
    entered.push(token);
  }
  return { typed: entered.join(", "), count: entered.length };
}

async function clickSuggestion(page, token) {
  return page.evaluate((token) => {
    const pods = document.querySelectorAll(
      '[role="listbox"], [class*="uggest"], [id*="uggest"], [data-testid*="uggest"]'
    );
    const nodes = [];
    for (const p of pods) {
      if (!(p.offsetWidth || p.offsetHeight)) continue; // only live suggestion pods
      nodes.push(...p.querySelectorAll('[role="option"], li, [data-tag], button'));
    }
    const visible = nodes.filter((e) => e.offsetWidth || e.offsetHeight);
    const t = token.toLowerCase();
    const text = (e) => (e.textContent || "").trim();
    const startsWith = visible.find((e) => text(e).toLowerCase().startsWith(t));
    const contains = visible.find((e) => text(e).toLowerCase().includes(t));
    const match = startsWith || contains;
    if (!match) return null;
    match.click();
    return text(match);
  }, token);
}

/**
 * Turn a keyword inside the pasted blog body into a clickable backlink. Behance
 * (and most rich-text editors) use a contenteditable block, so the keyword is
 * selected via a DOM Range and wrapped in an anchor with
 * document.execCommand("createLink"), which keeps the editor's undo/redo and
 * autosave in sync — a plain insertHTML() would bypass the editor's model.
 * Falls back to a direct DOM wrap when execCommand is unavailable.
 */
async function actionHypertext(page, step, ctx) {
  const keyword = step.value ?? resolveValue(step.property, ctx);
  const url = step.url ?? resolveValue("backlinkUrl", ctx);
  if (!keyword || !url) throw new Error(`hypertext "${step.id}": keyword and backlink URL required`);
  const kw = String(keyword).trim();
  const wrapped = await wrapKeywordInBody(page, kw, String(url).trim());
  if (step.waitAfter) await page.waitForTimeout(Number(step.waitAfter) || 500);
  return { keyword: kw, url: String(url).trim(), linked: wrapped };
}

/**
 * Find the first occurrence of `keyword` in the visible rich-text body block
 * (the blog body editor) and wrap it in an anchor pointing at `url`. Returns
 * true when a link was created. Works across text nodes (a keyword can be
 * split by markup) using execCommand("createLink") on a Range selection.
 */
export async function wrapKeywordInBody(page, keyword, url) {
  return page
    .evaluate(
      ({ keyword, url }) => {
        const norm = (s) => String(s || "").toLowerCase();
        const kw = norm(keyword);
        const anchorWord = (String(keyword).trim().split(/\s+/)[0] || "").trim();
        const editors = [...document.querySelectorAll('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')]
          .filter((e) => (e.offsetWidth || e.offsetHeight) > 0)
          .sort((a, b) => b.textContent.length - a.textContent.length);

        // Locate the keyword (case-insensitively) across text nodes: returns
        // the text node + offset where the keyword starts, plus the position
        // just past its FIRST WORD (the only part that becomes a link).
        const locate = (ed) => {
          const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
          const nodes = [];
          let n;
          while ((n = walker.nextNode())) if (n.nodeValue) nodes.push(n);
          const parts = [];
          let acc = 0;
          for (const node of nodes) {
            const len = norm(node.nodeValue).length;
            parts.push({ node, start: acc, len });
            acc += len;
          }
          const whole = nodes.map((node) => norm(node.nodeValue)).join("");
          const s = whole.indexOf(kw);
          if (s < 0) return null;
          if (!anchorWord) return null;
          // Absolute offset -> owning text node. `pos` may be "just past the
          // last char" (== whole.length) or exactly at a node boundary; the
          // boundary resolves to the START of the next node, i.e. a zero-width
          // end, which is a valid Range end.
          const at = (pos) => {
            for (const p of parts) {
              if (pos >= p.start && pos < p.start + p.len) return { node: p.node, off: pos - p.start };
            }
            const last = parts[parts.length - 1];
            if (pos === whole.length && last) return { node: last.node, off: last.len };
            return null;
          };
          // Anchor = the first word INSIDE the keyword occurrence (so leading
          // spaces before it are not linked); compute its exact span.
          const m = whole.slice(s).match(/^\s*(\S+)/);
          if (!m) return null;
          const anchorLen = m[1].length;
          const aStart = s + m[0].length - anchorLen;
          const aEnd = aStart + anchorLen;
          const start = at(aStart);
          const end = at(aEnd);
          if (!start || !end) return null;
          return { node: start.node, off: start.off, endNode: end.node, endOff: end.off, anchorLen };
        };

        const anchored = (ed) => (ed.querySelector("a") ? [...ed.querySelectorAll("a")].some((a) => (a.href || "") === url) : false);

        // Try the editor-aware execCommand path first; many rich-text editors
        // (e.g. Behance) rebuild the DOM from their own model, so a raw DOM
        // insert would be thrown away. execCommand keeps their state in sync.
        const tryExecCommand = (ed, item) => {
          try {
            const range = document.createRange();
            range.setStart(item.node, item.off);
            range.setEnd(item.endNode, item.endOff);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
            ed.focus();
            document.execCommand("createLink", false, url);
            return anchored(ed);
          } catch {
            return false;
          }
        };

        // Direct DOM fallback: split the text node so the anchor word becomes
        // its own node, wrap it in an anchor, and splice it back in place. The
        // remaining words of the keyword stay as plain text.
        const domWrap = (ed, item) => {
          try {
            const kwNode = item.node.splitText(item.off);
            const kept = kwNode.splitText(item.anchorLen ?? (item.endOff - item.off));
            if (item.unshiftNode) ed.insertBefore(kept, item.unshiftNode);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.rel = "noopener";
            anchor.target = "_blank";
            anchor.textContent = kwNode.nodeValue;
            kwNode.parentNode.insertBefore(anchor, kwNode);
            return true;
          } catch {
            return false;
          }
        };

        for (const ed of editors) {
          const item = locate(ed);
          if (!item) continue;
          if (tryExecCommand(ed, item)) return true;
          if (domWrap(ed, item)) return true;
        }
        return false;
      },
      { keyword, url }
    )
    .catch(() => false);
}

async function actionCheck(page, step, ctx) {
  await visible(page, step.selector);
  const el = page.locator(step.selector).first();
  const tag = await el.evaluate((n) => n.tagName.toLowerCase());
  try {
    if (tag === "input") await el.check();
    else await el.click();
  } catch {
    await el.click();
  }
  if (step.waitAfter) await page.waitForTimeout(Number(step.waitAfter) || 500);
  return { checked: true };
}

function resolveValue(property, ctx) {
  if (!property) return undefined;
  if (property === "title") return ctx.input?.title;
  if (property === "description") return ctx.input?.description;
  if (property === "shortDescription") return ctx.input?.shortDescription || ctx.input?.description;
  if (property === "tags") return Array.isArray(ctx.input?.tags) ? ctx.input.tags.join(", ") : ctx.input?.tags;
  if (property === "category") return ctx.input?.category;
  if (property === "visibility") return ctx.input?.visibility;
  if (property === "imagePath") return ctx.input?.imagePath;
  if (property === "bodyDocument") return ctx.input?.bodyDocumentPath || ctx.input?.bodyDocumentTxtPath;
  if (property === "backlinkUrl") return ctx.input?.backlinkUrl;
  if (property === "websiteName") return ctx.input?.websiteName;
  if (property === "keyword") return ctx.input?.keyword;
  if (property === "username") return ctx.input?.username ?? ctx.credentials?.username;
  if (property === "email") return ctx.credentials?.email ?? ctx.input?.email;
  if (property === "password") return ctx.credentials?.password ?? ctx.input?.password;
  return ctx[property] ?? ctx.input?.[property];
}

/**
 * A step requiring an auto-backlink (step.autoLink) rewrites the resolved text
 * so every occurrence of the anchor KEYWORD becomes a hyperlink pointing at the
 * backlink URL (the "backlinks" input). When no keyword/URL is provided, or the
 * keyword is not inside the content, the text is pasted unchanged.
 */
function applyAutoLink(value, ctx) {
  if (typeof value !== "string") return value;
  const keyword = (ctx.input?.keyword || "").trim();
  const url = (ctx.input?.backlinkUrl || "").trim();
  if (!keyword || !url || !value) return value;
  // Link ONLY the first word of the anchor keyword, at its FIRST occurrence in
  // the content. Other occurrences (and the rest of a multi-word keyword) stay
  // as plain text — one backlink, not a whole paragraph of them.
  const firstWord = (keyword.split(/\s+/)[0] || "").trim();
  if (!firstWord) return value;
  const lo = value.toLowerCase();
  const kwAt = lo.indexOf(keyword.toLowerCase());
  if (kwAt < 0) return value;
  // The keyword's first word must begin exactly where the keyword does.
  if (lo.slice(kwAt, kwAt + firstWord.length) !== firstWord.toLowerCase()) return value;
  const link = `<a href="${url}" rel="nofollow">${firstWord}</a>`;
  return value.slice(0, kwAt) + link + value.slice(kwAt + firstWord.length);
}

function resolveStepValue(step, ctx) {
  let value = step.value ?? resolveValue(step.property, ctx);
  // Some sites (e.g. blogfreely) have no dedicated title field: the post title
  // is taken from a first line "SEO TITLE: ..." in the body editor. When the
  // step opts in, prepend that line from the given title (only if not already
  // present) so the published post carries the user's title.
  if (step.prependSeoTitle && ctx.input?.title && typeof value === "string" && value.trim()) {
    if (!/^seo[\s-]?title:/i.test(value.trimStart())) {
      value = `SEO TITLE: ${String(ctx.input.title).trim()}\n\n${value}`;
    }
  }
  if (step.autoLink) value = applyAutoLink(value, ctx);
  return value;
}

async function dismissCookieBanner(page) {
  try {
    for (const btn of ["button:has-text('Accept')", "button:has-text('Accept all')", "button:has-text('I Accept')", "[data-testid='cookie-banner-accept']"]) {
      const el = page.locator(btn).first();
      if (await el.count()) {
        await el.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(400);
        return;
      }
    }
  } catch {}
}

export async function debugPage(page, step) {
  await screenshot(page, step?.id || "debug");
}

export { logError };