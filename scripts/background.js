// Background service worker.

import {
  TEXLIVE_ENDPOINT,
  SK,
  DEFAULTS,
  APPS_SCRIPT_URL,
  getDefaultPreamble,
  buildLatexDocument,
  normalizeLatexBody,
  sanitizePdfFilename,
  getSettingsFromStorage,
  getPreambleFromStorage,
  getStyFilesFromStorage,
  getDocumentSettingsKey,
  getDocumentPreambleKey
} from './shared.js';

// ── Formatter backend (Apps Script web app) helpers ─────────────────────────
//
// Content-Type is text/plain so the request stays a CORS "simple request";
// Apps Script's /exec has no doOptions() to answer a preflight. The body is
// still JSON.

async function getAppsScriptUrl() {
  if (!APPS_SCRIPT_URL) {
    throw new Error('No Apps Script formatter URL configured (APPS_SCRIPT_URL is empty in shared.js).');
  }
  return APPS_SCRIPT_URL;
}

async function callAppsScript(url, payload) {
  console.log('[BAL formatter] POST', url);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[BAL formatter] fetch() threw:', err);
    throw new Error('Could not reach the Apps Script formatter. ' + (err.message || err));
  }

  // Google's error pages explain the failure, so keep the body for the message.
  const rawText = await response.text();
  console.log('[BAL formatter] response', response.status, response.url, '\nbody:', rawText);

  if (!response.ok) {
    throw new Error(
      'Apps Script formatter returned status ' + response.status +
      ' from ' + response.url + '.\n\nFull response body:\n' + rawText
    );
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (parseError) {
    // Usually Google's consent page: the user hasn't authorized the script yet.
    throw new Error(
      'Apps Script formatter returned a non-JSON response (likely an auth/consent ' +
      'page — open the /exec URL directly in a browser tab to authorize it). ' +
      'JSON parse error: ' + (parseError.message || parseError) +
      '\n\nFull response body:\n' + rawText
    );
  }
  if (data.ok === false) {
    console.error('[BAL formatter] Apps Script reported a structured error:', data);
    const details = data.details
      ? '\n\nFull Apps Script diagnostic:\n' + JSON.stringify(data.details, null, 2)
      : '';
    throw new Error((data.error || 'Apps Script formatter error.') + details);
  }
  return data;
}

// MV3 service workers are killed after ~30 s idle, which would drop a long
// texlive.net render mid-fetch. A no-op alarm every ~25 s keeps it alive.
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

// Don't set Content-Type by hand for FormData; the browser adds the boundary.
function buildFormData(latexSource, images, styFiles) {
  const fd = new FormData();

  fd.append('filename[]',     'document.tex');
  fd.append('filecontents[]', latexSource);

  for (const img of (images || [])) {
    fd.append('filename[]',     img.uploadFilename);
    fd.append('filecontents[]', img.base64);
  }

  for (const sty of (styFiles || [])) {
    fd.append('filename[]',     sty.name);
    fd.append('filecontents[]', sty.content);
  }

  fd.append('return', 'pdf');
  fd.append('engine', 'lualatex');

  return fd;
}

// texlive.net occasionally drops connections, so retry with back-off.
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS   = 90_000;
const BACKOFF_MS   = 2_000;

async function fetchWithRetry(url, formData) {
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        body:   formData,
        signal: controller.signal
      });
      clearTimeout(timer);
      return response;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;

      const isAbort   = err.name === 'AbortError';
      const isNetwork = err instanceof TypeError;

      if (!isAbort && !isNetwork) throw err;
      if (attempt === MAX_ATTEMPTS) break;

      await new Promise(r => setTimeout(r, BACKOFF_MS * attempt));
    }
  }

  throw new Error(
    `Network error: could not reach texlive.net after ${MAX_ATTEMPTS} attempts.\n` +
    `Check your internet connection and try again.\n\n` +
    `Detail: ${lastErr?.message || lastErr}`
  );
}

// ── Render pipeline ──────────────────────────────────────────────────────────

async function renderPdf({ title, bodyText, images, docId }) {
  const [settings, preambleData, styFiles] = await Promise.all([
    getSettingsFromStorage(docId),
    getPreambleFromStorage(docId),
    getStyFilesFromStorage()
  ]);

  const normalizedBody = normalizeLatexBody(bodyText);
  if (!normalizedBody && (!images || images.length === 0)) {
    throw new Error('This Google Doc is empty. Add LaTeX content then try again.');
  }

  const fullSource = buildLatexDocument(title, normalizedBody, settings, preambleData.preamble);
  const formData   = buildFormData(fullSource, images || [], styFiles);

  const response = await fetchWithRetry(TEXLIVE_ENDPOINT, formData);

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('pdf')) {
    const errText = await response.text().catch(() => '(could not read error body)');
    throw new Error(formatLatexError(errText));
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    base64:   arrayBufferToBase64(arrayBuffer),
    fileName: sanitizePdfFilename(title) + '.pdf'
  };
}

