// ── resize-bridge.js — runs in the PAGE's main world ──────────────────────
//
// Content scripts run in an isolated JS world; Object.defineProperty on a
// DOM node there only affects that world's wrapper object.  Google Docs reads
// the main-world wrapper and sees no change.
//
// This script runs alongside Google Docs (world: "MAIN") and listens for a
// custom event fired by content.js.  The value to spoof is read from a data
// attribute on <html> (DOM attributes are shared across all worlds).

window.addEventListener('__bal_resize__', () => {
  const raw = document.documentElement.getAttribute('data-bal-doc-width');
  if (raw !== null) {
    const w = parseInt(raw, 10);
    Object.defineProperty(document.documentElement, 'clientWidth', {
      get() { return w; },
      configurable: true,
    });
  } else {
    // Attribute removed → restore the native Element.prototype getter.
    delete document.documentElement.clientWidth;
  }
  window.dispatchEvent(new Event('resize'));
});
