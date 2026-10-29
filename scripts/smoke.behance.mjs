import fs from "node:fs";
process.env.AUTOMATOR_HEADLESS = "1";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser, newPage, closeBrowser } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";
import { resolveClickLocator } from "../src/actions/actions.js";

const fixture = new URL("./fixtures/behance.html", import.meta.url);
const pageUrl = pathToFileURL(fixture.pathname).href;
const tmpImg = path.join(os.tmpdir(), `smoke-cover-${Date.now()}.jpg`);
fs.writeFileSync(tmpImg, "fake jpeg bytes");

// Mimics the gap-filled behance-net.workflow.json: deliberately WITHOUT
// upload-cover and fill-description steps, so the engine's gap-filling
// (cover attach + body paste) is exercised.
const workflow = {
  meta: { siteName: "BehanceLike", siteUrl: "https://behance.net", siteKey: "behance-net" },
  auth: { required: false, loginSteps: [] },
  fieldMappings: {
    title: "fill-title",
    tags: "fill-tags",
    backlinkUrl: "append-backlink",
    category: "select-category",
  },
  steps: [
    { id: "goto-form", action: "goto", url: pageUrl },
    // Live Behance labels this "Create a project" (older fixtures: "Share
    // Work"). The text label + alts must resolve the nav control by name, not
    // the stale structural path.
    { id: "open-create-0", action: "click", selector: 'nav[aria-label="Site Wide"] > :nth-child(1)', text: "Create a project", alts: ["Share Work"], waitAfter: 300 },
    { id: "open-image", action: "click", selector: "#btn-image", text: "Image", waitAfter: 300 },
    { id: "open-text", action: "click", selector: "#btn-text", text: "Text", waitAfter: 300 },
    { id: "append-backlink", action: "type", property: "backlinkUrl", goToEnd: true, prefixNewline: true, waitAfter: 500 },
    // Project Editor nav: after the image upload Behance inserts "Preview",
    // so this structural target (:nth-child(1) = Preview) is WRONG on purpose —
    // the open-publish click must resolve to the exact-text "Publish" instead.
    { id: "open-publish", action: "click", selector: 'nav[aria-label="Project Editor"] > :nth-child(1)', text: "Publish", waitAfter: 500 },
    { id: "fill-title", action: "fill", selector: 'input[aria-label="Give your project a title"]', property: "title", waitAfter: 200 },
    { id: "fill-modal-description", action: "fill", selector: 'textarea[aria-label="Description"]', property: "description", waitAfter: 200 },
    { id: "fill-tags", action: "fill", selector: 'input[placeholder="Add up to 10 keywords to help people discover your project"]', property: "tags", waitAfter: 200 },
    { id: "submit-post", action: "click", selector: "#btn-confirm-publish", text: "Publish", inDialog: true, waitAfter: 800 },
  ],
};

const input = {
  title: "Gap-filled title",
  description: "Blog body pasted into the Text block. Speedbots platform is the keyword phrase that links back to the target site.",
  shortDescription: "Short blurb for the publish dialog.",
  category: "Branding/Technology",
  tags: ["ai", "automation"],
  visibility: "public",
  imagePath: tmpImg,
  backlinkUrl: "https://speedbots.io/example",
  keyword: "Speedbots platform",
  credentials: null,
};

const EXP_TAGS = ["AI Automation", "Automation Solutions"];

// One shared browser with a fresh context+page per scenario. Multiple
// sequential chromium.launch() calls are flaky in constrained containers;
// isolated contexts are sufficient for our fixtures. The engine's review wait
// must stay short here.
process.env.AUTOMATOR_FINISH_WAIT_MS = "5000";

const browser = await launchBrowser();

