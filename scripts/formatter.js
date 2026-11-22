(function(){

// ── Toast (reuses the .bal-toast element from content.js) ───────────────────
let _toastTimer = null;
function toast(msg, kind) {
  let t = document.getElementById('bal-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'bal-toast';
    t.className = 'bal-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'bal-toast show ' + (kind || 'info');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ── Apps Script backend ─────────────────────────────────────────────────────
// Relayed through the background worker, which isn't subject to CORS.
function callBackground(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!res || res.ok === false) { reject(new Error((res && res.error) || 'Formatter request failed')); return; }
      resolve(res);
    });
  });
}

function readDocument(docId) {
  return callBackground({ type: 'formatRead', docId });
}

function applyOps(docId, ops) {
  return callBackground({ type: 'formatApply', docId, ops });
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function getSettings() {
  const docId = getDocId();
  const result = await callBackground({ type: 'getSettings', docId });
  return result.settings;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function getDocId() {
  const m = location.pathname.match(/\/document\/d\/([^/]+)/);
  return m ? m[1] : null;
}

// ── Highlighting ────────────────────────────────────────────────────────────
//
// Order: reset paragraph to clrDefault, then commands, env names, math
// content, math commands, braces (reset), comments. Spans use an
// inclusive end offset to match DocumentApp.setForegroundColor.
function buildHighlightSpans(text, clr) {
  const spans = [];
  const len = text.length;
  if (len === 0) return spans;

  const push = (start, endInclusive, color) => {
    if (endInclusive < start) return;
    spans.push({ start, endInclusive, color });
  };

  push(0, len - 1, clr.def);
  applyPattern(text, /\\[a-zA-Z]*\*?/g, (s, e) => push(s, e, clr.cmd));

  const envRegex = /\\[a-zA-Z]+\*?\{([^}]*)\}/g;
  let m;
  while ((m = envRegex.exec(text)) !== null) {
    const content = m[1];
    if (!content.length) continue;
    const start = m.index + m[0].indexOf('{') + 1;
    push(start, start + content.length - 1, clr.env);
  }

  applyPattern(text, /\$\$[\s\S]*?\$\$|\$[^$]*?\$/g, (s, e) => push(s, e, clr.math));

  const mathSpanRegex = /\$\$[\s\S]*?\$\$|\$[^$]*?\$/g;
  let mathMatch;
  while ((mathMatch = mathSpanRegex.exec(text)) !== null) {
    const offset = mathMatch.index;
    const span   = mathMatch[0];
    const cmdRe  = /\\[a-zA-Z]*\*?/g;
    let cm;
    while ((cm = cmdRe.exec(span)) !== null) {
      push(offset + cm.index, offset + cm.index + cm[0].length - 1, clr.mcmd);
    }
  }

  applyPattern(text, /[{}]/g, (s, e) => push(s, e, clr.def));
  applyPattern(text, /%[^\n]*/g, (s, e) => push(s, e, clr.cmt));

  return spans;
}

function applyPattern(text, regex, cb) {
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    cb(m.index, m.index + m[0].length - 1);
  }
}

// ── Environment indentation ───────────────────────────────────────────────────
//
// Depth is a running count of \begin/\end over the whole document, so
// this pass always covers every paragraph. Only the body between
// \begin and \end is indented; ops are emitted only where indent changes.
const INDENT_STEP_PT = 36; // 0.5 in × 72 PT/in
const BEGIN_RE = /\\begin\s*\{[^}]*\}/g;
const END_RE   = /\\end\s*\{[^}]*\}/g;

function countMatches(text, regex) {
  regex.lastIndex = 0;
  let n = 0;
  while (regex.exec(text) !== null) n++;
  return n;
}

// Returns a Map<paraIndex, neededIndentPt> for paragraphs whose indent
// needs to change — merged into the per-paragraph op below.
function computeIndentChanges(allParas) {
  const changes = new Map();
  let depth = 0;
  allParas.forEach((p, i) => {
    const opens  = countMatches(p.text, BEGIN_RE);
    const closes = countMatches(p.text, END_RE);

    const lineDepth = Math.max(0, depth - closes);
    const neededPt  = lineDepth * INDENT_STEP_PT;

    depth = Math.max(0, depth + opens - closes);

    if (neededPt !== p.curIndentPt) changes.set(i, neededPt);
  });
  return changes;
}

// ── Fingerprint / diff ──────────────────────────────────────────────────────