// ── Keyboard commands ────────────────────────────────────────────────────────
//
// In-page keydown listeners can't see keys while Chrome's PDF viewer has
// focus, so the shortcuts are also chrome.commands. Route them to the active
// Docs tab, or to the last Docs tab that rendered (new-tab mode).

let lastDocsTabId = null;

const DOCS_URL_RE = /^https:\/\/docs\.google\.com\/document\//;

async function resolveDocsTabId() {
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && DOCS_URL_RE.test(active.url || '')) return active.id;
  } catch (_) {}

  if (lastDocsTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastDocsTabId);
      if (tab && DOCS_URL_RE.test(tab.url || '')) return lastDocsTabId;
    } catch (_) { /* tab closed */ }
  }

  try {
    const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/document/*' });
    if (tabs && tabs.length) return tabs[0].id;
  } catch (_) {}

  return null;
}

chrome.commands.onCommand.addListener(async (command) => {
  const type = command === 'download' ? 'download' : 'render';
  const tabId = await resolveDocsTabId();
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, { type }, () => void chrome.runtime.lastError);
});

// ── Message router ───────────────────────────────────────────────────────────

const POPUP_ROUTE_KEY = 'bal_openPopupView';
const ACTION_POPUP_URL = chrome.runtime.getURL('html/popup.html');

async function getActionPopupContexts() {
  if (typeof chrome.runtime.getContexts !== 'function') return [];
  return chrome.runtime.getContexts({
    contextTypes: ['POPUP'],
    documentUrls: [ACTION_POPUP_URL]
  });
}

async function waitForActionPopupToClose(timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await getActionPopupContexts()).length === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 16));
  }
  return (await getActionPopupContexts()).length === 0;
}

async function sendPopupNavigation(route) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'navigatePopupView',
      view: route.view,
      requestId: route.requestId
    });
    return response?.ok === true;
  } catch (_) {
    // Popup may not have its listener yet; it reads the route from storage.
    return false;
  }
}

async function clearPopupRoute(route) {
  const pending = await chrome.storage.session.get([POPUP_ROUTE_KEY]);
  if (pending[POPUP_ROUTE_KEY]?.requestId === route.requestId) {
    await chrome.storage.session.remove([POPUP_ROUTE_KEY]);
  }
}

async function openActionPopupView(view, sender) {
  if (view !== 'settings' && view !== 'preamble') {
    throw new Error('Unknown popup view: ' + view);
  }

  // Store the route first so the popup knows which page to show on startup.
  const route = {
    view,
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`
  };
  await chrome.storage.session.set({ [POPUP_ROUTE_KEY]: route });

  const existingContexts = await getActionPopupContexts();
  if (existingContexts.length > 0) {
    if (sender.tab) {
      // A click inside Docs dismisses the open popup; wait for that to finish
      // before opening a new one, otherwise navigate the existing popup.
      const closed = await waitForActionPopupToClose();
      if (!closed) {
        await sendPopupNavigation(route);
        return;
      }
    } else {
      await sendPopupNavigation(route);
      return;
    }
  }

  const options = sender.tab?.windowId == null
    ? undefined
    : { windowId: sender.tab.windowId };

  try {
    if (options) await chrome.action.openPopup(options);
    else await chrome.action.openPopup();
  } catch (error) {
    // The popup may have opened in the meantime; route it instead of failing.
    const contextsAfterError = await getActionPopupContexts();
    if (contextsAfterError.length === 0) {
      await clearPopupRoute(route);
      throw error;
    }
    await sendPopupNavigation(route);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (sender.tab && DOCS_URL_RE.test(sender.tab.url || '')) {
        lastDocsTabId = sender.tab.id;
      }

      switch (msg.type) {

        case 'render': {
          const result = await renderPdf(msg.payload);
          sendResponse({ ok: true, base64: result.base64, fileName: result.fileName });
          break;
        }

        case 'download': {
          const result = await renderPdf(msg.payload);
          const dataUrl = 'data:application/pdf;base64,' + result.base64;
          await chrome.downloads.download({
            url:      dataUrl,
            filename: result.fileName,
            saveAs:   false
          });
          sendResponse({ ok: true, fileName: result.fileName });
          break;
        }

        case 'getSettings':
          sendResponse({ ok: true, settings: await getSettingsFromStorage(msg.docId) });
          break;

        case 'saveSettings': {
          const updates = {};
          for (const k in msg.values) updates[k] = msg.values[k];
          if (msg.docId) {
            await chrome.storage.local.set({ [getDocumentSettingsKey(msg.docId)]: updates });
          } else {
            await chrome.storage.local.set(updates);
          }
          const tabs = await chrome.tabs.query({ url: 'https://docs.google.com/document/*' });
          for (const tab of tabs) {
            if (sender.tab && tab.id === sender.tab.id) continue;
            chrome.tabs.sendMessage(tab.id, { type: 'settingsChanged' }).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }

        case 'resetSettings': {
          await chrome.storage.local.remove([
            SK.DOC_TYPE, SK.FONT_FAMILY, SK.FONT_SIZE,
            SK.CLR_DEFAULT, SK.CLR_COMMAND, SK.CLR_ENV_NAME,
            SK.CLR_MATH_CONTENT, SK.CLR_MATH_COMMAND, SK.CLR_COMMENT
          ]);
          sendResponse({ ok: true, defaults: DEFAULTS });
          break;
        }

        case 'getPreamble':
          sendResponse({ ok: true, ...(await getPreambleFromStorage(msg.docId)) });
          break;

        case 'savePreamble':
          await chrome.storage.local.set({
            [msg.docId ? getDocumentPreambleKey(msg.docId) : SK.PREAMBLE]: msg.preamble
          });
          sendResponse({ ok: true });
          break;

        case 'resetPreamble':
          await chrome.storage.local.remove([SK.PREAMBLE]);
          sendResponse({ ok: true, ...(await getPreambleFromStorage()) });
          break;

        case 'listStyFiles': {
          const list = await getStyFilesFromStorage();
          sendResponse({ ok: true, files: list.map(f => ({ name: f.name })) });
          break;
        }

        case 'saveStyFile': {
          const stored = await chrome.storage.local.get([SK.STY_FILES]);
          const files  = stored[SK.STY_FILES] || {};
          files[msg.filename] = msg.content;
          await chrome.storage.local.set({ [SK.STY_FILES]: files });
          const list = await getStyFilesFromStorage();
          sendResponse({ ok: true, files: list.map(f => ({ name: f.name })) });
          break;
        }

        case 'deleteStyFile': {
          const stored = await chrome.storage.local.get([SK.STY_FILES]);
          const files  = stored[SK.STY_FILES] || {};
          delete files[msg.filename];
          await chrome.storage.local.set({ [SK.STY_FILES]: files });
          const list = await getStyFilesFromStorage();
          sendResponse({ ok: true, files: list.map(f => ({ name: f.name })) });
          break;
        }

        case 'openPage':
          chrome.tabs.create({ url: chrome.runtime.getURL(msg.page) });
          sendResponse({ ok: true });
          break;

        case 'openPopupView': {
          await openActionPopupView(msg.view, sender);
          sendResponse({ ok: true });
          break;
        }

        // Formatter calls are relayed here because content scripts are
        // subject to CORS and the service worker is not.

        case 'formatRead': {
          const url = await getAppsScriptUrl();
          const result = await callAppsScript(url, { op: 'read', docId: msg.docId });
          sendResponse(result);
          break;
        }

        case 'formatApply': {
          const url = await getAppsScriptUrl();
          const result = await callAppsScript(url, { op: 'apply', docId: msg.docId, ops: msg.ops });
          sendResponse(result);
          break;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type: ' + msg.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  })();
  return true;
});

// ── Utilities ────────────────────────────────────────────────────────────────

// Pull the "! ..." error blocks (with their "l.N" source pointer) to the top
// of a LaTeX log, followed by the tail of the log for context.
function formatLatexError(log) {
  if (!log) return 'LaTeX compilation failed (no log returned by texlive.net).';

  const lines = log.split(/\r?\n/);
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('!')) {
      const block = [line];
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const next = lines[j];
        if (next.startsWith('!')) break;
        block.push(next);
        if (/^l\.\d+/.test(next.trim())) {
          if (j + 1 < lines.length) block.push(lines[j + 1]);
          break;
        }
      }
      errors.push(block.join('\n').trim());
      i += block.length - 1;
    }
  }

  let out = '';

  if (errors.length > 0) {
    out += '── ERROR' + (errors.length > 1 ? 'S' : '') + ' ──\n\n';
    out += errors.join('\n\n────────\n\n');
    out += '\n\n── FULL LOG (last 3000 chars) ──\n\n';
    out += log.slice(-3000);
  } else {
    out += 'LaTeX compilation failed but no explicit error line was found.\n\n';
    out += '── FULL LOG (last 5000 chars) ──\n\n';
    out += log.slice(-5000);
  }

  return out;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary  = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
