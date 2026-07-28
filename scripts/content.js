// Content script — runs in every Google Docs document tab.
//
// This version keeps the hotkeys and rendering workflow, but moves the UI
// out of the Google Docs top bar and into the extension toolbar popup.
// Rendering now opens a split view inside the Doc tab instead of launching a separate browser tab.
//
// Main jobs here:
//   1) extract the Google Doc text/images as reliably as possible
//   2) render PDFs via the background service worker
//   3) inject a split-screen PDF preview panel on the right side of Docs
//   4) respond to hotkeys and popup messages

(() => {
  if (window.__BETTER_AUTOLATEX_LOADED__) return;
  window.__BETTER_AUTOLATEX_LOADED__ = true;

  // ── State ────────────────────────────────────────────────────────────────

  let busy = false;
  let enabled = true;      // master on/off; synced from chrome.storage
  let renderMode = 'split'; // 'split' | 'tab'
  let docTitle = 'Untitled document';
  let autoFormatEnabled = false;  // auto-format mode
  let fTapTimer    = null;        // double-tap Ctrl+Shift+F detection
  let _autoFormatDirty = false;   // a format run is needed as soon as the API is free
  let _autoFormatTimer = null;    // setInterval handle for the poll loop
  let _savedPanelWidth = 0;       // persisted panel width in px; 0 = use default (50%)
  let _topBarMenuPinned = false;
  let _topBarMenuCloseTimer = null;
  let _pendingPopupView = null;

  // The formatter backend is now an Apps Script web app round trip (cold
  // starts + a 302 redirect), not a direct docs.googleapis.com call — much
  // higher latency than this poll was originally tuned for. The single-flight
  // guard (autoLatexFormatBusy + _autoFormatDirty) already prevents overlap
  // regardless of interval, so 2s is safe, but each tick that lands while a
  // request is in flight just sets the dirty flag and waits.
  const AUTO_FORMAT_POLL_MS = 2000;

  // Load initial enabled state, render mode, and auto-format state
  chrome.storage.local.get(['setting_enabled', 'setting_renderMode', 'setting_autoFormat', 'setting_splitPanelWidth'], (res) => {
    enabled           = res['setting_enabled'] !== false;
    renderMode        = res['setting_renderMode'] || 'split';
    autoFormatEnabled = res['setting_autoFormat'] === true;
    _savedPanelWidth  = res['setting_splitPanelWidth'] || 0;
    // If auto-format was already on before this page loaded, start the poll timer now.
    // (storage.onChanged only fires on *changes*, so it would never start otherwise.)
    if (autoFormatEnabled && !_autoFormatTimer) {
      _autoFormatTimer = setInterval(scheduleAutoFormat, AUTO_FORMAT_POLL_MS);
    }
    updateTopBarMenuLabel();
  });

  // React instantly when the popup toggles settings
  chrome.storage.onChanged.addListener((changes) => {
    if ('setting_enabled' in changes) {
      enabled = changes['setting_enabled'].newValue !== false;
      if (!enabled) {
        closeSplitView();
        closeTopBarMenu();
        _autoFormatDirty = false;
        clearInterval(_autoFormatTimer);
        _autoFormatTimer = null;
        toast('BETTER AutoLaTeX disabled', 'info');
      } else {
        toast('BETTER AutoLaTeX enabled', 'ok');
      }
      updateTopBarMenuLabel();
    }
    if ('setting_renderMode' in changes) {
      renderMode = changes['setting_renderMode'].newValue || 'split';
      updateTopBarMenuLabel();
    }
    if ('setting_autoFormat' in changes) {
      const wasEnabled  = autoFormatEnabled;
      autoFormatEnabled = changes['setting_autoFormat'].newValue === true;
      if (!autoFormatEnabled) {
        _autoFormatDirty = false;
        clearInterval(_autoFormatTimer);
        _autoFormatTimer = null;
      } else if (!wasEnabled) {
        // Just turned on: run one silent initial format to establish the baseline,
        // then start the poll timer that drives subsequent delta formats.
        setTimeout(() => {
          if (autoFormatEnabled && typeof window.autoLatexFormatDelta === 'function') {
            window.autoLatexFormatDelta();
          }
        }, 200);
        _autoFormatTimer = setInterval(scheduleAutoFormat, AUTO_FORMAT_POLL_MS);
      }
      updateTopBarMenuLabel();
    }
  });

  const splitState = {
    panel: null,
    frame: null,
    title: null,
    closeBtn: null,
    url: ''
  };

  

  // ── Split layout ────────────────────────────────────────────────────────────
  //
  // Override document.documentElement.clientWidth to return the available doc
  // width (total - panel), then dispatch a resize event. Google Docs reads
  // clientWidth in its resize handler to lay out the toolbar.
  // The override is left in place between calls (configurable:true means the
  // next call simply replaces it). On close, delete the own property so
  // Element.prototype's getter takes over and returns the real value again.

  // Guard: prevents our window resize listener from looping back into
  // applySplitWidth while the bridge's resize event is in flight.
  let _inTriggerResize = false;

  // Communicate with resize-bridge.js (which runs in the page's main world).
  // We write the desired doc width into a data attribute on <html> (DOM
  // attributes are shared across JS worlds), then fire a custom event that
  // the bridge picks up, applies Object.defineProperty, and dispatches a
  // real resize event — all in the main world alongside Google Docs.
  function triggerDocsResize(docWidth) {
    if (_inTriggerResize) return;
    _inTriggerResize = true;
    document.documentElement.setAttribute('data-bal-doc-width', Math.round(docWidth));
    window.dispatchEvent(new Event('__bal_resize__'));
    _inTriggerResize = false;
  }

  function restoreDocsClientWidth() {
    if (_inTriggerResize) return;
    _inTriggerResize = true;
    document.documentElement.removeAttribute('data-bal-doc-width');
    window.dispatchEvent(new Event('__bal_resize__'));
    _inTriggerResize = false;
  }

  function applySplitWidth() {
    if (!splitState.panel || !splitState.panel.classList.contains('open')) return;
    const totalW = window.innerWidth;
    const panelW = splitState.panel.getBoundingClientRect().width;
    const docW   = Math.max(200, totalW - panelW);
    document.documentElement.style.setProperty('--bal-split-width', Math.round(panelW) + 'px');
    document.documentElement.style.setProperty('--bal-doc-width',   Math.round(docW)   + 'px');
    triggerDocsResize(docW);
    centerEditorScroll();
  }

  function setSplitLayoutEnabled(enable, panelWidth) {
    const root = document.documentElement;
    if (enable) {
      const totalW = window.innerWidth;
      const pxW = Math.max(320, Math.min(totalW * 0.72, panelWidth || totalW * 0.50));
      root.style.setProperty('--bal-split-width', Math.round(pxW) + 'px');
      root.style.setProperty('--bal-doc-width',   Math.round(totalW - pxW) + 'px');
      root.classList.add('bal-split-open');
    } else {
      root.classList.remove('bal-split-open');
      root.style.removeProperty('--bal-doc-width');
      root.style.setProperty('--bal-split-width', '0px');
    }
  }

  // Re-apply on real browser window resize; skip our own synthetic events.
  window.addEventListener('resize', () => {
    positionTopBarMenu();
    if (_inTriggerResize) return;
    if (splitState.panel && splitState.panel.classList.contains('open')) {
      applySplitWidth();
    }
  });

  // Center the editor's horizontal scroll after a width change so the
  // document page stays centered in the available space.
  function centerEditorScroll() {
    const editor = document.querySelector('.kix-appview-editor');
    if (!editor) return;
    // kix-rotatingtilemanager holds the canvas; its left offset tells us
    // where the page sits. We want the viewport center = page center.
    const tm = editor.querySelector('.kix-rotatingtilemanager');
    if (!tm) return;
    const pageLeft = tm.offsetLeft;  // left edge of canvas area in editor
    const pageW    = editor.scrollWidth;
    const viewW    = editor.clientWidth;
    // Scroll so the center of the scrollable content is in view
    editor.scrollLeft = Math.max(0, Math.round(pageW / 2 - viewW / 2));
  }


// Fallback Google Docs text extraction helper
function extractVisibleDocText() {
  const selectors = [
    '.kix-wordhtmlgenerator-word-node',
    '.kix-lineview-text-block',
    '.docs-texteventtarget-iframe'
  ];

  let text = '';

  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);

    if (els.length > 0) {
      text = Array.from(els)
        .map(el => el.innerText || el.textContent || '')
        .join('\n');

      if (text.trim()) {
        return text;
      }
    }
  }

  return document.body.innerText || '';
}


