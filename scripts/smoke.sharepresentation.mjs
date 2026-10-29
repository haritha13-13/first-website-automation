import { launchBrowser, newPage, closeBrowser } from "../src/browser/browser.js";
process.env.AUTOMATOR_HEADLESS = "1";
import { executeWorkflow } from "../src/workflow/engine.js";
import { contentModeFromWorkflow } from "../src/input/collector.js";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { downloadDocumentUrl, toUploadableDoc } from "../src/documents/bodyDocument.js";

let pass = true;
const check = (name, ok, extra = "") => {
  if (!ok) pass = false;
  console.log(` [${ok ? "ok" : "FAIL"}] ${name}${extra ? "  " + extra : ""}`);
};

// Simulates sharepresentation.com: Homepage gates upload behind a login modal
// (#uploadsession -> #modal2). The modal contains a "Sign in with Google"
// button whose href points at a SECOND server on a different port, exactly like
// the real site's /google/redirect -> accounts.google.com hop (a cross-origin
// OAuth redirect). The modal ALSO has a hidden register form with duplicate
// name="username"/"password" inputs and a navbar "Sign in" link, so name- and
// text-based lookups remain ambiguous. On success the provider redirects back
// to /oauth/callback which sets the session cookie before /upload.
const indexHtml = (base, googleBase) => `<!doctype html><html><body>
  <ul id="navbar">
    <li id="signin" class="nav explicit_signin">Sign in</li>
  </ul>
  <a data-toggle="modal" href="#" id="uploadsession" class="nav">Upload</a>
  <div id="modal2" style="display:none">
    <div id="login_form">
      <strong id="form-errors-password"></strong>
      <strong id="form-errors-username"></strong>
      <a href="${googleBase}/ext-auth" class="google-login">
        <button type="button" class="btn btn-primary fb-btn">Sign in with Google</button>
      </a>
    </div>
    <div id="registration_form" style="display:none">
      <form action="/register" method="POST" id="registerForm">
        <input name="name">
        <input id="username" name="username">
        <input name="password">
      </form>
    </div>
  </div>
  <script>
    document.getElementById("uploadsession").addEventListener("click", (ev) => {
      ev.preventDefault();
      document.getElementById("modal2").style.display = "block";
    });
    document.getElementById("signin").addEventListener("click", (ev) => {
      ev.preventDefault();
      document.getElementById("modal2").style.display = "block";
    });
  </script>
</body></html>`;

// The fake OAuth provider: an account consent page on its OWN origin.
const googleConsentHtml = (base) => `<!doctype html><html><body>
  <h1>Choose an account</h1>
  <div data-identifier="tester@example.com">tester@example.com</div>
  <button onclick="location.href='${base}/oauth/callback'">Continue</button>
  <script>setTimeout(() => { location.href = '${base}/oauth/callback'; }, 400);</script>
</body></html>`;
const googleDenyHtml = `<!doctype html><html><body>
  <h1>Access denied</h1>
  <div role="alert">Sign in failed: access denied by user</div>
</body></html>`;

const uploadHtml = `<!doctype html><html><body>
  <div id="page_after_upload" style="display:none">uploaded ok</div>
  <form id="upload_form" action="/"> autocomplete:
    <input id="file_uploading" name="file" type="file" accept=".doc,.docx,.ppt,.pdf,.txt" required>
    <div class="input_fields" style="display:none">
      <input id="filename" class="file_name diable_entery" name="file_name" value="">
      <textarea id="discription" class="diable_entery" name="discription" placeholder="Description"></textarea>
      <input id="tags" name="tags" class="diable_entery" value="">
      <div class="tokenfield"><input id="tags-tokenfield" class="token-input tt-input" placeholder="Type something and hit enter"></div>
      <select id="category_values" name="category_values" class="diable_entery">
        <option value="">Please Select Category</option>
        <option value="27">Technology</option>
        <option value="26">Startup &amp; Entrepreneurship</option>
        <option value="9">Education</option>
      </select>
      <button id="submit" class="diable_entery" disabled>Publish</button>
    </div>
  </form>
  <pre id="status"></pre>
  <script>
    const q = (s) => document.querySelector(s);
    if (!document.cookie.includes("sp_session=1")) location.href = "/";
    q("#file_uploading").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      q(".input_fields").style.display = "block";
      const short = (f.name.replace(/\\.[^.]+$/, "") || f.name).replace(/^.*\\\\/, "");
      q("#filename").value = short;
      q("#filename").disabled = false;
      q("#discription").disabled = false;
      q("#category_values").disabled = false;
      q("#tags").disabled = false;
      q("#submit").disabled = false;
    });
    q("#submit").addEventListener("click", (e) => {
      e.preventDefault();
      localStorage.setItem("sp_submitted", JSON.stringify({
        title: q("#filename").value,
        desc: q("#discription").value,
        tags: q("#tags").value,
        category: q("#category_values").value,
      }));
      const t = q("#filename").value;
      const slug = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "post";
      location.href = "/dashboard?slug=" + encodeURIComponent(slug);
    });
    document.addEventListener("keydown", function (e) {
      if (e.target && e.target.id === "tags-tokenfield" && e.key === "Enter") {
        e.preventDefault();
        const v = e.target.value.trim();
        if (v) {
          const cur = q("#tags").value;
          q("#tags").value = cur ? cur + "," + v : v;
          e.target.value = "";
        }
      }
    });
  </script>
</body></html>`;
const dashboardHtml = `<!doctype html><html><body>
  <pre id="status"><%= status %></pre>
  <div class="portfolio-item" id="1109545">
    <a class="view-ppt" href="speedbots1176/<%= slug %>"><%= slug %></a>
  </div>
  <a href="/logout">Logout</a>
  <a href="/about">About</a>
</body></html>`;