async function runScenario(fn) {
  const { page, context } = await newPage(browser);
  try {
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

try {
  // -------------------------------------------------------------------------
  // 1. Main flow: gap-filled upload + body paste, top-right Publish click,
  //    dialog auto-fill, final dialog-scoped Publish click, gallery URL.
  // -------------------------------------------------------------------------
  const result = await runScenario(async (page) => {
    const res = await executeWorkflow({ workflow, input, page });
    const capturedState = await page.evaluate(() => window.__captured);
    const confirmedState = await page.locator('[data-testid="confirmation"]').isVisible().catch(() => false);
    return { res, capturedState, confirmedState };
  });

  console.log("\n--- step results ---");
  let allOk = true;
  for (const r of result.res.results) {
    const flag = r.ok ? "ok " : "FAIL";
    if (r.skipped) console.log(` [skip] ${r.stepId.padEnd(20)} (${r.reason})`);
    else {
      if (!r.ok) allOk = false;
      const auto = r.auto ? " (auto)" : "";
      console.log(` [${flag}] ${r.stepId.padEnd(20)} ${r.action}${auto}`);
    }
  }
  console.log(`\nfailures: ${result.res.failures.join(", ") || "none"}`);

  const captured = result.capturedState;
  const confirmed = result.confirmedState;
  console.log("\n--- state captured by page ---");
  console.log(JSON.stringify(captured, null, 2));
  const bodyHasBacklink = (captured.body || "").includes(input.backlinkUrl) ||
    (captured.bodyHtml || "").includes(`href="${input.backlinkUrl}"`);
  const backlinkAnchor = (captured.bodyHtml || "").match(/<a[^>]*href="[^"]*"[^>]*data-automator-link="1"[^>]*>/);
  const backlinkAnchors = [...(captured.bodyHtml || "").matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .map((m) => ({ href: m[1], text: m[2].trim() }))
    .filter((a) => a.href === input.backlinkUrl);
  const anchorWord = input.keyword.trim().split(/\s+/)[0];
  const singleWordLink = backlinkAnchors.length === 1 &&
    backlinkAnchors[0].text === anchorWord &&
    !/\s/.test(backlinkAnchors[0].text);
  console.log(`\nconfirmation visible: ${confirmed}`);
  console.log(`backlink in body: ${bodyHasBacklink}`);
  console.log(`backlink anchor present: ${backlinkAnchor ? backlinkAnchor[0] : "no"}`);

  // -------------------------------------------------------------------------
  // 2. Review-then-publish scenario: submit-post must NOT be auto-clicked. The
  //    fixture (?autoConfirm=ms) mimics the human: it waits until the dialog is
  //    open and every field is filled, then clicks the final Publish itself.
  //    The engine must wait for that click and capture the live gallery URL.
  // -------------------------------------------------------------------------
  const reviewWorkflow = structuredClone(workflow);
  reviewWorkflow.steps[0] = { ...reviewWorkflow.steps[0], url: pageUrl + "?autoConfirm=600" };
  const reviewInput = { ...input, reviewPublish: true };
  const review = await runScenario(async (page) => {
    const res = await executeWorkflow({ workflow: reviewWorkflow, input: reviewInput, page });
    const captured2 = await page.evaluate(() => window.__captured);
    return { res, captured2 };
  });

  console.log("\n--- review-mode step results ---");
  for (const r of review.res.results) {
    const flag = r.ok ? "ok " : "FAIL";
    const auto = r.auto ? ` (${r.action}${r.reviewMode ? " /review" : ""})` : "";
    console.log(` [${flag}] ${r.stepId.padEnd(20)} ${r.action}${auto}`);
  }

  const reviewChecks = {
    "review: no auto final publish click": review.res.results.some(
      (r) => r.stepId === "submit-post" && r.reviewMode && !r.failed
    ),
    "review: dialog filled & visible while waiting": review.captured2.reviewDialogObserved === true,
    "review: fields persisted into publish": review.captured2.title === input.title &&
      review.captured2.shortDesc === input.shortDescription &&
      JSON.stringify(review.captured2.tags || []) === JSON.stringify(EXP_TAGS) &&
      review.captured2.category === "Branding" &&
      review.captured2.visibility === "public",
    "review: published URL captured after click": review.res.publishedUrl === "https://www.behance.net/gallery/200000001/",
  };

  let pass2 = true;
  console.log("");
  for (const [label, ok] of Object.entries(reviewChecks)) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) pass2 = false;
  }

  // -------------------------------------------------------------------------
  // 3. Category combobox scenario: Behance's real category UI is a dropdown
  //    (role=combobox), not a <select>. Force that UI in the fixture and
  //    require the engine to open the combo and click the matching option.
  // -------------------------------------------------------------------------
  let catStep;
  let captured3;
  await runScenario(async (page) => {
    const catWorkflow = structuredClone(workflow);
    catWorkflow.steps = [
      { ...workflow.steps[0], url: pageUrl + "?categoryUI=combobox" },
      { id: "open-publish", action: "click", selector: 'nav[aria-label="Project Editor"] > :nth-child(1)', text: "Publish", waitAfter: 500 },
    ];
    catWorkflow.fieldMappings = { category: "select-category" };
    const catRes = await executeWorkflow({ workflow: catWorkflow, input: { ...input, tags: [], description: "" }, page });
    captured3 = await page.evaluate(() => window.__captured);
    catStep = catRes.results.find((r) => r.stepId === "auto-select-category");
  });
  const catChecks = {
    "category combobox opened & clicked:": !!catStep && catStep.ok && catStep.set === "Branding" && captured3.categoryChanged === "Branding",
  };
  let pass3 = true;
  for (const [label, ok] of Object.entries(catChecks)) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) pass3 = false;
  }

  // -------------------------------------------------------------------------
  // 4. Covered tags input scenario: like a live Behance overlay, the tags input
  //    is covered so Playwright's normal click can't reach it — the engine must
  //    fall back to a DOM click + focus and still pick every tag suggestion.
  // -------------------------------------------------------------------------
  const coverChecks = {
    "tags picked under overlay:   ": false,
  };
  await runScenario(async (page) => {
    const coverWorkflow = structuredClone(workflow);
    coverWorkflow.steps = [
      { ...workflow.steps[0], url: pageUrl + "?tagsCovered=1" },
      { id: "open-publish", action: "click", selector: 'nav[aria-label="Project Editor"] > :nth-child(1)', text: "Publish", waitAfter: 500 },
      { id: "fill-tags", action: "fill", selector: 'input[placeholder="Add up to 10 keywords to help people discover your project"]', property: "tags", waitAfter: 200 },
    ];
    coverWorkflow.fieldMappings = { tags: "fill-tags" };
    const coverRes = await executeWorkflow({ workflow: coverWorkflow, input: { ...input, shortDescription: "x", category: "", description: "" }, page });
    const captured4 = await page.evaluate(() => window.__captured);
    const tagStep = coverRes.results.find((r) => r.stepId === "fill-tags");
    coverChecks["tags picked under overlay:   "] = JSON.stringify(captured4.pickedTags || []) === JSON.stringify(EXP_TAGS) && tagStep?.ok;
  });
  let pass4 = true;
  for (const [label, ok] of Object.entries(coverChecks)) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) pass4 = false;
  }

  // -------------------------------------------------------------------------
  // 5. Top-right Publish scenario: the editor nav holds a "Prototype" button
  //    that a stale structural selector would hit, while the real Publish sits
  //    in the top-right corner. The engine must click the top-right Publish and
  //    NEVER the Prototype, then fill title/tags.
  // -------------------------------------------------------------------------
  const trUrl = pathToFileURL(new URL("./fixtures/publish-topright.html", import.meta.url).pathname).href;
  const trWorkflow = {
    meta: { siteName: "BehanceLike", siteUrl: "https://behance.net", siteKey: "behance-net" },
    auth: { required: false, loginSteps: [] },
    fieldMappings: { title: "fill-title", tags: "fill-tags" },
    steps: [
      { id: "goto", action: "goto", url: trUrl },
      // Recorded structural selector now points at "Prototype"; the text label
      // must win so the real Text control is clicked instead.
      { id: "open-text", action: "click", selector: 'nav[aria-label="Project Editor"] > :nth-child(4) > :nth-child(3)', text: "Text", waitAfter: 200 },
      { id: "open-publish", action: "click", selector: "", text: "Publish", topRight: true, waitAfter: 800 },
      { id: "fill-title", action: "fill", selector: 'input[aria-label="Give your project a title"]', property: "title", waitAfter: 200 },
      { id: "fill-tags", action: "fill", selector: 'input[placeholder="Add up to 10 keywords to help people discover your project"]', property: "tags", waitAfter: 200 },
    ],
  };
  const trChecks = {
    "prototype NOT clicked:       ": false,
    "drifted selector -> Text:    ": false,
    "top-right Publish clicked:   ": false,
    "dialog final Publish scoped: ": false,
    "title+tags auto-filled:      ": false,
  };
  await runScenario(async (page) => {
    await executeWorkflow({
      workflow: trWorkflow,
      input: { ...input, shortDescription: "", description: "", category: "", tags: ["ai", "automation"] },
      page,
    });
    // Dialog-scoped final Publish must resolve inside the modal, not top bar.
    const dialogPublish = await resolveClickLocator(page, { id: "submit-post", text: "Publish", inDialog: true });
    if (dialogPublish) await dialogPublish.click().catch(() => {});
    const trState = await page.evaluate(() => ({
      ...window.__captured,
      titleValue: document.getElementById("in-title").value,
    }));
    trChecks["prototype NOT clicked:       "] = trState.prototypeClicked !== true;
    trChecks["drifted selector -> Text:    "] = trState.textClicked === true;
    trChecks["top-right Publish clicked:   "] = trState.topRightPublishClicked >= 1 && trState.dialogOpened === true;
    trChecks["dialog final Publish scoped: "] = trState.dialogPublishClicked === true;
    trChecks["title+tags auto-filled:      "] = trState.titleValue === input.title && JSON.stringify(trState.pickedTags || []) === JSON.stringify(EXP_TAGS);
  });
  let pass5 = true;
  for (const [label, ok] of Object.entries(trChecks)) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) pass5 = false;
  }

  // -------------------------------------------------------------------------
  // 6. Drifted label scenario: the live homepage renders the control as
  //    "Create a project on Behance" while the workflow only knows "Create a
  //    project" — resolveClickLocator must fall back to a prefix match.
  // -------------------------------------------------------------------------
  const driftUrl = pathToFileURL(new URL("./fixtures/create-drift.html", import.meta.url).pathname).href;
  const driftWorkflow = {
    meta: { siteName: "BehanceLike", siteUrl: "https://behance.net", siteKey: "behance-net" },
    auth: { required: false, loginSteps: [] },
    steps: [
      { id: "goto", action: "goto", url: driftUrl },
      // No recorded selector at all — must be found purely by the drifted label.
      { id: "open-create-0", action: "click", selector: "", text: "Create a project", waitAfter: 200 },
    ],
  };
  const driftChecks = { "drifted label prefix-clicked: ": false, "wrong control skipped: ": false };
  await runScenario(async (page) => {
    const drift = await executeWorkflow({ workflow: driftWorkflow, input: { credentials: null }, page });
    const s = await page.evaluate(() => window.__drift);
    const step = drift.results.find((r) => r.stepId === "open-create-0");
    driftChecks["drifted label prefix-clicked: "] = !!step?.ok && s.createClicked === true;
    driftChecks["wrong control skipped: "] = s.otherClicked !== true;
  });
  let pass6 = true;
  for (const [label, ok] of Object.entries(driftChecks)) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) pass6 = false;
  }

  // -------------------------------------------------------------------------
  // 7. Hidden-duplicate scenario: the mobile drawer renders a visibility:hidden
  //    "Share Work" <li> (still sized). The engine must click the VISIBLE
  //    desktop control, never the hidden drawer one (the 2026 live bug).
  // -------------------------------------------------------------------------
  const dupUrl = pathToFileURL(new URL("./fixtures/create-hidden-duplicate.html", import.meta.url).pathname).href;
  const dupWorkflow = {
    meta: { siteName: "BehanceLike", siteUrl: "https://behance.net", siteKey: "behance-net" },
    auth: { required: false, loginSteps: [] },
    steps: [
      { id: "goto", action: "goto", url: dupUrl },
      { id: "open-create-0", action: "click", text: "Create a project", alts: ["Share Work"], waitAfter: 150 },
    ],
  };
  const dupChecks = { "visible Share Work clicked:": false, "hidden drawer li NOT clicked:": false };
  await runScenario(async (page) => {
    const dup = await executeWorkflow({ workflow: dupWorkflow, input: { credentials: null }, page });
    const s = await page.evaluate(() => window.__share);
    const step = dup.results.find((r) => r.stepId === "open-create-0");
    dupChecks["visible Share Work clicked:"] = !!step?.ok && s.desktop === 1;
    dupChecks["hidden drawer li NOT clicked:"] = s.mobile === 0;
  });
  let pass7 = true;
  for (const [label, ok] of Object.entries(dupChecks)) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) pass7 = false;
  }

  // -------------------------------------------------------------------------
  // 8. Drifted-tags scenario: Behance renamed the tag input's placeholder, so
  //    the recorded selector misses. The engine must re-probe the dialog by
  //    label (keywords/tags) and still pick every suggestion.
  // -------------------------------------------------------------------------
  const driftTagsChecks = { "tags re-probed & picked: ": false };
  await runScenario(async (page) => {
    const dtWorkflow = structuredClone(workflow);
    dtWorkflow.steps = [
      { ...workflow.steps[0], url: pageUrl + "?tagsPlaceholder=Enter+some+keywords+here" },
      { id: "open-publish", action: "click", selector: 'nav[aria-label="Project Editor"] > :nth-child(1)', text: "Publish", waitAfter: 500 },
      { id: "fill-tags", action: "fill", selector: 'input[placeholder="Add up to 10 keywords to help people discover your project"]', property: "tags", waitAfter: 200 },
    ];
    dtWorkflow.fieldMappings = { tags: "fill-tags" };
    const dtRes = await executeWorkflow({ workflow: dtWorkflow, input: { ...input, shortDescription: "x", category: "", description: "" }, page });
    const captured5 = await page.evaluate(() => ({ pickedTags: window.__captured.pickedTags }));
    const tagStep = dtRes.results.find((r) => r.stepId === "fill-tags");
    driftTagsChecks["tags re-probed & picked: "] = !!tagStep?.ok && JSON.stringify(captured5.pickedTags || []) === JSON.stringify(EXP_TAGS);
  });
  let pass8 = true;
  for (const [label, ok] of Object.entries(driftTagsChecks)) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) pass8 = false;
  }

  // -------------------------------------------------------------------------
  // Final verdict over the main scenario's checks.
  // -------------------------------------------------------------------------
