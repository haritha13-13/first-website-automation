import { ok, warn } from "../common/util.js";

// Signatures that mean the page is NOT the published post: site is down
// (HTTP 5xx / Cloudflare 522), a bot-challenge interstitial, or a browser
// error page. A page that merely mentions one of these words in article text
// is fine — only match when the marker dominates the document (title + head).
const ERROR_PAGE_MARKERS = [
  /error code \d{3}/i,
  /\b5\d{2}\b.*(bad gateway|gateway time[- ]?out|service unavailable|not implemented|internal server error)/i,
  /connection timed out/i,
  /couldn['’]t (reach|connect)/i,
  /cannot (reach|connect)/i,
  /this site can['’]t be reached/i,
  /err_connection/i,
  /just a moment[.!]?\.?\.\.?/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
];

function isErrorPage(title, bodyHead) {
  return ERROR_PAGE_MARKERS.some((re) => re.test(title) || re.test(bodyHead));
}

/**
 * Verifier: confirms the submission actually went live by reloading the
 * published URL (or a candidate URL) and asserting expected signals —
 * the post title on the page + the workflow's success selectors.
 */
export async function verifySubmission({ page, workflow, expectedUrl, input }) {
  const verification = workflow.verification || {};
  const candidates = [];

  if (expectedUrl && expectedUrl.startsWith("http")) candidates.push(expectedUrl);
  for (const p of verification.urlPatterns || []) {
    if (typeof p === "string" && p.startsWith("http") && !candidates.includes(p.replace(/\*+$/, ""))) {
      candidates.push(p.replace(/\*+$/, ""));
    }
  }

  if (!candidates.length) {
    warn("No URL candidates to verify. Retrying current page instead.");
    candidates.push(page.url());
  }

  const attempts = [];
  for (const url of candidates.slice(0, 3)) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
      await page.waitForTimeout(3000);

      const signals = await page.evaluate(({ title, successSelectors, markers }) => {
        const text = (document.title || "").toLowerCase();
        const body = (document.body?.innerText || "").toLowerCase();
        const bodyHead = body.slice(0, 400);
        const isErr = (s) => markers.some((re) => re.test(s));
        return {
          errorPage: isErr(text) || isErr(bodyHead),
          titleMatch: !!title && (text.includes(title.toLowerCase()) || body.includes(title.toLowerCase())),
          successHits: successSelectors
            .filter((sel) => {
              try { return !!document.querySelector(sel); } catch { return false; }
            })
            .length,
        };
      }, {
        title: input?.title || "",
        successSelectors: verification.successSelectors || [],
        markers: ERROR_PAGE_MARKERS,
      });

      if (signals.errorPage) {
        attempts.push({ url, verified: false, errorPage: true, titleMatch: false, successHits: 0 });
        continue;
      }

      if (signals.titleMatch || signals.successHits > 0) {
        ok(`Verification passed: ${url}`);
        return { verified: true, url, titleMatch: signals.titleMatch, successHits: signals.successHits, attempts };
      }
      attempts.push({ url, verified: false, titleMatch: signals.titleMatch, successHits: signals.successHits });
    } catch (err) {
      attempts.push({ url, verified: false, error: err.message.split("\n")[0] });
    }
  }

  warn("Verification could not confirm the post on any candidate URL.");
  return { verified: false, url: candidates[0] || "", attempts };
}