const docText = "sharepresentation blog body speedbots content.";

let googleMode = "allow"; // "allow" | "deny"

const googleServer = http.createServer((req, res) => {
  if (req.url.startsWith("/ext-auth")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(googleMode === "deny" ? googleDenyHtml : googleConsentHtml(`http://127.0.0.1:${server.address().port}`));
    return;
  }
  res.writeHead(404); res.end();
});

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/blog.txt")) {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="blog.txt"' });
    res.end(docText);
    return;
  }
  if (req.url.startsWith("/oauth/callback")) {
    // The provider redirected back here; sharepresentation sets its session
    // cookie and sends the user to the upload page.
    res.writeHead(302, { Location: "/upload", "Set-Cookie": "sp_session=1; Path=/" });
    res.end();
    return;
  }
  if (req.url === "/publish") {
    res.writeHead(302, { Location: "/upload" });
    res.end();
    return;
  }
  if (req.url === "/upload") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(uploadHtml.replace("<%= status %>", "ready"));
    return;
  }
  if (req.url.startsWith("/dashboard")) {
    const slug = decodeURIComponent((req.url.split("slug=")[1] || "").split("&")[0]) || "published-post";
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(dashboardHtml.replace("<%= slug %>", slug).replace("<%= status %>", "ready"));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(indexHtml(`http://127.0.0.1:${server.address().port}`, `http://127.0.0.1:${googleServer.address().port}`));
});
await new Promise((r) => googleServer.listen(0, r));
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
const googleBase = `http://127.0.0.1:${googleServer.address().port}`;

// 1. getSiteContentMode derives "document" from this site's workflow.
const wf = JSON.parse(fs.readFileSync("workflows/sharepresentation-com.workflow.json", "utf8"));
check("sharepresentation workflow content mode = document",
  contentModeFromWorkflow(wf) === "document", `(${contentModeFromWorkflow(wf)})`);
check("workflow requires login", !!wf.auth?.required);
check("login is Google social sign-in", wf.auth?.loginMethod === "google");
check("google login steps recorded", (wf.auth?.loginSteps || []).length === 3);
check("google button selector used (no username/password)",
  !JSON.stringify(wf.auth.loginSteps).includes("username_login") &&
  wf.auth.loginSteps.some((s) => s.action === "click" && /google\/redirect/.test(s.selector)));
check("bodyDocument upload step present", wf.steps.some((s) => s.property === "bodyDocument"));
check("no cover-image step (document upload, not image)",
  !wf.steps.some((s) => s.property === "image"));

// 2. End-to-end: Google sign-in + document URL -> download -> upload -> fill.
const workflow = {
  meta: { siteName: "sharepresentation", siteUrl: base, siteKey: "sharepresentation-com" },
  auth: {
    required: true,
    loginMethod: "google",
    loginSteps: [
      { id: "goto-login", action: "goto", url: base, stepType: "login" },
      { id: "open-login", action: "click", selector: "#uploadsession", stepType: "login", waitAfter: 300 },
      { id: "google-login", action: "click", selector: ".google-login", stepType: "login", waitAfter: 800 },
    ],
  },
  inputs: { content: { mode: "document" } },
  fieldMappings: { title: "fill-title", description: "fill-description", tags: "fill-tags" },
  steps: [
    { id: "goto-upload", action: "goto", url: `${base}/upload` },
    { id: "upload-body-document", action: "upload", selector: "#file_uploading", property: "bodyDocument", waitAfter: 800 },
    { id: "fill-description", action: "fill", selector: "#discription", property: "shortDescription", waitAfter: 300 },
    { id: "fill-tags", action: "tags", selector: "#tags-tokenfield.token-input.tt-input", property: "tags", waitAfter: 300 },
    { id: "select-category", action: "select", selector: "#category_values", property: "category", waitAfter: 300 },
    { id: "fill-title", action: "fill", selector: "#filename", property: "title", waitAfter: 300 },
    { id: "submit-post", action: "click", selector: "#submit", waitAfter: 500 },
  ],
};
const input = {
  title: "sp title",
  description: "full body text",
  shortDescription: "short desc for sp",
  category: "Technology",
  tags: ["ai", "speedbots"],
  bodyDocumentUrl: `${base}/blog.txt`,
  keyword: "speedbots",
  backlinkUrl: "https://speedbots.io/x",
};

