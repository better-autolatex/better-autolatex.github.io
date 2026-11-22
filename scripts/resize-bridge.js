// Runs in the page's main world. Overriding clientWidth from the isolated
// content-script world wouldn't be visible to Google Docs, so content.js
// passes the width via a data attribute on <html> and a custom event.

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
