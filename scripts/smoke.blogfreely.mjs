/**
process.env.AUTOMATOR_HEADLESS = "1";
 * Smoke: the complete blogfreely direct-publish editor flow, run in a REAL
 * browser (headed or headless) against a local mock of the site.
 *
 * Covers: login -> /new editor (textarea#writer) -> anchor-keyword autoLink
 * ("keyword" becomes a hyperlink to backlinkUrl inside the pasted content) ->
 * select blog target li.target#blog-speedbotsdm -> Publish -> wait for the
 * SPECIFIC post URL (never the blog index).
 */
import http from "node:http";
import { launchBrowser, newPage, closeBrowser } from "../src/browser/browser.js";
import { executeWorkflow } from "../src/workflow/engine.js";

const KEYWORD = "AI Automation in Coimbatore";
const BACKLINK = "https://auto-example.com/backlink";
const SLUG = "accounting-automation-coimbatore";

const HTML = {
  login: `<!doctype html><html><body>
    <form id="login"><input name="alias" /><input name="pass" /><button id="btn-login">Log in</button></form>
    <script>document.getElementById("btn-login").onclick=()=>{location.href="/new";};</script>
  </body></html>`,
  editor: `<!doctype html><html><body>
    <textarea id="writer"></textarea>
    <ul><li class="target" id="blog-speedbotsdm"><a href="#blog-speedbotsdm">speedbotsdm</a></li></ul>
    <a id="publish">Publish</a>
    <script>
      document.getElementById("publish").onclick=()=>{history.replaceState({},"","/speedbotsdm/${SLUG}");};
    </script>
  </body></html>`,
  post: `<!doctype html><html><body>
    <h1>Published</h1>
    <a href="/">home</a><a href="/speedbotsdm/another">another</a>
    <a href="/speedbotsdm/${SLUG}">this post</a>
  </body></html>`,
};

let port;
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url.startsWith("/login")) return res.end(HTML.login);
  if (req.url.startsWith("/new")) return res.end(HTML.editor);
  if (req.url.startsWith("/speedbotsdm/")) return res.end(HTML.post);
  res.statusCode = 404;
  res.end("not found");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
port = server.address().port;

const origin = `http://127.0.0.1:${port}`;
const originRe = origin.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const workflow = {
  meta: { siteName: "blogfreely", siteUrl: origin, siteKey: "bf-mock" },
  auth: { required: false, loginSteps: [] },
  fieldMappings: { description: "fill-content" },
  steps: [
    { id: "goto-login", action: "goto", url: `${origin}/login` },
    { id: "fill-username", action: "fill", selector: "input[name='alias']", property: "username" },
    { id: "fill-password", action: "fill", selector: "input[name='pass']", property: "password" },
    { id: "submit-login", action: "click", selector: "#btn-login", text: "Log in", waitAfter: 250 },
    { id: "goto-compose", action: "goto", url: `${origin}/new` },
    { id: "fill-content", action: "fill", selector: "#writer", property: "description", autoLink: true, waitAfter: 300 },
    { id: "select-blog-target", action: "click", selector: "li.target#blog-speedbotsdm a", waitAfter: 300 },
    { id: "submit-publish", action: "click", selector: "#publish", text: "Publish", waitAfter: 600 },
    { id: "wait-published-url", action: "wait", untilURLRegExp: `^${originRe}/speedbotsdm/[A-Za-z0-9][^/#?]*$`, timeoutMs: 10000, waitAfter: 200 },
  ],
  verification: {
    urlPatterns: [origin + "/speedbotsdm/*"],
    successSelectors: ["h1"],
    timeoutMs: 20000,
  },
  inputs: { content: { mode: "description" }, fields: ["description", "keyword", "backlinkUrl"] },
};

const input = {
  siteName: "blogfreely",
  siteUrl: origin,
  description: `Intro line. ${KEYWORD} is the anchor phrase used here, then again ${KEYWORD}.`,
  keyword: KEYWORD,
  backlinkUrl: BACKLINK,
  username: "mock-user",
  password: "mock-pass",
  credentials: null,
};

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log(`OK   ${name}${extra ? `  (${extra})` : ""}`); }
  else { fail += 1; console.log(`FAIL ${name}  (${extra})`); }
};

const browser = await launchBrowser();
const { page } = await newPage(browser);
const result = await executeWorkflow({ workflow, input, page });

console.log("\n--- step results ---");
for (const r of result.results) {
  console.log(` [${r.ok ? "ok " : "FAIL"}] ${String(r.stepId).padEnd(22)} ${r.action}`);
  if (!r.ok) console.log("      error:", r.error);
}
ok("all steps ok", result.failures.length === 0);

const content = await page.evaluate(() => document.getElementById("writer")?.value || "").catch(() => "");
ok(
  "anchor keyword auto-linked inside pasted content",
  content.includes(`<a href="${BACKLINK}" rel="nofollow">${KEYWORD}</a>`) &&
    content.split(`<a href="${BACKLINK}" rel="nofollow">`).length - 1 >= 2,
  `links found: ${content.split(`<a href="${BACKLINK}" rel="nofollow">`).length - 1}`
);

const publishedUrl = result.publishedUrl || "";
const expectedPost = `${origin}/speedbotsdm/${SLUG}`;
ok(
  "publishedUrl is the SPECIFIC post URL (2+ segments, never the blog index)",
  /^http:\/\/127\.0\.0\.1:\d+\/speedbotsdm\/[^/]+$/.test(publishedUrl),
  publishedUrl
);
ok("publishedUrl is the exact post", publishedUrl.endsWith(`/speedbotsdm/${SLUG}`) || publishedUrl === expectedPost.replace(/\/$/, ""), publishedUrl);

await closeBrowser(browser);
server.close();

console.log("");
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);