const browser = await launchBrowser();
const { page } = await newPage(browser);
const result = await executeWorkflow({ workflow, input, page });
const authSteps = result.results.filter((r) => r.phase === "auth");
const mainSteps = result.results.filter((r) => r.phase === "main");
console.log("\n--- auth phase ---");
for (const s of authSteps) console.log(` [${s.ok ? "ok" : "FAIL"}] ${s.stepId} ${s.action}${s.error ? " -> " + s.error : ""}`);
console.log("--- main phase ---");
for (const s of mainSteps) console.log(` [${s.ok ? "ok" : "FAIL"}] ${s.stepId} ${s.action}${s.error ? " -> " + s.error : ""}`);

check("google oauth completed (no login-verify failure)",
  !result.results.some((r) => r.stepId === "login-verify" && r.failed), `(final ${page.url()})`);
check("all auth steps ok", authSteps.every((s) => s.ok));
check("all main steps ok", mainSteps.every((s) => s.ok));

const pageInfo = await page.evaluate(() => {
  const raw = localStorage.getItem("sp_submitted");
  const d = raw ? JSON.parse(raw) : {};
  return {
    title: d.title || "",
    desc: d.desc || "",
    tags: d.tags || "",
    category: d.category || "",
    allFilled: !!raw,
  };
});
check("submitted (redirected to dashboard)", /\/dashboard/.test(page.url()), `(${page.url()})`);
check("form values stashed on submit (form actually submitted)", pageInfo.allFilled);
check("document uploaded (filename starts with real docx basename)",
  /^sp-title-\d+\.docx$/.test(input.bodyDocumentPath ? path.basename(input.bodyDocumentPath) : ""),
  `(${input.bodyDocumentPath ? path.basename(input.bodyDocumentPath) : ""})`);
check("title submitted = real title, NOT the auto-filename",
  pageInfo.title === "sp title", `(${pageInfo.title})`);
check("description submitted (short description)", pageInfo.desc.includes("short desc"), `(${pageInfo.desc.slice(0, 40)})`);
check("tags submitted via tokenfield (Enter per tag)",
  pageInfo.tags.split(",").map((t) => t.trim()).filter(Boolean).length === 2 && pageInfo.tags.includes("ai"),
  `(${pageInfo.tags})`);
check("category selected", pageInfo.category === "27", `(${pageInfo.category})`);
check("downloaded content used",
  input.bodyDocumentPath && path.extname(input.bodyDocumentPath) === ".docx" &&
  fs.readFileSync(input.bodyDocumentPath).subarray(0, 2).toString() === "PK",
  `(${input.bodyDocumentPath})`);
check("published URL captured from dashboard .view-ppt link",
  /\/speedbots1176\/sp-title($|-)/.test(result.publishedUrl || ""), `(${result.publishedUrl})`);

// 3. Local file path must be accepted as the Document URL (no http:// needed)
// and, being .txt, normalized into an uploadable .docx.
const localDoc = path.join(os.tmpdir(), `sp-local-${Date.now()}.txt`);
fs.writeFileSync(localDoc, "local body speedbots content.");
const used = await downloadDocumentUrl(localDoc, { title: "local" });
check("local file path accepted directly", used === localDoc, `(${used})`);
const localUp = await toUploadableDoc({ filePath: localDoc, keyword: "speedbots", url: "https://speedbots.io/x", title: "local" });
check("local .txt normalized to uploadable .docx",
  path.extname(localUp) === ".docx" && fs.readFileSync(localUp).subarray(0, 2).toString() === "PK",
  `(${localUp})`);

// 4. A rejected Google sign-in ("Access denied" on the provider) must surface a
//    real reason and skip body steps instead of silently cascading.
googleMode = "deny";
const failResult = await executeWorkflow({
  workflow,
  input,
  page: (await newPage(browser)).page,
});
const failAuth = failResult.results.filter((r) => r.phase === "auth");
const failVerify = failResult.results.find((r) => r.stepId === "login-verify");
const failMain = failResult.results.filter((r) => r.phase === "main");
console.log("\n--- denied-google auth phase ---");
for (const s of failAuth) console.log(` [${s.ok ? "ok" : "FAIL"}] ${s.stepId} ${s.action}${s.error ? " -> " + s.error : ""}`);
console.log("--- denied-google main phase (should be skipped) ---");
for (const s of failMain) console.log(` [${s.skipped ? "skip" : s.ok ? "ok" : "FAIL"}] ${s.stepId} ${s.action}${s.reason ? "  reason: " + s.reason : ""}`);
check("denied google: login-verify step failed with reason",
  !!failVerify && failVerify.failed && /denied/i.test(failVerify.error),
  `(${failVerify?.error})`);
check("denied google: no body step actually ran",
  failMain.length > 0 && failMain.every((s) => s.skipped));

await server.close();
await googleServer.close();
await closeBrowser(browser);
console.log(pass ? "\nSHRPT TEST PASSED" : "\nSHRPT TEST FAILED");
process.exit(pass ? 0 : 1);