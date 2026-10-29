import { verifySubmission } from "../src/verify/verifier.js";
import { saveWorkflow, findWorkflow, deleteWorkflow } from "../src/workflow/repository.js";

let fails = 0;
const check = (name, cond) => {
  console.log(` ${cond ? "ok " : "FAIL"} ${name}`);
  if (!cond) fails++;
};

// --- Mock a browser page that ALWAYS lands on a Cloudflare 522 error page ---
const mkPage = (documentTitle, bodyText, selectors) => {
  const mockDoc = {
    title: documentTitle,
    body: { innerText: bodyText },
    querySelector: (sel) => {
      if (typeof selectors === "function") return selectors(sel);
      return null;
    },
  };
  return {
    url: async () => "https://blogfreely.net/new",
    context: () => ({ grantPermissions: async () => {} }),
    waitForTimeout: async () => {},
    goto: async () => {},
    evaluate: async (fn, arg) => {
      const prev = globalThis.document;
      globalThis.document = mockDoc;
      try { return fn(arg, mockDoc, globalThis); }
      finally { if (prev) globalThis.document = prev; else delete globalThis.document; }
    },
  };
};

const wf = {
  meta: { siteName: "blogfreely", siteUrl: "https://blogfreely.net/", siteKey: "blogfreely-net" },
  verification: {
    successSelectors: ["article", "[class*='success']", "[class*='alert']", "[class*='post']"],
    urlPatterns: ["https://blogfreely.net/*"],
  },
};

console.log("--- verifier: error page must NOT be accepted ---");

// Reproducer of the reported bug: title "information" appears in the 522 page footer.
const errBody =
  "connection timed out error code 522\n" +
  "visit cloudflare.com for more information.\n2026-09-30 05:20:12 utc\nwhat happened?\n" +
  "the initial connection between cloudflare's network and the origin web server timed out";
const errPage = mkPage("blogfreely.net | 522: Connection timed out", errBody);
const errRes = await verifySubmission({ page: errPage, workflow: wf, expectedUrl: "https://blogfreely.net/new", input: { title: "information" } });
check("522 page rejected", errRes.verified === false);
check("522 attempt flagged errorPage", errRes.attempts[0]?.errorPage === true);

console.log("--- verifier: real post page is accepted ---");
const goodPage = mkPage("information | blogfreely", "information about automation for getting traffic\nSome more blog text.");
const goodRes = await verifySubmission({ page: goodPage, workflow: wf, expectedUrl: "https://blogfreely.net/speedbots/real-slug", input: { title: "information" } });
check("real post accepted", goodRes.verified === true);

// --- Mock a generic 403 bot-challenge interstitial (not a publish) ---
const botPage = mkPage("Just a moment...", "Checking your browser before accessing blogfreely.net.");
const botRes = await verifySubmission({ page: botPage, workflow: wf, expectedUrl: "https://blogfreely.net/new", input: { title: "information" } });
check("bot-challenge rejected", botRes.verified === false);

console.log(fails ? `\n${fails} FAILURES` : "\nALL VERIFIER CHECKS PASSED");
process.exit(fails ? 1 : 0);