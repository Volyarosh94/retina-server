/**
 * Tiny toast system — no library, no provider. A singleton puts its stack
 * into `document.body` as soon as this module loads, and renders dismissible
 * chips at the bottom-right.
 *
 * Usage: `toast("Copied")`, `toast("Failed", { tone: "error" })`.
 */

import { writeClipboard } from "../../utils/clipboard";

type Tone = "info" | "success" | "error" | "warn";

interface ToastEntry {
  id: number;
  text: string;
  tone: Tone;
}

let _container: HTMLDivElement | null = null;
// Whether the stack has been on the page long enough for a screen reader to
// know it as a live region (REGION_SETTLE_MS).
let _ready = false;
let _entries: ToastEntry[] = [];
let _idSeq = 1;
// Each toast's element, kept rather than redrawn, so the live region sees a
// new toast as the one addition it is.
const _elements = new Map<number, HTMLDivElement>();

// Toasts sit on document.body, under `:root`, so the console's tokens resolve
// here and each toast takes the console's theme. A tone's tint is a wash of
// 10–15 %: laid over the card's own colour rather than used as the
// background, so the map under a toast (its labels, a radar node's ring)
// never shows through the text.
const TONES: { tint: Record<Tone, string | null>; border: Record<Tone, string>; card: string; ink: string } = {
  tint: {
    info: null,
    success: "var(--success-light)",
    error: "var(--error-light)",
    warn: "var(--warning-light)",
  },
  border: { info: "var(--border-light)", success: "var(--success)", error: "var(--error)", warn: "var(--warning)" },
  card: "var(--bg-card)",
  ink: "var(--text-primary)",
};

/**
 * How long a new live region is left empty: a screen reader announces only
 * changes to a region it already knows, and one filled as it is created is
 * often never read out (MDN, ARIA live regions: "Establish the live region
 * before updating its content"). React Aria waits 100 ms for the same reason,
 * having found Safari missed announcements made sooner.
 */
const REGION_SETTLE_MS = 100;

function ensureContainer(): HTMLDivElement {
  if (_container && document.body.contains(_container)) return _container;
  const c = document.createElement("div");
  c.setAttribute("data-tf-toast", "");
  // A live region, so what a toast says reaches a screen reader too: polite,
  // and each toast once, as it arrives, rather than the whole stack again.
  c.setAttribute("role", "status");
  c.setAttribute("aria-live", "polite");
  c.setAttribute("aria-atomic", "false");
  c.setAttribute("aria-relevant", "additions");
  Object.assign(c.style, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    zIndex: "2000",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    pointerEvents: "none",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  } as CSSStyleDeclaration);
  document.body.appendChild(c);
  _container = c;
  // Toasts wait for the region to settle, then go in together.
  _ready = false;
  window.setTimeout(() => {
    if (_container !== c) return;
    _ready = true;
    render();
  }, REGION_SETTLE_MS);
  return c;
}

function render() {
  const c = ensureContainer();
  if (!_ready) return;
  const shown = new Set(_entries.map((e) => e.id));
  for (const [id, el] of _elements) {
    if (!shown.has(id)) {
      el.remove();
      _elements.delete(id);
    }
  }
  for (const e of _entries) {
    // Already on screen in this container: left exactly as it is.
    if (_elements.get(e.id)?.parentNode === c) continue;
    const el = document.createElement("div");
    el.textContent = e.text;
    const tint = TONES.tint[e.tone];
    Object.assign(el.style, {
      backgroundColor: TONES.card,
      backgroundImage: tint ? `linear-gradient(${tint}, ${tint})` : "none",
      border: `1px solid ${TONES.border[e.tone]}`,
      color: TONES.ink,
      padding: "8px 12px",
      borderRadius: "8px",
      fontSize: "13px",
      boxShadow: "0 4px 12px rgba(15,23,42,0.35)",
      pointerEvents: "auto",
      maxWidth: "320px",
    } as CSSStyleDeclaration);
    c.appendChild(el);
    _elements.set(e.id, el);
  }
}

export function toast(text: string, opts: { tone?: Tone; durationMs?: number } = {}) {
  if (typeof window === "undefined") return;
  const id = _idSeq++;
  const entry: ToastEntry = { id, text, tone: opts.tone ?? "info" };
  _entries.push(entry);
  render();
  const duration = opts.durationMs ?? 2500;
  window.setTimeout(() => {
    _entries = _entries.filter((e) => e.id !== id);
    render();
  }, duration);
}

/** Copy a string to the clipboard, with a built-in success/failure toast. */
export async function copyToClipboard(text: string, label = "Copied"): Promise<boolean> {
  const ok = await writeClipboard(text);
  toast(ok ? label : "Copy failed", { tone: ok ? "success" : "error" });
  return ok;
}

// The stack goes on the page empty as soon as this module loads, which is
// long before the first toast: so even that one is a change to a live region
// the screen reader already knows. Should something take it away, the next
// toast puts it back and waits for it to settle.
if (typeof document !== "undefined" && document.body) ensureContainer();
