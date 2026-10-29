/**
 * Smoke: credential-switch/session-account handling.
 *
 * Bug under test: a NEW email/password was supplied but the automator kept
 * posting to the PREVIOUS account, because it blindly replayed the stored
 * session (data/session.json) which had no record of whose session it was.
 *
 * Verifies resolveStoredSession (the fresh-login decision) and the
 * readSessionAccount/persistSession round-trip, then cleans up.
 */
process.env.AUTOMATOR_HEADLESS = "1";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveStoredSession,
  readSessionAccount,
  persistSession,
} from "../src/browser/browser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`OK   ${name}${extra ? `  (${extra})` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}  (${extra})`);
  }
};

console.log("== resolveStoredSession decision table ==");
// Same email as stored session -> replay old session.
ok(
  "same email replays session",
  resolveStoredSession({
    providedEmail: "new@x.com",
    storedAccount: { email: "new@x.com", savedAt: "2026-01-01" },
  }).replay === true
);
// NEW email differs from stored session -> fresh login (the reported bug).
const switched = resolveStoredSession({
  providedEmail: "brandnew@x.com",
  storedAccount: { email: "old@x.com", savedAt: "2026-01-01" },
});
ok(
  "new email != stored account forces fresh login",
  switched.replay === false,
  switched.reason
);
// Stored session exists but account was never recorded. With NO cookie file
// present we must fresh-login (safety: never run logged-out under an assumed
// account); with cookies PRESENT we reuse them for the configured account so a
// completed login is never re-done.
const noCookies = resolveStoredSession({
  providedEmail: "fresh@x.com",
  storedAccount: null,
});
ok(
  "no stored session cookies -> fresh login (first time)",
  noCookies.replay === false && noCookies.reason.includes("no stored session cookies")
);
const cookieFile = path.join(dataDir, "session.json");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(cookieFile, "{}");
const withCookies = resolveStoredSession({
  providedEmail: "fresh@x.com",
  storedAccount: null,
});
const cookiesGotReused = withCookies.replay === true;
ok("stored session cookies reused (no fresh Google login)", cookiesGotReused || withCookies.replay === true);
fs.rmSync(cookieFile, { force: true });
// No credentials supplied -> replay whatever session exists.
ok(
  "no credentials replays stored session",
  resolveStoredSession({ providedEmail: "", storedAccount: { email: "x@x.com" } }).replay === true
);
// forceFresh env forces fresh even when emails match.
ok(
  "AUTOMATOR_FRESH_LOGIN=1 forces fresh",
  resolveStoredSession({
    providedEmail: "new@x.com",
    storedAccount: { email: "new@x.com" },
    forceFresh: true,
  }).replay === false
);
// empty stored account object (no email field) behaves like unrecorded.
ok(
  "stored account lacking email forces fresh",
  resolveStoredSession({ providedEmail: "a@b.com", storedAccount: { savedAt: "x" } }).replay === false
);

console.log("== readSessionAccount round-trip ==");
ok("missing account file reads as null", readSessionAccount() === null);
await persistSession(null, { email: "test-account@x.com", siteName: "smoke" }).catch(() => {});
const meta = readSessionAccount();
ok(
  "persistSession records email + siteName",
  meta && meta.email === "test-account@x.com" && meta.siteName === "smoke",
  JSON.stringify(meta)
);
if (fs.existsSync(path.join(dataDir, "session-account.json"))) {
  fs.unlinkSync(path.join(dataDir, "session-account.json"));
}

console.log("");
console.log(`RESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass} ok, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);