import readline from "node:readline";

/**
 * After a headed run finishes, keep the browser window on screen so the user
 * can watch the live editor / final published page (this was closing instantly,
 * which made live mode look broken). Enter closes it now; otherwise it
 * auto-closes after `holdMs`. Piped/CI stdin resolves immediately — never hang.
 */
export function holdOpenForReview({ holdMs = 45000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let rl = null;
    const timer = setTimeout(finish, Math.max(0, holdMs));

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        rl?.close();
      } catch {}
      resolve();
    }

    if (process.stdin.isTTY) {
      try {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(`\nPress Enter to close the browser now (auto-closes in ${Math.round(holdMs / 1000)}s)… `, finish);
        rl.on("close", finish);
      } catch {
        finish();
      }
    } else {
      // Piped/CI — nothing to wait on; resolve without hanging.
      finish();
    }
  });
}