import { init as initSettings } from './settings.js';
import { init as initPreamble } from './preamble.js';

const $ = (id) => document.getElementById(id);
const popup = document.querySelector('.popup');
const mainActions = $('mainActions');
const pageView = $('pageView');
const pageContent = $('pageContent');
const statusText = $('statusText');
const backBtn = $('backBtn');
const noDocStatus = 'Open a Google Doc to get started.';

let activeView = 'home';
let saveTimer = null;

function setStatus(text) {
  if (text === noDocStatus) {
    statusText.innerHTML = '<a href="https://docs.new/" data-open-google-doc>Open a Google Doc to get started.</a>';
  } else {
    statusText.textContent = text;
  }
}

statusText.addEventListener('click', (event) => {
  if (!event.target.closest('[data-open-google-doc]')) return;
  event.preventDefault();
  chrome.tabs.create({ url: 'https://docs.new/' });
});

let viewTransitioning = false;
let homeTransitionTimer = null;

function setView(view, pageTitle) {
  // A route sent by the background must be able to replace any current page,
  // including while the Back animation is still finishing.
  if (viewTransitioning && view === 'home') return;
  if (view !== 'home' && homeTransitionTimer !== null) {
    clearTimeout(homeTransitionTimer);
    homeTransitionTimer = null;
  }
  activeView = view;

  if (pageTitle) {
    const heading = document.getElementById('pageHeading');
    const eyebrow = document.getElementById('pageEyebrow');
    if (heading) heading.textContent = pageTitle;
    if (eyebrow) eyebrow.textContent = view === 'settings' ? 'Configuration' : 'Document';
  }

  if (view === 'home') {
    viewTransitioning = true;
    backBtn && backBtn.classList.add('hidden');

    // Fade panel out, then snap window back and show main actions
    pageView.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    pageView.style.opacity = '0';
    pageView.style.transform = 'translateY(10px)';

    homeTransitionTimer = setTimeout(() => {
      homeTransitionTimer = null;
      pageView.classList.add('hidden');
      pageView.style.transition = '';
      pageView.style.opacity = '';
      pageView.style.transform = '';
      pageContent.innerHTML = '';
      popup.classList.remove('page-mode');

      mainActions.classList.remove('hidden');
      mainActions.style.animation = 'none';
      mainActions.offsetHeight;
      mainActions.style.animation = '';
      viewTransitioning = false;
    }, 210);

  } else {
    viewTransitioning = true;
    mainActions.classList.add('hidden');
    popup.classList.add('page-mode');
    backBtn && backBtn.classList.remove('hidden');

    // Start panel invisible, then fade in on next frame
    pageView.style.opacity = '0';
    pageView.style.transform = 'translateY(10px)';
    pageView.style.transition = '';
    pageView.classList.remove('hidden');

    requestAnimationFrame(() => {
      pageView.style.transition = 'opacity 1.0s cubic-bezier(0.4,0,0.2,1), transform 1.0s cubic-bezier(0.4,0,0.2,1)';
      pageView.style.opacity = '1';
      pageView.style.transform = 'translateY(0)';
      viewTransitioning = false;
    });
  }
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

async function getActiveDocTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs.find(t => t.url && t.url.includes('docs.google.com/document/')) || tabs[0] || null;
}

async function sendToActiveDoc(message) {
  const tab = await getActiveDocTab();

  if (!tab || !tab.id || !tab.url || !tab.url.includes('docs.google.com/document/')) {
    throw new Error('Open a Google Doc first.');
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ['scripts/content.js']
    });
  } catch (_) {
    // content script may already be present
  }

  return await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) {
        reject(new Error('No response from Google Doc page.'));
        return;
      }
      // Blank document is not a failure for the popup — pass through silently
      if (response.blank) {
        resolve(response);
        return;
      }
      if (response.ok === false) {
        reject(new Error(response.error || 'Action failed'));
        return;
      }
      resolve(response);
    });
  });
}

function callRuntime(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!r || r.ok === false) {
        reject(new Error((r && r.error) || 'Request failed'));
        return;
      }
      resolve(r);
    });
  });
}

// ── Enable / disable switch ────────────────────────────────────────────────

const enabledToggle = $('enabledToggle');
const enabledStatus = $('enabledStatus');

function applyEnabledState(on) {
  if (enabledToggle) enabledToggle.checked = on;
  if (enabledStatus) enabledStatus.textContent = on ? 'Extension Enabled' : 'Extension Disabled';
}

async function loadEnabledState() {
  const res = await chrome.storage.local.get(['setting_enabled']);
  const on = res['setting_enabled'] !== false;
  applyEnabledState(on);
}

enabledToggle && enabledToggle.addEventListener('change', async () => {
  const nowOn = enabledToggle.checked;
  await chrome.storage.local.set({ setting_enabled: nowOn });
  applyEnabledState(nowOn);
});

