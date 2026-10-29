/**
 * DOM probing helpers used by the browser agent to inspect a live page
 * and figure out form fields / buttons / navigation worth recording in a
 * workflow.
 *
 * IMPORTANT: each exported function is passed to page.evaluate(), so it must
 * be fully self-contained — no references to other module functions or outer
 * closures. Everything it needs must be defined inside itself.
 */

export function collectInputs() {
  function selectorOf2(el) {
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return null;
      if (node.getAttribute && node.getAttribute("name")) return `${node.tagName.toLowerCase()}[name="${node.getAttribute("name")}"]`;
      if (node.getAttribute && node.getAttribute("aria-label")) return `${node.tagName.toLowerCase()}[aria-label="${node.getAttribute("aria-label")}"]`;
      if (node.getAttribute && node.getAttribute("placeholder")) return `${node.tagName.toLowerCase()}[placeholder="${node.getAttribute("placeholder")}"]`;
      if (node.getAttribute && node.getAttribute("data-qa")) return `[data-qa="${node.getAttribute("data-qa")}"]`;
      if (node.id) return `#${CSS.escape(node.id)}`;
      if (node.getAttribute && node.getAttribute("data-testid")) return `[data-testid="${node.getAttribute("data-testid")}"]`;
      const parent = node.parentElement;
      if (parent) {
        const pSel = walk(parent);
        if (pSel) {
          const idx = [...parent.children].indexOf(node) + 1;
          return `${pSel} > :nth-child(${idx})`;
        }
      }
      return null;
    };
    const out = walk(el);
    return out || el.tagName.toLowerCase();
  }

  const labels = new Map();
  document.querySelectorAll("label").forEach((l) => {
    const forId = l.getAttribute("for");
    if (forId) labels.set(forId, l.textContent.trim().toLowerCase());
    else if (l.querySelector("input,textarea,select")) {
      labels.set(l.querySelector("input,textarea,select"), l.textContent.trim().toLowerCase());
    }
  });

  const tags = [];
  document
    .querySelectorAll(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [data-slate-editor]'
    )
    .forEach((el) => {
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute ? el.getAttribute("name") || "" : "";
      const placeholder = el.getAttribute ? el.getAttribute("placeholder") || "" : "";
      const aria = el.getAttribute ? el.getAttribute("aria-label") || "" : "";
      const testid = el.getAttribute ? el.getAttribute("data-testid") || "" : "";
      tags.push({
        tag,
        type: el.getAttribute ? el.getAttribute("type") || "" : "",
        accept: el.getAttribute ? el.getAttribute("accept") || "" : "",
        name,
        placeholder,
        ariaLabel: aria,
        dataTestid: testid,
        contenteditable: el.getAttribute ? el.getAttribute("contenteditable") || "" : "",
        role: el.getAttribute ? el.getAttribute("role") || "" : "",
        dataPlaceholder: el.getAttribute ? el.getAttribute("data-placeholder") || el.getAttribute("data-ph") || "" : "",
        label: labels.get(el) || labels.get(el.getAttribute && el.getAttribute("id")) || "",
      textContent: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      selector: selectorOf2(el),
      options: tag === "select" ? [...el.options].map((o) => ({ value: o.value, text: o.textContent.trim() })).slice(0, 60) : [],
      value: el.tagName === "SELECT" ? el.value : "",
    });
  });
  return tags;
}

export function collectButtons() {
  function selectorOf3(el) {
    const walk = (node) => {
      if (!node || node.nodeType !== 1) return null;
      if (node.id) return `#${CSS.escape(node.id)}`;
      if (node.getAttribute && node.getAttribute("data-testid")) return `[data-testid="${node.getAttribute("data-testid")}"]`;
      if (node.getAttribute && node.getAttribute("name")) return `${node.tagName.toLowerCase()}[name="${node.getAttribute("name")}"]`;
      if (node.getAttribute && node.getAttribute("aria-label")) return `${node.tagName.toLowerCase()}[aria-label="${node.getAttribute("aria-label")}"]`;
      const parent = node.parentElement;
      if (parent) {
        const pSel = walk(parent);
        if (pSel) {
          const idx = [...parent.children].indexOf(node) + 1;
          return `${pSel} > :nth-child(${idx})`;
        }
      }
      return null;
    };
    const out = walk(el);
    return out || el.tagName.toLowerCase();
  }
  const results = [];
  const seen = new Set();
  const push = (el) => {
    const sel = selectorOf3(el);
    if (seen.has(sel)) return;
    seen.add(sel);
    const aria = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title") || "");
    results.push({
      role: el.tagName.toLowerCase(),
      text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      label: (aria || "").trim().slice(0, 80),
      selector: sel,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
    });
  };
  document.querySelectorAll("button,a,[role='button'][title],a[title]").forEach(push);
  document.querySelectorAll("button,a,[role='button']").forEach(push);
  return results;
}

export function collectLinks() {
  const seen = new Set();
  const out = [];
  document.querySelectorAll("a").forEach((a) => {
    const href = a.href;
    if (!href || seen.has(href)) return;
    seen.add(href);
    if (out.length >= 250) return;
    out.push({
      text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
      href,
    });
  });
  return out;
}

export function visibleText() {
  const body = document.body;
  if (!body) return "";
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node;
  while ((node = walker.nextNode()) && parts.length < 300) {
    const t = node.textContent.replace(/\s+/g, " ").trim();
    if (t && t.length > 2) parts.push(t);
  }
  return parts.join("\n");
}

export function currentUrl() {
  return location.href;
}

export function checkSelector(sel) {
  try {
    const el = document.querySelector(sel);
    if (!el) return { present: false };
    return { present: true, visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) };
  } catch {
    return { present: false, error: "invalid selector" };
  }
}