bootstrap();

  function bootstrap() {
    captureDocTitle();
    listenForTitleChanges();
    bindGlobalHotkeys();
    listenForMessages();
    ensureTopBarMenu();
    setInterval(ensureTopBarMenu, 1500);
    setSplitLayoutEnabled(false);
  }

  function ensureTopBarMenu() {
    const host = document.querySelector('#docs-menubar') || document.querySelector('.docs-menubar') || document.querySelector('[role="menubar"]');
    if (!host) return;
    const existing = document.getElementById('bal-top-menu');
    if (existing && existing.isConnected && existing.parentNode === host) {
      updateTopBarMenuLabel();
      return;
    }
    if (existing) existing.remove();

    if (!document.getElementById('bal-top-menu-style')) {
      const style = document.createElement('style');
      style.id = 'bal-top-menu-style';
      style.textContent = '#bal-top-menu{position:relative!important;display:inline-block!important;box-sizing:border-box!important;border:1px solid transparent!important;border-radius:4px!important;color:var(--gm3-sys-color-on-surface,#1f1f1f)!important;cursor:pointer!important;font:14px/18px "Google Sans",Roboto,RobotoDraft,Helvetica,Arial,sans-serif!important;font-size:14px!important;letter-spacing:.2px!important;margin:8px 0 -4px 0!important;padding:2px 6px!important;user-select:none!important;vertical-align:text-bottom!important;white-space:nowrap!important}' +
        '#bal-top-menu:hover,#bal-top-menu[aria-expanded="true"]{background:#e8eaed!important}' +
        '#bal-top-menu-panel{display:none;position:fixed!important;z-index:2147483647!important;width:242px!important;padding:6px 0!important;background:var(--gm3-sys-color-surface-bright,#fff)!important;border:1px solid #dadce0!important;border-radius:4px!important;box-shadow:0 4px 12px rgba(60,64,67,.3)!important;font-family:"Google Sans",Roboto,RobotoDraft,Helvetica,Arial,sans-serif!important}' +
        '#bal-top-menu-panel button{display:block!important;width:100%!important;min-height:32px!important;padding:6px 18px!important;border:0!important;background:transparent!important;color:var(--gm3-sys-color-on-surface,#1f1f1f)!important;cursor:pointer!important;text-align:left!important;font:14px/20px "Google Sans",Roboto,RobotoDraft,Helvetica,Arial,sans-serif!important}' +
        '#bal-top-menu-panel button:hover{background:#f1f3f4!important}' +
        '#bal-top-menu-panel .bal-menu-divider{height:1px!important;margin:6px 0!important;background:#dadce0!important}';
      document.documentElement.appendChild(style);
      document.addEventListener('pointerdown', (event) => {
        const menu = document.getElementById('bal-top-menu');
        const panel = document.getElementById('bal-top-menu-panel');
        if (menu && !menu.contains(event.target) && (!panel || !panel.contains(event.target))) closeTopBarMenu();
      }, true);
      document.addEventListener('pointerdown', handleTopBarPointer, true);
      document.addEventListener('pointerup', (event) => {
        if (!_pendingPopupView) return;
        const action = topBarActionFor(event.target);
        if (action !== _pendingPopupView) {
          _pendingPopupView = null;
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        const view = _pendingPopupView;
        _pendingPopupView = null;
        closeTopBarMenu();

        // The request is armed on pointer-down and dispatched immediately
        // after pointer-up. The zero-delay task lets Chrome finish the native
        // outside-click dismissal before opening the replacement action popup.
        setTimeout(() => {
          sendMessage({ type: 'openPopupView', view })
            .catch(err => toast(err.message || 'Could not open popup.', 'err'));
        }, 0);
      }, true);
    }

    const menu = document.createElement('div');
    menu.id = 'bal-top-menu';
    menu.className = 'menu-button goog-control goog-inline-block';
    menu.setAttribute('role', 'menuitem');
    menu.setAttribute('aria-haspopup', 'true');
    menu.setAttribute('aria-expanded', 'false');
    menu.textContent = 'Better Auto-LaTeX';
    host.appendChild(menu);

    const stalePanel = document.getElementById('bal-top-menu-panel');
    if (stalePanel) stalePanel.remove();
    const panel = document.createElement('div');
    panel.id = 'bal-top-menu-panel';
    panel.setAttribute('role', 'menu');
    panel.innerHTML =
      '<button type="button" data-bal-action="render">Render PDF</button>' +
      '<button type="button" data-bal-action="download">Download PDF</button>' +
      '<button type="button" data-bal-action="rendermode"></button><div class="bal-menu-divider"></div>' +
      '<button type="button" data-bal-action="autoformat"></button><button type="button" data-bal-action="format">Format Now</button>' +
      '<div class="bal-menu-divider"></div><button type="button" data-bal-action="settings">Settings</button>' +
      '<button type="button" data-bal-action="preamble">Edit Preamble</button><div class="bal-menu-divider"></div>' +
      '<button type="button" data-bal-action="help">Help</button>';
    document.body.appendChild(panel);
    menu.addEventListener('pointerdown', handleTopBarPointer, true);
    panel.addEventListener('pointerdown', handleTopBarPointer, true);
    menu.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); }, true);
    panel.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); }, true);
    menu.addEventListener('mouseenter', () => {
      const openNative = getOpenNativeTopMenu();
      if (!openNative) return; // Default behavior remains click-to-open.
      closeNativeTopMenu(openNative);
      openTopBarMenu(true);
    });
    host.addEventListener('pointerover', (event) => {
      const otherMenu = event.target.closest('.menu-button, .goog-control');
      if (otherMenu && otherMenu !== menu) {
        const betterWasOpen = isTopBarMenuOpen();
        closeTopBarMenu();
        // Docs only activates a hovered native menu while another native menu
        // is open. Better's popup is custom, so explicitly activate the
        // hovered control to preserve that native handoff behavior.
        if (betterWasOpen) openNativeTopMenu(otherMenu);
      }
    });
    updateTopBarMenuLabel();
  }

  function positionTopBarMenu() {
    // Kept as a resize hook; the trigger now flows with the native menubar.
  }

  function topBarActionFor(target) {
    if (!(target instanceof Element)) return null;
    if (target.closest('#bal-top-menu')) return 'toggle';
    return target.closest('#bal-top-menu-panel [data-bal-action]')?.dataset.balAction || null;
  }

  function handleTopBarPointer(event) {
    const action = topBarActionFor(event.target);
    if (!action) return;
    // Settings/Preamble are armed here on mouse/pointer-down and dispatched
    // from pointer-up. All other actions run directly on pointer-down.
    if (action !== 'settings' && action !== 'preamble') event.preventDefault();
    event.stopImmediatePropagation();
    if (action === 'toggle') {
      if (_topBarMenuPinned) closeTopBarMenu();
      else openTopBarMenu(true);
      return;
    }
    // Keep these buttons rendered through pointer-up. Closing them during
    // pointer-down used to lose fast clicks intermittently.
    if (action === 'settings' || action === 'preamble') {
      _pendingPopupView = action;
      return;
    }
    closeTopBarMenu();
    if (action === 'render') doRender(false).catch(() => {});
    else if (action === 'download') doRender(true).catch(() => {});
    else if (action === 'rendermode') {
      const next = renderMode === 'tab' ? 'split' : 'tab';
      chrome.storage.local.set({ setting_renderMode: next });
      toast('Render to ' + (next === 'tab' ? 'New Tab' : 'Split Screen'), 'info');
    }
    else if (action === 'autoformat') {
      const next = !autoFormatEnabled;
      chrome.storage.local.set({ setting_autoFormat: next });
      toast('Auto-format ' + (next ? 'ON' : 'OFF'), next ? 'ok' : 'info');
    }
    else if (action === 'format') {
      if (typeof window.autoLatexFormatNow === 'function') window.autoLatexFormatNow();
      else toast('Formatter not ready.', 'err');
    } else if (action === 'help') sendMessage({ type: 'openPage', page: 'html/help.html' }).catch(() => {});
  }

  function closeTopBarMenu() {
    const menu = document.getElementById('bal-top-menu');
    const panel = document.getElementById('bal-top-menu-panel');
    clearTimeout(_topBarMenuCloseTimer);
    _topBarMenuPinned = false;
    if (panel) panel.style.display = 'none';
    if (menu) menu.setAttribute('aria-expanded', 'false');
  }

  function isTopBarMenuOpen() {
    const panel = document.getElementById('bal-top-menu-panel');
    return !!panel && panel.style.display === 'block';
  }

  function getOpenNativeTopMenu() {
    const controls = document.querySelectorAll('#docs-menubar .menu-button[aria-expanded="true"], #docs-menubar .goog-control[aria-expanded="true"]');
    return Array.from(controls).find(control => control.id !== 'bal-top-menu') || null;
  }

  function closeNativeTopMenu(control) {
    if (!control || control.getAttribute('aria-expanded') !== 'true') return;
    // Docs handles Escape on its active menu item, not reliably on document.
    // Focus that item and send the full key sequence to it so the event bubbles
    // through the same Closure control hierarchy as a real Escape press.
    control.focus();
    const eventInit = {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
      bubbles: true, cancelable: true, view: window
    };
    control.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    control.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  }

  function openNativeTopMenu(control) {
    if (!control || control.getAttribute('aria-expanded') === 'true') return;
    control.focus();
    control.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true, view: window, buttons: 1
    }));
    control.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true, cancelable: true, view: window
    }));
    // A few Docs builds bind the activation to click instead; only use that
    // fallback if the native mouse-down path did not open the menu.
    setTimeout(() => {
      if (control.getAttribute('aria-expanded') !== 'true') control.click();
    }, 0);
  }

  function openTopBarMenu(pin) {
    const menu = document.getElementById('bal-top-menu');
    const panel = document.getElementById('bal-top-menu-panel');
    if (!menu || !panel || !enabled) return;
    clearTimeout(_topBarMenuCloseTimer);
    if (pin) _topBarMenuPinned = true;
    const rect = menu.getBoundingClientRect();
    panel.style.left = Math.max(0, Math.round(rect.left)) + 'px';
    panel.style.top = Math.round(rect.bottom + 3) + 'px';
    panel.style.display = 'block';
    menu.setAttribute('aria-expanded', 'true');
  }

  function scheduleTopBarMenuClose() {
    if (_topBarMenuPinned) return;
    clearTimeout(_topBarMenuCloseTimer);
    _topBarMenuCloseTimer = setTimeout(() => {
      if (!_topBarMenuPinned) closeTopBarMenu();
    }, 120);
  }

  function updateTopBarMenuLabel() {
    const menu = document.getElementById('bal-top-menu');
    if (menu) menu.style.setProperty('display', enabled ? 'inline-block' : 'none', 'important');
    if (!enabled) closeTopBarMenu();
    const button = document.querySelector('#bal-top-menu-panel [data-bal-action="autoformat"]');
    if (button) button.textContent = 'Auto-format (' + (autoFormatEnabled ? 'ON' : 'OFF') + ')';
    const renderModeButton = document.querySelector('#bal-top-menu-panel [data-bal-action="rendermode"]');
    if (renderModeButton) {
      renderModeButton.textContent = 'Render to (' + (renderMode === 'tab' ? 'New Tab' : 'Split Screen') + ')';
    }
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response from background'));
          return;
        }
        if (response.ok === false) {
          reject(new Error(response.error || 'Error'));
          return;
        }
        resolve(response);
      });
    });
  }

  function listenForMessages() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'render') {
        if (!enabled) { sendResponse({ ok: false, error: 'Extension is disabled.' }); return; }
        doRender(false)
          .then(result => {
            // Preserve blank flag so popup can suppress its own error display
            if (result && result.blank) sendResponse({ ok: true, blank: true });
            else sendResponse({ ok: true, ...result });
          })
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }

      if (msg.type === 'download') {
        if (!enabled) { sendResponse({ ok: false, error: 'Extension is disabled.' }); return; }
        doRender(true)
          .then(result => {
            if (result && result.blank) sendResponse({ ok: true, blank: true });
            else sendResponse({ ok: true, ...result });
          })
          .catch(err => sendResponse({ ok: false, error: err.message || String(err) }));
        return true;
      }

      if (msg.type === 'closeSplitView') {
        closeSplitView();
        sendResponse({ ok: true });
        return;
      }

      if (msg.type === 'openSplitView' && msg.base64 && msg.fileName) {
        showSplitView(msg.base64, msg.fileName);
        sendResponse({ ok: true });
        return;
      }
    });
  }

  // ── Document title ───────────────────────────────────────────────────────

  function captureDocTitle() {
    const t = document.querySelector('.docs-title-input') ||
              document.querySelector('input.docs-title-input-label-inner');
    if (t && (t.value || t.textContent)) {
      docTitle = t.value || t.textContent;
    } else {
      docTitle = (document.title || 'Untitled document').replace(/ - Google Docs.*$/, '');
    }
  }

  function listenForTitleChanges() {
    let last = document.title;
    setInterval(() => {
      if (document.title !== last) {
        last = document.title;
        captureDocTitle();
      }
    }, 1500);
  }

  // ── Hotkeys ──────────────────────────────────────────────────────────────

  function bindGlobalHotkeys() {
    window.addEventListener('keydown', (e) => {
      if (!enabled) return;   // extension is disabled

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
        e.preventDefault();
        e.stopPropagation();
        doRender(false).catch(() => {});
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
        e.preventDefault();
        e.stopPropagation();
        doRender(true).catch(() => {});
        return;
      }

      // Ctrl+Shift+F is NOT intercepted here — Google Docs uses it natively
      // (compact controls / hide menus). We only intercept it from the inner
      // editing iframe where Docs doesn't listen.
    }, true);

    setInterval(attachIframeKeyHandlers, 1500);
  }

  // ── Auto-format mode ─────────────────────────────────────────────────────

  // Trigger a delta-format immediately on each content-modifying keystroke.
  // If the API is already running, set the dirty flag so _runAutoFormat will
  // fire again as soon as the current call finishes — no keystrokes dropped,
  // no busy-wait loop, no debounce delay.
  function scheduleAutoFormat() {
    if (!autoFormatEnabled) return;
    _autoFormatDirty = true;
    if (!window.autoLatexFormatBusy) {
      _runAutoFormat();
    }
  }

  function _runAutoFormat() {
    if (!_autoFormatDirty || !autoFormatEnabled) return;
    _autoFormatDirty = false;
    if (typeof window.autoLatexFormatDelta !== 'function') return;
    Promise.resolve(window.autoLatexFormatDelta()).then(() => {
      if (_autoFormatDirty && autoFormatEnabled) _runAutoFormat();
    }).catch(() => {
      if (_autoFormatDirty && autoFormatEnabled) _runAutoFormat();
    });
  }

  // Handle Ctrl+Shift+F with double-tap detection.
  // First tap starts a 400 ms window; second tap within that window toggles
  // auto-format mode. If the window expires alone, format once (existing
  // behavior). The 400 ms wait is imperceptible since formatting itself
  // takes several seconds.
  function handleFormatKey() {
    if (fTapTimer !== null) {
      clearTimeout(fTapTimer);
      fTapTimer = null;
      const newState = !autoFormatEnabled;
      chrome.storage.local.set({ setting_autoFormat: newState });
      // autoFormatEnabled will update via the storage listener above
      toast(newState ? 'Auto-format ON' : 'Auto-format OFF', newState ? 'ok' : 'info');
    } else {
      fTapTimer = setTimeout(() => {
        fTapTimer = null;
        if (typeof window.autoLatexFormatNow === 'function') {
          window.autoLatexFormatNow();
        } else {
          toast('Formatter not ready.', 'err');
        }
      }, 400);
    }
  }

  function attachIframeKeyHandlers() {
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    if (!iframe || iframe.__balHotkeysBound) return;
    try {
      const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
      if (!doc) return;
      doc.addEventListener('keydown', (e) => {
        if (!enabled) return;

        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
          e.preventDefault(); e.stopPropagation();
          doRender(false).catch(() => {});
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
          e.preventDefault(); e.stopPropagation();
          doRender(true).catch(() => {});
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
          // Intercepted inside the editing iframe — Docs' top-level
          // "compact controls" handler won't fire because we stop propagation.
          // Double-tap within 400 ms → toggle auto-format; single tap → format once.
          e.preventDefault(); e.stopPropagation();
          handleFormatKey();
          return;
        }

      }, true);
      iframe.__balHotkeysBound = true;
    } catch (_) {
      // Ignore cross-origin or Docs internals changing.
    }
  }

  // ── Render workflow ──────────────────────────────────────────────────────

  async function doRender(download) {
    if (busy) {
      toast('Render already in progress…', 'info');
      return { ok: false, busy: true };
    }

    busy = true;
    const stickyToast = download ? 'Preparing download…' : 'Rendering PDF…';
    toast(stickyToast, 'info', true);

    try {
      // Extract first so we can validate before bothering the server
      let extracted;
      try {
        extracted = await extractDocumentText();
      } catch (_) {
        extracted = { text: '', images: [] };  // treat extraction failure as blank
      }
      captureDocTitle();

      // ── Blank document guard — short-circuit BEFORE any server call ──────
      const hasText   = (extracted.text || '').trim().length > 0;
      const hasImages = (extracted.images || []).length > 0;
      if (!hasText && !hasImages) {
        // Show ONLY the toast for blank docs — don't route to split/tab
        toast('Cannot render: the document is blank. Add some content first.', 'err');
        return { ok: false, blank: true, error: 'Document is blank.' };
      }

      const payload = {
        title:    docTitle,
        bodyText: extracted.text,
        images:   extracted.images,
        docId:    getDocIdFromUrl()
      };

      if (download) {
        const r = await sendMessage({ type: 'download', payload });
        toast('Downloaded ' + r.fileName, 'ok');
        return { fileName: r.fileName, downloaded: true };
      }

      const r = await sendMessage({ type: 'render', payload });

      if (renderMode === 'tab') {
        closeSplitView();
        openPdfInTab(r.base64, r.fileName);
        toast('Opened in new tab', 'ok');
      } else {
        showSplitView(r.base64, r.fileName);
        toast('Rendered', 'ok');
      }

      return { fileName: r.fileName, rendered: true };

    } catch (err) {
      const msg = err.message || String(err);
      // Hide the sticky "Rendering…" toast — but DON'T show an error toast.
      // The error is routed to the chosen destination (split panel or new tab).
      toast('', 'info'); // dismiss any sticky toast quickly
      try {
        const t = document.getElementById('bal-toast');
        if (t) t.classList.remove('show');
      } catch (_) {}

      if (renderMode === 'tab') {
        closeSplitView();
        openErrorInTab(msg);
      } else {
        showSplitError(msg);
      }

      // Re-throw so popup callers know it failed — but the popup will
      // suppress its own status display for render errors (see popup.js).
      throw err;
    } finally {
      busy = false;
    }
  }

  function openErrorInTab(errorText) {
    const safeText = String(errorText || 'LaTeX compilation failed.')
      .replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
    const htmlPage = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Compilation error</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 14px/1.6 "Segoe UI", Arial, sans-serif; background: #0e0710; color: #fdeef5; }
  .wrap { padding: 32px; max-width: 900px; margin: 0 auto; }
  .label {
    font: 700 11px/1 "Segoe UI", Arial, sans-serif;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #ffa060;
    margin-bottom: 10px;
  }
  h1 { font-size: 22px; font-weight: 700; color: #ff7070; margin-bottom: 20px; }
  pre {
    white-space: pre-wrap; word-break: break-word;
    font: 13px/1.65 'Roboto Mono', 'Consolas', monospace;
    background: #180d1a;
    border: 1px solid rgba(255, 80, 130, 0.2);
    border-radius: 12px;
    padding: 18px;
    color: #f0d8e8;
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="label">LaTeX</div>
    <h1>Compilation error</h1>
    <pre>${safeText}</pre>
  </div>
</body>
</html>`;
    const blob = new Blob([htmlPage], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open('', 'bal_pdf_preview_tab');
    if (win) { win.location.href = url; } else { window.open(url, 'bal_pdf_preview_tab'); }
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function openPdfInTab(base64, fileName) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    window.open(url, 'bal_pdf_preview_tab');
    // Keep URL alive long enough for tab to load
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  // ── Split view preview ───────────────────────────────────────────────────

  function ensureSplitViewShell() {
    if (splitState.panel) return;

    const panel = document.createElement('div');
    panel.id = 'bal-split-panel';
    panel.className = 'bal-split-panel';

    panel.innerHTML = `
      <div class="bal-split-header">
        <div class="bal-split-title-wrap">
          <div class="bal-split-kicker">Rendered PDF</div>
          <div class="bal-split-title" id="bal-split-title">Waiting for render…</div>
        </div>
        <div class="bal-split-actions">
          <button type="button" class="bal-split-btn" id="bal-split-close" title="Close preview">Close</button>
        </div>
      </div>
      <iframe class="bal-split-frame" src="about:blank" title="Rendered PDF preview"></iframe>
      <div class="bal-split-resize-handle" title="Drag to resize"></div>
    `;

    const frame = panel.querySelector('.bal-split-frame');
    const title = panel.querySelector('#bal-split-title');
    const closeBtn = panel.querySelector('#bal-split-close');
    const handle = panel.querySelector('.bal-split-resize-handle');

    closeBtn.addEventListener('click', closeSplitView);

    // ── Resize handle — pointer capture keeps tracking even when the
    //    cursor races outside the handle or over the iframe ──────────────
    let startX = 0;
    let startW = 0;

    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      handle.style.background = 'rgba(26,115,232,0.18)';
      e.preventDefault();
    });

    let _dragDocW = 0;
    handle.addEventListener('pointermove', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      const delta  = startX - e.clientX;
      const totalW = window.innerWidth;
      const newWidth = Math.max(320, Math.min(totalW * 0.72, startW + delta));
      panel.style.width = Math.round(newWidth) + 'px';
      _dragDocW = Math.max(200, totalW - newWidth);
      document.documentElement.style.setProperty('--bal-split-width', Math.round(newWidth) + 'px');
      document.documentElement.style.setProperty('--bal-doc-width',   Math.round(_dragDocW) + 'px');
      // Throttle the expensive Docs resize trigger to once per animation frame.
      if (!handle._resizeScheduled) {
        handle._resizeScheduled = true;
        requestAnimationFrame(() => {
          handle._resizeScheduled = false;
          triggerDocsResize(_dragDocW);
          centerEditorScroll();
        });
      }
    });

    handle.addEventListener('pointerup', (e) => {
      if (!handle.hasPointerCapture(e.pointerId)) return;
      handle.releasePointerCapture(e.pointerId);
      handle.style.background = '';
      // applySplitWidth sets the override to the final doc width and fires
      // the resize event so Google Docs reflows its toolbar.
      applySplitWidth();
      // Persist the user's chosen width so the next render opens at the same size.
      const finalW = Math.round(panel.getBoundingClientRect().width);
      _savedPanelWidth = finalW;
      chrome.storage.local.set({ setting_splitPanelWidth: finalW });
    });

    handle.addEventListener('pointercancel', (e) => {
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      handle.style.background = '';
    });

    document.body.appendChild(panel);

    splitState.panel = panel;
    splitState.frame = frame;
    splitState.title = title;
    splitState.closeBtn = closeBtn;
  }

  function showSplitView(base64, fileName) {
    ensureSplitViewShell();

    if (splitState.url) {
      try { URL.revokeObjectURL(splitState.url); } catch (_) {}
      splitState.url = '';
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    splitState.url = url;

    splitState.title.textContent = fileName || 'Rendered PDF';
    splitState.panel.classList.add('open');

    // PDF open-parameters: #view=FitH is the standards-compliant
    // fit-horizontal hint that Chrome's PDFium viewer honours reliably,
    // unlike #zoom=page-width which is silently ignored in many builds.
    const pdfUrlWithZoom = url + '#view=FitH&toolbar=1';

    splitState.frame.removeAttribute('srcdoc');
    splitState.frame.src = pdfUrlWithZoom;

    // Show the panel and immediately set the width override + trigger Docs resize.
    // Use saved width if available; setSplitLayoutEnabled defaults to 50% when 0.
    setSplitLayoutEnabled(true, _savedPanelWidth || 0);
    applySplitWidth();

    // Re-apply after iframe loads (iframe dimensions may shift the panel slightly).
    const reapply = () => {
      applySplitWidth();
      centerEditorScroll();
    };
    splitState.frame.addEventListener('load', reapply, { once: true });
    setTimeout(reapply, 500);

    setTimeout(() => {
      if (splitState.url === url) {
        try { URL.revokeObjectURL(url); } catch (_) {}
      }
    }, 5 * 60 * 1000);
  }

  function closeSplitView() {
    if (!splitState.panel) return;
    splitState.panel.classList.remove('open');
    splitState.frame.removeAttribute('srcdoc');
    splitState.frame.src = 'about:blank';
    if (splitState.url) {
      try { URL.revokeObjectURL(splitState.url); } catch (_) {}
      splitState.url = '';
    }
    setSplitLayoutEnabled(false);
    // Restore native clientWidth and fire resize so Google Docs sees full width.
    restoreDocsClientWidth();
  }

  function showSplitError(errorText) {
    ensureSplitViewShell();
    if (splitState.url) {
      try { URL.revokeObjectURL(splitState.url); } catch (_) {}
      splitState.url = '';
    }
    const safeText = String(errorText || 'LaTeX compilation failed.').replace(/[&<>]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]));
    const htmlPage = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, sans-serif; background: #0e0710; color: #fdeef5; }
  .wrap { padding: 16px; height: 100vh; overflow: auto; }
  .label {
    font: 700 10px/1 "Segoe UI", Arial, sans-serif;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #ffa060;
    margin-bottom: 8px;
  }
  h1 { font-size: 16px; font-weight: 700; color: #ff7070; margin-bottom: 14px; }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    font: 12.5px/1.6 'Roboto Mono', 'Consolas', monospace;
    background: #180d1a;
    border: 1px solid rgba(255, 80, 130, 0.2);
    border-radius: 10px;
    padding: 14px;
    color: #f0d8e8;
  }
</style>
</head>
<body>
  <div class="wrap">
    <div class="label">LaTeX</div>
    <h1>Compilation error</h1>
    <pre>${safeText}</pre>
  </div>
</body>
</html>`;
    splitState.title.textContent = 'Compilation error';
    splitState.panel.classList.add('open');
    setSplitLayoutEnabled(true, _savedPanelWidth || 0);
    applySplitWidth();
    splitState.frame.removeAttribute('src');
    splitState.frame.srcdoc = htmlPage;
    applySplitWidth();
  }

  // ── Text extraction ──────────────────────────────────────────────────────

  async function extractDocumentText() {
    const strategies = [extractViaClipboard, extractViaExport];
    let lastError = null;
    let plainClipboardFallback = null;

    for (const strategy of strategies) {
      try {
        const parsed = await strategy();
        if (parsed && ((parsed.text || '').trim().length > 0 || (parsed.images || []).length > 0)) {
          // Docs sometimes exposes only text/plain on the synthetic-copy
          // path. It is useful as a fallback, but it has already flattened
          // tables and page-break markup, so prefer the HTML export before
          // accepting it as the render source.
          if (strategy === extractViaClipboard && !parsed.richHtml) {
            plainClipboardFallback = parsed;
            continue;
          }
          delete parsed.richHtml;
          return parsed;
        }
      } catch (err) {
        // The clipboard-based path is fragile in Google Docs. Keep trying
        // the export-based fallback before surfacing anything to the user.
        lastError = err;
      }
    }

    if (plainClipboardFallback) return plainClipboardFallback;
    throw lastError || new Error('Could not read the document content.');
  }

  async function extractViaClipboard() {
    const target = document.querySelector('iframe.docs-texteventtarget-iframe');
    if (!target) {
      return null;
    }

    const targetWin = target.contentWindow;
    const targetDoc = target.contentDocument;
    let captured = null;

    const onCopy = (e) => {
      try {
        const dt = e.clipboardData;
        if (!dt) return;
        captured = {
          html: dt.getData('text/html') || '',
          plain: dt.getData('text/plain') || ''
        };
        if (captured.html || captured.plain) {
          e.preventDefault();
          e.stopPropagation();
        }
      } catch (_) {}
    };

    try { targetDoc.addEventListener('copy', onCopy, false); } catch (_) {}
    window.addEventListener('copy', onCopy, false);

    // Run a single focus → selectAll → copy attempt and report whether it
    // produced any content.
    const attemptCopy = async () => {
      captured = null;
      try {
        // If the rendered-PDF iframe currently holds focus — common when the
        // render was triggered by keyboard while the split panel was focused —
        // it swallows the selection and the copy captures nothing. Pull focus
        // back to the top window and the Docs editing surface first.
        try { window.focus(); } catch (_) {}
        if (splitState.frame && document.activeElement === splitState.frame) {
          try { splitState.frame.blur(); } catch (_) {}
        }
        target.focus();
        if (targetWin) targetWin.focus();
      } catch (_) {}

      // CRITICAL: give the focus change a tick to settle before selecting.
      // focus() is asynchronous in effect — selecting/copying in the same tick
      // captures an empty selection and produces a blank document. This races
      // whenever focus was elsewhere: just after switching render destination
      // in the popup, or with the split-view PDF focused.
      await new Promise(r => setTimeout(r, 100));

      let copyOk = false;
      if (targetDoc) {
        targetDoc.execCommand('selectAll', false, null);
        copyOk = targetDoc.execCommand('copy');
      } else {
        document.execCommand('selectAll', false, null);
        copyOk = document.execCommand('copy');
      }

      await new Promise(r => setTimeout(r, 80));
      const hasContent = !!(captured && (captured.html || captured.plain));
      return { copyOk, hasContent };
    };

    let result;
    try {
      // Retry a few times if the copy comes back empty — this is exactly the
      // case when focus was elsewhere (split-view PDF focused, or just after
      // switching render destination). Each attempt re-asserts editor focus.
      result = await attemptCopy();
      for (let i = 0; i < 2 && !result.hasContent; i++) {
        result = await attemptCopy();
      }
    } catch (e) {
      try { targetDoc.removeEventListener('copy', onCopy, false); } catch (_) {}
      window.removeEventListener('copy', onCopy, false);
      throw new Error('Could not access the document text. ' + (e.message || e));
    }

    try { targetDoc.removeEventListener('copy', onCopy, false); } catch (_) {}
    window.removeEventListener('copy', onCopy, false);

    try {
      if (targetWin) {
        targetWin.focus();
        const evt = new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          code: 'ArrowRight',
          keyCode: 39,
          which: 39,
          bubbles: true,
          cancelable: true
        });
        (targetDoc.body || targetDoc.documentElement).dispatchEvent(evt);
      }
    } catch (_) {}

    if (!result.copyOk && !captured) {
      return null;
    }
    if (!captured) {
      return null;
    }

    return parseClipboardPayload(captured.html, captured.plain);
  }

  async function extractViaExport() {
    const docId = getDocIdFromUrl();
    if (!docId) {
      return { text: '', images: [] };
    }

    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=html`;
    let response;
    try {
      response = await fetch(exportUrl, { credentials: 'include' });
    } catch (err) {
      throw new Error('Could not fetch the Google Docs export. ' + (err.message || err));
    }

    if (!response.ok) {
      throw new Error('Google Docs export failed with status ' + response.status + '.');
    }

    const html = await response.text();
    const parsed = parseExportHtml(html);
    if ((parsed.text || '').trim().length === 0 && parsed.images.length === 0) {
      const txt = await fetchTextExport(docId);
      if ((txt || '').trim().length > 0) {
        return { text: normalizePlainTextBreaks(txt), images: [] };
      }
    }
    return parsed;
  }

  async function fetchTextExport(docId) {
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const response = await fetch(exportUrl, { credentials: 'include' });
    if (!response.ok) {
      throw new Error('Google Docs text export failed with status ' + response.status + '.');
    }
    return await response.text();
  }

  function getDocIdFromUrl() {
    const href = window.location.href || '';
    const m = href.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) ||
              href.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];

    try {
      const titleLink = document.querySelector('a[href*="/document/d/"]');
      const href2 = titleLink && titleLink.getAttribute('href');
      const m2 = href2 && href2.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
      if (m2) return m2[1];
    } catch (_) {}

    return null;
  }

  // Google Docs' plain-text streams (clipboard text/plain, /export?format=txt)
  // use U+000B (vertical tab) for a soft line break (Shift+Enter) and U+000C
  // (form feed) for a manual page break. Neither has any effect as a bare
  // '\n' in LaTeX source (a single newline is ordinary whitespace there), so
  // map them to real LaTeX breaks before folding into the body text.
  function normalizePlainTextBreaks(t) {
    return (t || '')
      .replace(/\u000C/g, '\n\\newpage\n')
      .replace(/\u000B/g, '\\\\\n')
      .replace(/\u00A0/g, ' ')
      .replace(/\\\\(?=\s*\n\s*\n)/g, '')
      .replace(/\\\\\s*$/, '');
  }

  function parseClipboardPayload(html, plain) {
    const images = [];
    if (html) {
      try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const text = htmlNodeToLatex(doc.body, images);
        return {
          text: normalizePlainTextBreaks(text),
          images,
          richHtml: true
        };
      } catch (_) {
        // Fall through to plain text.
      }
    }

    return {
      text: normalizePlainTextBreaks(plain),
      images,
      richHtml: false
    };
  }

  function parseExportHtml(html) {
    const images = [];
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const text = htmlNodeToLatex(doc.body, images);
      return {
        text: normalizePlainTextBreaks(text),
        images
      };
    } catch (err) {
      return { text: '', images: [] };
    }
  }

  function htmlNodeToLatex(root, imagesOut) {
    const out = [];
    let imgIdx = 0;

    // Google Docs HTML exports put most character formatting in generated
    // classes (for example `.c4{font-weight:700}`), not inline style
    // attributes. DOMParser does not give this detached document a usable
    // getComputedStyle(), so retain the declarations for simple class rules
    // and combine them with each element's inline style below.
    const classStyleText = new Map();
    const parsedDocument = root.ownerDocument;
    for (const styleNode of parsedDocument.querySelectorAll('style')) {
      const css = (styleNode.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '');
      const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
      let rule;
      while ((rule = rulePattern.exec(css)) !== null) {
        for (const rawSelector of rule[1].split(',')) {
          const selector = rawSelector.trim();
          // Docs' character styles use a single class selector, sometimes
          // prefixed by the element name. Ignore structural/list selectors.
          const match = selector.match(/^(?:[a-z][\w-]*)?\.([_a-zA-Z][\w-]*)$/i);
          if (!match) continue;
          const previous = classStyleText.get(match[1]) || '';
          classStyleText.set(match[1], previous + ';' + rule[2]);
        }
      }
    }

    function styleTextForElement(el) {
      const classText = Array.from(el.classList || [])
        .map(name => classStyleText.get(name) || '')
        .join(';');
      // Inline declarations come last and therefore override class rules.
      return (classText + ';' + (el.getAttribute('style') || '')).toLowerCase();
    }

    function cssProperty(style, property) {
      const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('(?:^|;)\\s*' + escaped + '\\s*:\\s*([^;]+)', 'ig');
      let value = null;
      let match;
      while ((match = pattern.exec(style)) !== null) {
        value = match[1].replace(/\s*!important\s*$/i, '').trim();
      }
      return value;
    }

    function formatFromElement(el, inherited) {
      const tag = el.tagName.toLowerCase();
      const style = styleTextForElement(el);
      const weight = cssProperty(style, 'font-weight');
      const fontStyle = cssProperty(style, 'font-style');
      const decoration = cssProperty(style, 'text-decoration-line') ?? cssProperty(style, 'text-decoration');
      const numericWeight = weight == null ? NaN : Number.parseInt(weight, 10);

      return {
        bold: weight == null
          ? inherited.bold || tag === 'b' || tag === 'strong'
          : /^(?:bold|bolder)$/.test(weight) || numericWeight >= 600,
        italic: fontStyle == null
          ? inherited.italic || tag === 'i' || tag === 'em'
          : /^(?:italic|oblique)\b/.test(fontStyle),
        underline: decoration == null
          ? inherited.underline || tag === 'u'
          : /\bunderline\b/.test(decoration),
        color: colorFromElement(el) || inherited.color
      };
    }

    // A blank line is how LaTeX marks a paragraph break, but it is a hard
    // error inside math/verbatim/tabular environments and loosens list
    // spacing. Track how deep we are inside those, so a Docs paragraph
    // break degrades back to a bare newline there.
    const TIGHT_ENV = /\\(begin|end)\s*\{\s*(equation\*?|align(?:at)?\*?|gather\*?|multline\*?|flalign\*?|eqnarray\*?|displaymath|split|array|[bBpvV]matrix|smallmatrix|cases|dcases|verbatim|lstlisting|minted|tabular[*x]?|itemize|enumerate|description)\s*\}/g;
    let envDepth = 0;

    function trackEnv(t) {
      TIGHT_ENV.lastIndex = 0;
      let m;
      while ((m = TIGHT_ENV.exec(t)) !== null) {
        if (m[1] === 'begin') envDepth++;
        else if (envDepth > 0) envDepth--;
      }
    }

    function colorToHex(value) {
      const color = String(value || '').trim();
      let match = color.match(/^#([0-9a-f]{6})$/i);
      if (match) return match[1].toUpperCase();
      match = color.match(/^#([0-9a-f]{3})$/i);
      if (match) return match[1].split('').map(ch => ch + ch).join('').toUpperCase();
      match = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      if (!match) return null;
      return match.slice(1, 4).map(n => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0')).join('').toUpperCase();
    }

    function colorFromElement(el) {
      const style = styleTextForElement(el);
      return colorToHex(cssProperty(style, 'color') || el.getAttribute('color'));
    }

    // Preserve document colours without colouring LaTex syntax or inline math.
    // xcolor is already part of both shipped default preambles.
    function formatText(text, fmt) {
      let result = text;
      if (fmt.color && fmt.color !== '000000') {
        result = result.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$|\\\\|\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})*)/g)
          .map(part => {
            if (!part || !part.trim() || part.startsWith('$') || part.startsWith('\\')) return part;
            return '\\textcolor[HTML]{' + fmt.color + '}{' + part + '}';
          })
          .join('');
      }
      if (fmt.italic)    result = '\\textit{' + result + '}';
      if (fmt.bold)      result = '\\textbf{' + result + '}';
      if (fmt.underline) result = '\\underline{' + result + '}';
      return result;
    }

    function cssWidthToPt(value) {
      const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)\s*(px|pt|in|cm|mm)?$/i);
      if (!match) return null;
      const amount = Number(match[1]);
      const unit = (match[2] || 'px').toLowerCase();
      const factor = { px: 0.75, pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4 }[unit];
      return factor ? amount * factor : null;
    }

    function elementWidthPt(el) {
      // Docs HTML exports normally assign table-cell widths through generated
      // classes rather than inline declarations. Use the resolved class +
      // inline style text so those widths do not fall back to equal columns.
      const style = styleTextForElement(el);
      return cssWidthToPt(cssProperty(style, 'width') || el.getAttribute('width'));
    }

    function elementHeightPt(el) {
      const style = styleTextForElement(el);
      return cssWidthToPt(
        cssProperty(style, 'height') ||
        cssProperty(style, 'min-height') ||
        el.getAttribute('height')
      );
    }

    // Google Docs includes tables in both its clipboard HTML and its HTML
    // export.  A table has no useful representation in the plain-text
    // fallback, so convert it while we still have the row/cell structure.
    // Cell text deliberately remains LaTeX source (as does all other text
    // extracted by this extension), which means users can still use commands
    // such as $x^2$ inside a cell.  A literal ampersand should therefore be
    // written as \& in the Google Doc, just as it would in a .tex file.
    function tableCellToLatex(cell) {
      const pieces = [];

      function collect(node, fmt) {
        if (node.nodeType === Node.TEXT_NODE) {
          let text = node.nodeValue || '';
          // Indentation/newlines in exported table HTML are layout whitespace,
          // not table-cell content.  A tabular `l` column cannot safely hold
          // paragraph breaks, so fold those to spaces.
          text = text.replace(/\s+/g, ' ');
          if (!text) return;
          pieces.push(formatText(text, fmt));
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const child = node;
        const childTag = child.tagName.toLowerCase();
        if (childTag === 'br') {
          pieces.push(' ');
          return;
        }
        // Nested Docs tables are uncommon and cannot be represented safely in
        // a single tabular cell without extra packages; retain their text.
        if (childTag === 'table') {
          pieces.push((child.textContent || '').replace(/\s+/g, ' '));
          return;
        }

        const nextFmt = formatFromElement(child, fmt);
        for (const grandchild of child.childNodes) collect(grandchild, nextFmt);
        if (/^(?:p|div|li|h[1-6]|blockquote)$/.test(childTag)) pieces.push(' ');
      }

      for (const child of cell.childNodes) {
        collect(child, { bold: false, italic: false, underline: false, color: colorFromElement(cell) });
      }
      return pieces.join('').replace(/\s+/g, ' ').trim();
    }

    function emitTable(table) {
      const rows = Array.from(table.rows || []).map(row => Array.from(row.cells || []));
      const cellSpan = cell => Math.max(1, Number(cell.colSpan) || 1);
      const columnCount = rows.reduce(
        (widest, cells) => Math.max(widest, cells.reduce((count, cell) => count + cellSpan(cell), 0)),
        0
      );
      if (!columnCount) return;

      // Docs' HTML export normally puts widths on <col> elements; some
      // documents instead put them on individual cells. Preserve either form
      // as fixed-width LaTeX paragraph columns.
      const columnWidths = Array(columnCount).fill(null);
      Array.from(table.querySelectorAll('col')).forEach((col, index) => {
        if (index < columnCount && col.closest('table') === table) columnWidths[index] = elementWidthPt(col);
      });
      rows.forEach(cells => {
        let column = 0;
        cells.forEach(cell => {
          const span = cellSpan(cell);
          const width = elementWidthPt(cell);
          if (width) {
            const each = width / span;
            for (let i = column; i < Math.min(column + span, columnCount); i++) {
              if (!columnWidths[i]) columnWidths[i] = each;
            }
          }
          column += span;
        });
      });
      const columnSpec = (start, span) => {
        const widths = columnWidths.slice(start, start + span);
        const total = widths.every(Boolean) ? widths.reduce((sum, width) => sum + width, 0) : null;
        return total ? 'p{' + Math.max(12, Math.round(total)) + 'pt}' : 'l';
      };

      // Vertical rules plus a \hline per row give Docs users a faithful,
      // readable default without needing an additional LaTeX package.
      out.push('\n\\begin{center}\n\\begin{tabular}{|' + Array.from({ length: columnCount }, (_, i) => columnSpec(i, 1)).join('|') + '|}\n\\hline\n');
      rows.forEach((cells, rowIndex) => {
        const values = [];
        let usedColumns = 0;
        cells.forEach((cell) => {
          const span = cellSpan(cell);
          const value = tableCellToLatex(cell);
          values.push(span > 1 ? '\\multicolumn{' + span + '}{|' + columnSpec(usedColumns, span) + '|}{' + value + '}' : value);
          usedColumns += span;
        });
        while (usedColumns++ < columnCount) values.push('');
        const rowElement = table.rows[rowIndex];
        const rowHeight = elementHeightPt(rowElement) || cells.reduce((height, cell) => {
          const cellHeight = elementHeightPt(cell);
          const span = Math.max(1, Number(cell.rowSpan) || 1);
          return Math.max(height, cellHeight ? cellHeight / span : 0);
        }, 0);
        if (rowHeight && values.length > 0) {
          // A zero-width strut gives tabular the same minimum row height while
          // allowing wrapped/tall content to expand the row naturally.
          values[0] = '\\rule[-3pt]{0pt}{' + Math.max(6, Math.round(rowHeight)) + 'pt}' + values[0];
        }
        out.push(values.join(' & ') + ' \\\\ \\hline\n');
      });
      out.push('\\end{tabular}\n\\end{center}\n\n');
    }

    function walk(node, fmt) {
      if (node.nodeType === Node.TEXT_NODE) {
        let t = node.nodeValue;
        if (!t) return;
        if (!t.trim() && /\n/.test(t)) return;
        trackEnv(t);
        out.push(formatText(t, fmt));
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = node;
      const tag = el.tagName.toLowerCase();

      if (tag === 'table') {
        emitTable(el);
        return;
      }

      if (tag === 'img') {
        const src = el.getAttribute('src') || '';
        if (!src.startsWith('data:')) return;

        const m = src.match(/^data:([^;]+);base64,(.+)$/);
        if (!m) return;

        imgIdx++;
        const mime = m[1] || 'image/png';
        const b64 = m[2];
        const ext = /jpe?g/.test(mime) ? 'jpg' : 'png';

        let widthPx = 0;
        const wAttr = el.getAttribute('width');
        if (wAttr) widthPx = parseInt(wAttr, 10) || 0;
        if (!widthPx) {
          const style = el.getAttribute('style') || '';
          const wm = style.match(/width\s*:\s*(\d+(?:\.\d+)?)px/i);
          if (wm) widthPx = parseFloat(wm[1]) || 0;
        }
        if (!widthPx) widthPx = 400;
        const widthPt = Math.round(widthPx * 0.75);
        const b64name = 'img' + imgIdx + '.b64';
        const binname = 'img' + imgIdx + '.' + ext;
        imagesOut.push({ uploadFilename: b64name, base64: b64 });

        out.push(
          '\n\\directlua{decodeB64File(\'' + b64name + '\',\'' + binname + '\')}' +
          '\\includegraphics[width=' + widthPt + 'pt,keepaspectratio]{' + binname + '}\n'
        );
        return;
      }

      if (tag === 'br') {
        out.push('\\\\\n');
        return;
      }

      const isBlock = (
        tag === 'p' || tag === 'div' || tag === 'li' ||
        tag === 'h1' || tag === 'h2' || tag === 'h3' ||
        tag === 'h4' || tag === 'h5' || tag === 'h6' ||
        tag === 'blockquote'
      );

      const style = styleTextForElement(el);
      const newFmt = formatFromElement(el, fmt);

      // Google Docs marks a manual page break as `page-break-before: always`
      // on the paragraph that starts the new page (no dedicated element).
      const breaksBefore = /(?:page-break-before:\s*always|break-before:\s*page)/.test(style);
      if (breaksBefore) out.push('\n\\newpage\n');

      for (const c of el.childNodes) walk(c, newFmt);
      if (isBlock) out.push(envDepth > 0 ? '\n' : '\n\n');

      if (/(?:page-break-after:\s*always|break-after:\s*page)/.test(style)) out.push('\n\\newpage\n');
    }

    walk(root, { bold: false, italic: false, underline: false, color: null });
    return out.join('')
      .replace(/\\\\(?=\s*\n\s*\n)/g, '')   // `\\` before a paragraph break has no line to end
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\\\\\s*$/, '');
  }

  // ── Toasts ───────────────────────────────────────────────────────────────

  let toastTimer = null;
  function ensureToast() {
    let t = document.getElementById('bal-toast');
    if (t) return t;
    t = document.createElement('div');
    t.id = 'bal-toast';
    t.className = 'bal-toast';
    document.body.appendChild(t);
    return t;
  }

  function toast(message, kind = 'info', sticky = false) {
    const t = ensureToast();
    t.textContent = message;
    t.className = 'bal-toast show ' + kind;
    clearTimeout(toastTimer);
    if (!sticky) {
      toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
    } else {
      toastTimer = setTimeout(() => t.classList.remove('show'), 12000);
    }
  }
})();