chrome.storage.onChanged.addListener((changes) => {
  if ('setting_enabled' in changes) {
    applyEnabledState(changes['setting_enabled'].newValue !== false);
  }
});

loadEnabledState();

// ── Auto-format mode toggle ────────────────────────────────────────────────

const autoFormatToggle = $('autoFormatToggle');
const autoFormatRow    = $('autoFormatRow');

function applyAutoFormatUI(on) {
  if (autoFormatToggle) autoFormatToggle.checked = on;
  if (autoFormatRow)    autoFormatRow.classList.toggle('on', on);
}

async function loadAutoFormatState() {
  const res = await chrome.storage.local.get(['setting_autoFormat']);
  // Suppress the switch/row transitions for the initial state so the toggle
  // doesn't visibly animate from off→on when the popup first appears.
  if (autoFormatRow) autoFormatRow.classList.add('no-anim');
  applyAutoFormatUI(res['setting_autoFormat'] === true);
  // Re-enable transitions after the first paint so later toggles still animate.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (autoFormatRow) autoFormatRow.classList.remove('no-anim');
    });
  });
}

autoFormatToggle && autoFormatToggle.addEventListener('change', async () => {
  const nowOn = autoFormatToggle.checked;
  await chrome.storage.local.set({ setting_autoFormat: nowOn });
  applyAutoFormatUI(nowOn);
});

// Keep popup in sync if the double-tap hotkey changes the state from the doc tab
chrome.storage.onChanged.addListener((changes) => {
  if ('setting_autoFormat' in changes) {
    applyAutoFormatUI(changes['setting_autoFormat'].newValue === true);
  }
  if ('setting_renderMode' in changes) {
    applyRenderModeUI(changes['setting_renderMode'].newValue || 'split');
  }
});

loadAutoFormatState();

// ── Render mode toggle (Split View / New Tab) ──────────────────────────────

const renderModeSplit = $('renderModeSplit');
const renderModeTab   = $('renderModeTab');

async function loadRenderMode() {
  const res = await chrome.storage.local.get(['setting_renderMode']);
  applyRenderModeUI(res['setting_renderMode'] || 'split');
}

function applyRenderModeUI(mode) {
  if (mode === 'tab') {
    renderModeSplit && renderModeSplit.classList.remove('render-mode-active-split');
    renderModeTab   && renderModeTab.classList.add('render-mode-active-tab');
  } else {
    renderModeSplit && renderModeSplit.classList.add('render-mode-active-split');
    renderModeTab   && renderModeTab.classList.remove('render-mode-active-tab');
  }
}

async function setRenderMode(mode) {
  await chrome.storage.local.set({ setting_renderMode: mode });
  applyRenderModeUI(mode);
}

renderModeSplit && renderModeSplit.addEventListener('click', () => setRenderMode('split'));
renderModeTab   && renderModeTab.addEventListener('click',   () => setRenderMode('tab'));

loadRenderMode();

// Keep the popup from closing when the action it triggered shifts focus to the
// Doc tab (e.g. render reflowing the page for split view). Chrome auto-closes
// an action popup the moment focus leaves it; re-asserting focus on our own
// window right after dispatching keeps it on screen, matching how download
// (which causes no focus shift) already behaves.
function keepPopupFocused() {
  try { window.focus(); } catch (_) {}
  requestAnimationFrame(() => { try { window.focus(); } catch (_) {} });
}

async function doRender() {
  setStatus('Rendering…');
  keepPopupFocused();
  try {
    const r = await sendToActiveDoc({ type: 'render' });
    keepPopupFocused();
    if (r && r.blank) {
      setStatus('');   // blank toast is shown in the doc tab
    } else {
      setStatus('Rendered ' + (r.fileName || 'PDF') + '.');
    }
  } catch (err) {
    // Render/compile errors are displayed in the doc tab (split view or new tab)
    // by the content script. Don't duplicate them here.
    setStatus('');
  }
}

async function doDownload() {
  setStatus('Downloading…');
  keepPopupFocused();
  try {
    const r = await sendToActiveDoc({ type: 'download' });
    keepPopupFocused();
    if (r && r.blank) {
      setStatus('');
    } else {
      setStatus('Downloaded ' + (r.fileName || 'PDF') + '.');
    }
  } catch (err) {
    setStatus('');
  }
}

// ── Format Document (single tap) / Auto-format toggle (double tap) ─────────
//
// Mirrors content.js handleFormatKey: Ctrl+Shift+F once formats the document;
// twice within 400 ms toggles auto-format mode. The button click maps to the
// single-tap "format now" action.
let fTapTimer = null;

