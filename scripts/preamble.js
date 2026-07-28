// Preamble page controller: document overrides, extension defaults, and .sty files.

const $ = id => document.getElementById(id);
let activeDocId = null;

function setStatus(msg, isErr, target = 'status') {
  const el = $(target);
  el.textContent = msg;
  el.className = 'status' + (isErr ? ' err' : '');
  if (msg && !isErr) setTimeout(() => { el.textContent = ''; }, 2500);
}

function call(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!r || r.ok === false) return reject(new Error((r && r.error) || 'Error'));
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

function applyPreambleResult(result) {
  $('preamble').value = result.preamble;
  const label = $('docTypeLabel');
  if (label) label.textContent = 'Type: ' + (result.docType === 'exam' ? 'Exam' : (result.docType || 'article'));
  const badge = $('customBadge');
  if (badge) {
    badge.textContent = result.isCustom ? 'Custom' : 'Default';
    badge.className = 'badge ' + (result.isCustom ? 'badge-custom' : 'badge-default');
  }
}

async function save(scope) {
  if (scope === 'document' && !activeDocId) {
    setStatus('Open a Google Doc to save a document preamble.', true);
    return;
  }
  const preamble = $('preamble').value;
  if (!preamble.trim()) {
    setStatus('The preamble cannot be empty.', true);
    return;
  }
  setStatus(scope === 'document' ? 'Saving...' : 'Setting default...');
  try {
    await call({ type: 'savePreamble', preamble, docId: scope === 'document' ? activeDocId : undefined });
    const badge = $('customBadge');
    if (badge) {
      badge.textContent = 'Custom';
      badge.className = 'badge badge-custom';
    }
    setStatus(scope === 'document' ? 'Saved for this document.' : 'Default saved for new documents.');
  } catch (e) {
    setStatus(e.message || 'Failed to save.', true);
  }
}

function renderStyList(files) {
  const list = $('styList');
  if (!files || files.length === 0) {
    list.innerHTML = '<span class="sty-empty">No .sty files uploaded.</span>';
    return;
  }
  list.innerHTML = '';
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'sty-item';
    row.innerHTML = '<span class="sty-item-name"></span><button class="sty-delete" title="Delete">&times;</button>';
    row.querySelector('.sty-item-name').textContent = f.name;
    row.querySelector('.sty-delete').addEventListener('click', () => handleStyDelete(f.name));
    list.appendChild(row);
  }
}

async function handleStyUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.name.endsWith('.sty')) {
    setStatus('Only .sty files are supported.', true, 'styStatus');
    input.value = '';
    return;
  }
  setStatus('Uploading ' + file.name + '...', false, 'styStatus');
  try {
    const r = await call({ type: 'saveStyFile', filename: file.name, content: await file.text() });
    renderStyList(r.files);
    setStatus(file.name + ' uploaded.', false, 'styStatus');
  } catch (e) {
    setStatus(e.message || 'Upload failed.', true, 'styStatus');
  } finally {
    input.value = '';
  }
}

async function handleStyDelete(name) {
  if (!confirm('Delete ' + name + '?')) return;
  try {
    const r = await call({ type: 'deleteStyFile', filename: name });
    renderStyList(r.files);
    setStatus(name + ' deleted.', false, 'styStatus');
  } catch (e) {
    setStatus(e.message || 'Delete failed.', true, 'styStatus');
  }
}

export async function init() {
  $('saveBtn').addEventListener('click', () => save('document'));
  $('setDefaultBtn').addEventListener('click', () => save('default'));
  $('styUpload').addEventListener('change', e => handleStyUpload(e.target));
  try {
    activeDocId = await getActiveDocId();
    applyPreambleResult(await call({ type: 'getPreamble', docId: activeDocId || undefined }));
  } catch (e) {
    setStatus('Failed to load preamble: ' + (e.message || e), true);
  }
  try {
    const r = await call({ type: 'listStyFiles' });
    renderStyList(r.files);
  } catch (e) {
    setStatus('Failed to load .sty files: ' + (e.message || e), true, 'styStatus');
  }
}
