// Settings page controller. Values can be saved for this Google Doc or set
// as the defaults inherited by documents that do not have an override.

import { SK, DEFAULTS } from './shared.js';

const $ = id => document.getElementById(id);
let activeDocId = null;

function setStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (isErr ? ' err' : '');
  if (msg && !isErr) setTimeout(() => { el.textContent = ''; }, 2500);
}

function call(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r || r.ok === false) return reject(new Error((r && r.error) || 'Request failed'));
      resolve(r);
    });
  });
}

async function getActiveDocId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = tabs.find(t => /docs\.google\.com\/document\/d\//.test(t.url || ''));
  if (!tab) {
    const docsTabs = await chrome.tabs.query({ url: 'https://docs.google.com/document/*' });
    tab = docsTabs[0];
  }
  const match = tab && (tab.url || '').match(/\/document\/d\/([^/?]+)/);
  return match ? match[1] : null;
}

function applySettings(s) {
  $('docType').value         = s.docType;
  $('fontFamily').value      = s.fontFamily;
  $('fontSize').value        = s.fontSize;
  $('clrDefault').value      = s.clrDefault;
  $('clrCommand').value      = s.clrCommand;
  $('clrEnvName').value      = s.clrEnvName;
  $('clrMathContent').value  = s.clrMathContent;
  $('clrMathCommand').value  = s.clrMathCommand;
  $('clrComment').value      = s.clrComment;
}

function collect() {
  return {
    [SK.DOC_TYPE]:         $('docType').value.trim().toLowerCase() || DEFAULTS.docType,
    [SK.FONT_FAMILY]:      $('fontFamily').value.trim() || DEFAULTS.fontFamily,
    [SK.FONT_SIZE]:        String($('fontSize').value || DEFAULTS.fontSize),
    [SK.CLR_DEFAULT]:      $('clrDefault').value,
    [SK.CLR_COMMAND]:      $('clrCommand').value,
    [SK.CLR_ENV_NAME]:     $('clrEnvName').value,
    [SK.CLR_MATH_CONTENT]: $('clrMathContent').value,
    [SK.CLR_MATH_COMMAND]: $('clrMathCommand').value,
    [SK.CLR_COMMENT]:      $('clrComment').value
  };
}

async function save(scope) {
  if (scope === 'document' && !activeDocId) {
    setStatus('Open a Google Doc to save document settings.', true);
    return;
  }
  setStatus(scope === 'document' ? 'Saving...' : 'Setting default...');
  try {
    await call({
      type: 'saveSettings',
      values: collect(),
      docId: scope === 'document' ? activeDocId : undefined
    });
    setStatus(scope === 'document' ? 'Saved for this document.' : 'Default saved for new documents.');
  } catch (e) {
    setStatus(e.message || 'Save failed', true);
  }
}

export async function init() {
  $('saveBtn').addEventListener('click', () => save('document'));
  $('setDefaultBtn').addEventListener('click', () => save('default'));

  try {
    activeDocId = await getActiveDocId();
    const r = await call({ type: 'getSettings', docId: activeDocId || undefined });
    applySettings(r.settings);
  } catch (e) {
    setStatus('Could not load settings: ' + (e.message || e), true);
  }
}