async function doFormatNow() {
  setStatus('Formatting…');
  keepPopupFocused();
  try {
    const tab = await getActiveDocTab();
    if (!tab || !tab.url || !tab.url.includes('docs.google.com/document/')) {
      setStatus('Open a Google Doc first.');
      return;
    }
    // formatter.js is already a content script, but executeScript ensures it's loaded
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ['scripts/formatter.js']
      });
    } catch (_) {}
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        if (window.autoLatexFormatNow) {
          await window.autoLatexFormatNow();
        }
      }
    });
    keepPopupFocused();
    setStatus('Formatting applied.');
  } catch (e) {
    setStatus(e.message || String(e));
  }
}

async function toggleAutoFormat() {
  const res = await chrome.storage.local.get(['setting_autoFormat']);
  const nowOn = !(res['setting_autoFormat'] === true);
  await chrome.storage.local.set({ setting_autoFormat: nowOn });
  applyAutoFormatUI(nowOn);
  setStatus(nowOn ? 'Auto-format ON.' : 'Auto-format OFF.');
}

function handleFormatKey() {
  if (fTapTimer !== null) {
    clearTimeout(fTapTimer);
    fTapTimer = null;
    toggleAutoFormat();
  } else {
    fTapTimer = setTimeout(() => {
      fTapTimer = null;
      doFormatNow();
    }, 400);
  }
}

$('renderBtn').addEventListener('click', doRender);
$('downloadBtn').addEventListener('click', doDownload);

// ── Keyboard shortcuts while the popup is focused ──────────────────────────
//
// chrome.commands shortcuts (Ctrl+Shift+Z / Ctrl+Shift+X / Ctrl+Shift+F) fire
// at the browser level and route to the Docs tab — but they're swallowed when
// the popup itself holds focus (the popup is a separate document, not the Docs
// tab). Mirror the same chords here so render/download/format work straight
// from the popup.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === 'z') {
    e.preventDefault();
    doRender();
  } else if (key === 'x') {
    e.preventDefault();
    doDownload();
  } else if (key === 'f') {
    e.preventDefault();
    handleFormatKey();
  }
});

$('format-now-btn').addEventListener('click', doFormatNow);

async function loadPageContent(htmlFile) {
  const url = chrome.runtime.getURL('html/' + htmlFile);
  const res = await fetch(url);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const page = doc.querySelector('.page');
  return page ? page.innerHTML : doc.body.innerHTML;
}

// ── Navigation ─────────────────────────────────────────────────────────────

async function showSettings() {
  setView('settings', 'Settings');
  pageContent.innerHTML = `<div class="status">Loading settings…</div>`;
  try {
    pageContent.innerHTML = await loadPageContent('settings.html');
    await initSettings();
  } catch (e) {
    pageContent.innerHTML = `<div class="status err">Could not load settings: ${escapeHtml(e.message || e)}</div>`;
  }
}

async function showPreamble() {
  setView('preamble', 'Edit Preamble');
  pageContent.innerHTML = `<div class="status">Loading preamble…</div>`;
  try {
    pageContent.innerHTML = await loadPageContent('preamble.html');
    await initPreamble();
  } catch (e) {
    pageContent.innerHTML = `<div class="status err">Could not load preamble: ${escapeHtml(e.message || e)}</div>`;
  }
}

async function navigatePopupView(view) {
  if (view === 'settings') await showSettings();
  else if (view === 'preamble') await showPreamble();
  else throw new Error('Unknown popup view: ' + view);
}

function showHome() { setView('home'); }

$('settingsBtn').addEventListener('click', showSettings);
$('preambleBtn').addEventListener('click', showPreamble);
$('helpBtn').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('html/help.html') });
});
backBtn.addEventListener('click', showHome);

async function clearPendingPopupRoute(requestId) {
  const pending = await chrome.storage.session.get(['bal_openPopupView']);
  const route = pending.bal_openPopupView;
  if (route && route.requestId === requestId) {
    await chrome.storage.session.remove(['bal_openPopupView']);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'navigatePopupView') {
    (async () => {
      try {
        await navigatePopupView(message.view);
        await clearPendingPopupRoute(message.requestId);
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }
});

// ── Init status ────────────────────────────────────────────────────────────

(async () => {
  try {
    const pending = await chrome.storage.session.get(['bal_openPopupView']);
    const route = pending.bal_openPopupView;
    // Accept the old string shape once so extension reloads do not leave a
    // stale pending route behind during development.
    const view = typeof route === 'string' ? route : route?.view;
    if (view === 'settings' || view === 'preamble') {
      await navigatePopupView(view);
      if (typeof route === 'string') {
        await chrome.storage.session.remove(['bal_openPopupView']);
      } else {
        await clearPendingPopupRoute(route.requestId);
      }
    }
  } catch (_) {}
  try {
    const tab = await getActiveDocTab();
    if (tab && tab.url && tab.url.includes('docs.google.com/document/')) {
      setStatus('Ready — ' + (tab.title || 'your document').replace(/ - Google Docs.*$/, '') + '.');
    } else {
      setStatus('Open a Google Doc to get started.');
    }
  } catch (_) {
    setStatus('Open a Google Doc to get started.');
  }
})();