// `allParas` is needed because indent is computed over the whole document.
function buildOpsForParas(parasToFormat, allParas, settings) {
  const clr = {
    def:  settings.clrDefault,
    cmd:  settings.clrCommand,
    env:  settings.clrEnvName,
    math: settings.clrMathContent,
    mcmd: settings.clrMathCommand,
    cmt:  settings.clrComment,
  };

  const indentChanges = computeIndentChanges(allParas);
  const toFormat = new Set(parasToFormat.map(p => p.index));

  const ops = [];
  allParas.forEach((p) => {
    const needsIndent = indentChanges.has(p.index);
    const needsFormat  = toFormat.has(p.index);
    if (!needsIndent && !needsFormat) return;
    if (p.text.length === 0 && !needsIndent) return;

    const op = { paraIndex: p.index, expectedText: p.text };
    if (needsIndent) op.indentPt = indentChanges.get(p.index);

    if (needsFormat) {
      op.lineSpacing = 1.15; // DocumentApp setLineSpacing is a multiplier, not a %
      if (p.text.length > 0) {
        op.fontFamily = settings.fontFamily;
        op.fontSize   = settings.fontSize;
        op.spans      = buildHighlightSpans(p.text, clr);
      }
    }
    ops.push(op);
  });
  return ops;
}

// ── LCS-based paragraph diff ────────────────────────────────────────────────
// Returns indices in newTexts of paragraphs not in the LCS (new or changed).
function getChangedNewIndices(oldTexts, newTexts) {
  const n = oldTexts.length, m = newTexts.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = oldTexts[i - 1] === newTexts[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const changed = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldTexts[i - 1] === newTexts[j - 1]) {
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      changed.unshift(j - 1);
      j--;
    } else {
      i--;
    }
  }
  return changed;
}

// ── State ─────────────────────────────────────────────────────────────────────
// Paragraph fingerprints from the last successful format. null = no baseline yet.
let _paraSnapshot = null;

window.autoLatexFormatBusy = false;

// paraIndex matches the paragraph enumeration order in AppsScript.gs.
function withIndex(paragraphs) {
  return paragraphs.map((p, index) => ({ ...p, index }));
}

// ── Full format — manual Ctrl+Shift+F ────────────────────────────────────────
async function formatNow() {
  if (window.autoLatexFormatBusy) return;
  window.autoLatexFormatBusy = true;
  try {
    toast('Formatting...', 'info');
    const docId = getDocId();
    if (!docId) { toast('Could not find document ID.', 'err'); return; }

    const settings = await getSettings();
    const readRes = await readDocument(docId);
    const paras = withIndex(readRes.paragraphs);
    _paraSnapshot = paras.map(p => p.fingerprint);

    const ops = buildOpsForParas(paras, paras, settings);
    if (ops.length === 0) { toast('Nothing to format.', 'info'); return; }

    const applyRes = await applyOps(docId, ops);
    if (applyRes.skipped && applyRes.skipped.length) {
      // Paragraphs edited between read and apply get retried next pass.
      _paraSnapshot = null;
    }
    toast('Formatting applied. ✓', 'ok');
  } catch (e) {
    console.error(e);
    toast('Format error: ' + (e.message || e), 'err');
  } finally {
    window.autoLatexFormatBusy = false;
  }
}

// ── Delta format — auto-format mode ──────────────────────────────────────────
// Silent: no "Formatting…" / "Formatting applied" toasts (errors still show).
async function formatDelta() {
  if (window.autoLatexFormatBusy) return;
  window.autoLatexFormatBusy = true;
  try {
    const docId = getDocId();
    if (!docId) return;

    const settings = await getSettings();
    const readRes = await readDocument(docId);
    const paras = withIndex(readRes.paragraphs);
    const newFingerprints = paras.map(p => p.fingerprint);

    let parasToFormat;
    if (!_paraSnapshot) {
      parasToFormat = paras;
    } else {
      const changedIdx = getChangedNewIndices(_paraSnapshot, newFingerprints);
      parasToFormat = changedIdx.map(i => paras[i]).filter(Boolean);
    }

    const ops = buildOpsForParas(parasToFormat, paras, settings);
    if (ops.length === 0) {
      _paraSnapshot = newFingerprints;
      return;
    }

    const applyRes = await applyOps(docId, ops);

    // A skipped op means the paragraph changed between read and apply; drop it
    // from the baseline so it's re-read and retried next cycle.
    if (applyRes.skipped && applyRes.skipped.length) {
      const skippedSet = new Set(applyRes.skipped);
      _paraSnapshot = newFingerprints.map((fp, i) => skippedSet.has(i) ? null : fp);
    } else {
      _paraSnapshot = newFingerprints;
    }
  } catch (e) {
    console.error(e);
    toast('Auto-format error: ' + (e.message || e), 'err');
  } finally {
    window.autoLatexFormatBusy = false;
  }
}

window.autoLatexFormatNow   = formatNow;
window.autoLatexFormatDelta = formatDelta;

})();