const checks = {
    "cover attached (gap-fill):  ": result.res.results.some((r) => r.stepId === "auto-upload-cover" && r.ok),
    "body pasted (gap-fill):     ": result.res.results.some((r) => r.stepId === "auto-fill-description" && r.ok),
    "share work clicked (nav):   ": captured.shareWorkClicked >= 1,
    "preview inserted (drift):   ": captured.previewInserted === true,
    "publish dialog confirmed:   ": captured.dialogOpened === true && result.res.failures.length === 0,
    "gallery URL extracted:      ": result.res.publishedUrl === "https://www.behance.net/gallery/200000001/",
    "title filled:               ": captured.title === input.title,
    "short description filled:   ": captured.shortDesc === input.shortDescription,
    "body kept full in textblock ": (captured.body || "").includes(input.description),
    "category set (Branding):    ": captured.category === "Branding",
    "tags via suggestion click:  ": JSON.stringify(captured.tags || []) === JSON.stringify(EXP_TAGS) && captured.suggestedTagClicked === "Automation Solutions",
    "visibility set:             ": captured.visibility === "public",
    "published (confirm):        ": confirmed,
    "backlink in body:           ": bodyHasBacklink,
    "keyword->backlink hyperlink:": !!input.keyword && (captured.bodyHtml || "").includes(`href="${input.backlinkUrl}"`),
    "hyperlink on ONE word only: ": singleWordLink,
  };

  let pass = true;
  for (const [label, ok] of Object.entries(checks)) {
    console.log(` ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) pass = false;
  }

  console.log(`\nfailures: ${result.res.failures.length}`);
  if (!allOk || !pass || !pass2 || !pass3 || !pass4 || !pass5 || !pass6 || !pass7 || !pass8) process.exit(1);
  console.log("\nBEHANCE-FLOW SMOKE TEST PASSED");
} catch (err) {
  console.error("\nSMOKE TEST ERROR:", err.message);
  if (err.stack) console.error(err.stack.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
} finally {
  await closeBrowser(browser).catch(() => {});
}