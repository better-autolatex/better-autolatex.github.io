// Shared constants, settings keys, default preambles, and LaTeX helpers.
// The LaTeX logic (preambles, decoder, escape rules, body normalization) is
// preserved 1:1 from the original Apps Script add-on, so renders are
// byte-identical to what the user got before.

export const TEXLIVE_ENDPOINT = 'https://texlive.net/cgi-bin/latexcgi';

// Shared formatter backend — one deployment, "Execute as: User accessing the
// web app", used by every install with no per-user setup and no override.
// Each caller authorizes the script's OAuth scopes under their own account
// the first time they use it (a real Google consent screen; see
// AppsScript.gs), so it only ever touches documents that caller can access.
// This is the ONLY place this URL lives — there is deliberately no per-user
// storage override anymore (one used to exist in Settings; a stale value
// left there silently shadowed this constant and caused 404s, since
// background.js was calling the old override instead of this URL).
export const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwRXFpuAWmADQgR0fru4ny5jGrunQsDPgXNTHPpcuvzG7JEthSWD_qqydP0C3cqlonF/exec';

export const SK = {
  DOC_TYPE:         'setting_docType',
  FONT_FAMILY:      'setting_fontFamily',
  FONT_SIZE:        'setting_fontSize',
  CLR_DEFAULT:      'setting_clrDefault',
  CLR_COMMAND:      'setting_clrCommand',
  CLR_ENV_NAME:     'setting_clrEnvName',
  CLR_MATH_CONTENT: 'setting_clrMathContent',
  CLR_MATH_COMMAND: 'setting_clrMathCommand',
  CLR_COMMENT:      'setting_clrComment',
  PREAMBLE:         'setting_preamble',
  STY_FILES:        'setting_styFiles',
  ENABLED:          'setting_enabled',   // master on/off switch
  AUTO_FORMAT:      'setting_autoFormat' // auto-format mode
};

export const DEFAULTS = {
  docType:        'article',
  fontFamily:     'Roboto Mono',
  fontSize:       12,
  clrDefault:     '#000000',
  clrCommand:     '#0000FF',
  clrEnvName:     '#318495',
  clrMathContent: '#036A07',
  clrMathCommand: '#833FBA',
  clrComment:     '#4C886B'
};

const SHARED_SHORTHANDS = [
  '\\newcommand{\\C}{{\\mathbb{C}}}',
  '\\newcommand{\\A}{{\\mathbb{A}}}',
  '\\newcommand{\\R}{{\\mathbb{R}}}',
  '\\newcommand{\\Z}{\\mathbb{Z}}',
  '\\newcommand{\\N}{\\mathbb{N}}',
  '\\newcommand{\\Q}{{\\mathbb{Q}}}',
  '\\newcommand{\\Pro}{{\\mathbb{P}}}',
  '\\newcommand{\\T}{{\\mathbb{T}}}',
  '\\newcommand{\\I}{{\\mathbb{I}}}',
  '\\newcommand{\\lcm}{\\textup{lcm}}',
  '\\newcommand{\\vare}{\\varepsilon}',
  '\\renewcommand{\\v}{\\mathbf{v}}',
  '\\renewcommand{\\d}{\\mathbf{d}}',
  '\\renewcommand{\\c}{\\mathbf{c}}',
  '\\renewcommand{\\b}{\\mathbf{b}}',
  '\\newcommand{\\x}{\\mathbf{x}}',
  '\\newcommand{\\y}{\\mathbf{y}}',
  '\\renewcommand{\\a}{\\alpha}',
  '\\newcommand{\\Aa}{\\mathcal{A}}',
  '\\newcommand{\\BB}{\\mathcal{B}}',
  '\\newcommand{\\CC}{\\mathcal{C}}',
  '\\newcommand{\\DD}{\\mathcal{D}}',
  '\\newcommand{\\GG}{\\mathcal{G}}',
  '\\newcommand{\\KK}{\\mathcal{K}}',
  '\\newcommand{\\HH}{\\mathcal{H}}',
  '\\newcommand{\\PP}{\\mathcal{P}}',
  '\\newcommand{\\MM}{\\mathcal{M}}',
  '\\newcommand{\\LL}{\\mathcal{L}}'
];

export function getDefaultPreamble(docType) {
  let lines;
  if (docType === 'exam') {
    lines = [
      '\\documentclass[12pt,letterpaper,onecolumn]{exam}',
      '\\usepackage{amsmath}',
      '\\usepackage{amssymb}',
      '\\usepackage{amsthm}',
      '\\usepackage{boldline}',
      '\\usepackage{emoji}',
      '\\usepackage{changepage}',
      '\\usepackage{asymptote}',
      '\\usepackage{currfile}',
      '\\usepackage{float}',
      '\\usepackage{graphicx}',
      '\\usepackage{adjustbox}',
      '\\usepackage[table]{xcolor}',
      '\\usepackage[lmargin=60pt,tmargin=1in,bmargin=0.685in]{geometry}',
      '\\usepackage{enumitem}',
      '\\newlist{caselist}{enumerate}{3}',
      '\\newlength{\\casebodyindent}',
      '\\setlength{\\casebodyindent}{2.25em}',
      '\\setlist[caselist,1]{',
      '  label={\\textbf{Case \\arabic*:}\\hspace*{-\\casebodyindent}},',
      '  leftmargin=\\casebodyindent,',
      '  labelsep=0pt,',
      '  itemsep=0.4em,',
      '  topsep=0.4em,',
      '  parsep=0pt',
      '}',
      '\\setlist[caselist,2]{',
      '  label={\\textbf{Subcase (\\alph*):}\\hspace*{-\\casebodyindent}},',
      '  leftmargin=\\dimexpr\\casebodyindent+1.5em\\relax,',
      '  labelsep=0pt,',
      '  itemsep=0.3em,',
      '  topsep=0.3em,',
      '  parsep=0pt',
      '}',
      '\\setlist[caselist,3]{',
      '  label={\\textbf{Subcase (\\Roman*):}\\hspace*{-\\casebodyindent}},',
      '  leftmargin=\\dimexpr\\casebodyindent+3em\\relax,',
      '  labelsep=0pt,',
      '  itemsep=0.2em,',
      '  topsep=0.2em,',
      '  parsep=0pt',
      '}',
      '\\newenvironment{casework}',
      '  {\\begin{caselist}\\let\\case\\item',
      '   \\renewcommand{\\case}[1]{%',
      '     \\item\\hspace*{\\casebodyindent}\\ \\textit{##1}\\par',
      '   }%',
      '  }',
      '  {\\end{caselist}}'
    ].concat(SHARED_SHORTHANDS).concat([
      '\\newtheorem*{theorem}{Theorem}',
      '\\author{}',
      '\\title{\\documentName}',
      '\\date{}',
      '\\pagestyle{empty}'
    ]);
  } else {
    lines = [
      '\\documentclass[12pt,letterpaper]{' + docType + '}',
      '\\usepackage{amsmath}',
      '\\usepackage{amssymb}',
      '\\usepackage{amsthm}',
      '\\usepackage{mathtools}',
      '\\usepackage{graphicx}',
      '\\usepackage{float}',
      '\\usepackage{adjustbox}',
      '\\usepackage{boldline}',
      '\\usepackage[table]{xcolor}',
      '\\usepackage[hidelinks]{hyperref}',
      '\\usepackage{enumitem}',
      '\\usepackage[T1]{fontenc}',
      '\\usepackage{lmodern}',
      '\\usepackage{microtype}',
      '\\usepackage[margin=1in]{geometry}',
      '\\setlength{\\parindent}{0pt}',
      '\\setlength{\\parskip}{0.6em}'
    ].concat(SHARED_SHORTHANDS).concat([
      '\\newtheorem*{theorem}{Theorem}',
      '\\newtheorem*{lemma}{Lemma}',
      '\\newtheorem*{proposition}{Proposition}',
      '\\newtheorem*{corollary}{Corollary}',
      '\\newtheorem*{definition}{Definition}',
      '\\newtheorem*{remark}{Remark}',
      '\\author{}',
      '\\title{\\documentName}',
      '\\date{}'
    ]);
  }
  return lines.join('\n');
}

export const LUA_DECODER = [
  '\\directlua{',
  'function decodeB64File(src, dst)',
  '  local alpha = \'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/\'',
  '  local lk = {}',
  '  for i=1,64 do lk[alpha:sub(i,i)] = i-1 end',
  '  local fi = io.open(src, \'r\')',
  '  local s = fi:read(\'*a\')',
  '  fi:close()',
  '  local t = {}',
  '  local cnt = 0',
  '  local slen = string.len(s)',
  '  for i=1,slen,4 do',
  '    local a = s:sub(i,i)',
  '    local b = s:sub(i+1,i+1)',
  '    local c = s:sub(i+2,i+2)',
  '    local d = s:sub(i+3,i+3)',
  '    if lk[a] and lk[b] then',
  '      local n = lk[a]*262144 + lk[b]*4096 + (lk[c] or 0)*64 + (lk[d] or 0)',
  '      local b1 = math.floor(n/65536)',
  '      cnt = cnt+1',
  '      t[cnt] = string.char(b1)',
  '      if lk[c] then',
  '        cnt = cnt+1',
  '        t[cnt] = string.char(math.floor(n/256) - b1*256)',
  '      end',
  '      if lk[d] then',
  '        cnt = cnt+1',
  '        t[cnt] = string.char(n - math.floor(n/256)*256)',
  '      end',
  '    end',
  '  end',
  '  local out = io.open(dst, \'wb\')',
  '  out:write(table.concat(t))',
  '  out:close()',
  'end',
  '}'
].join('\n');

// ── Helpers (mirror originals from Code.gs) ─────────────────────────────────

export function escapeLatexText(value) {
  const r = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}',
    '$': '\\$', '&': '\\&', '#': '\\#', '_': '\\_', '%': '\\%',
    '~': '\\textasciitilde{}', '^': '\\textasciicircum{}'
  };
  return String(value).replace(/[\\{}$&#_%~^]/g, c => r[c] || c);
}

export function sanitizePdfFilename(title) {
  return (title || 'document')
    .replace(/[\\/:*?"<>|#%&{}$!'`@+=,;\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'document';
}

export function normalizeLatexBody(rawText) {
  let text = (rawText || '').replace(/^\uFEFF/, '').trim();
  if (!text) return '';

  const beginDoc = '\\begin{document}', endDoc = '\\end{document}';
  const beginDocIdx = text.indexOf(beginDoc);
  if (beginDocIdx !== -1) {
    const endDocIdx = text.indexOf(endDoc);
    text = text.slice(beginDocIdx + beginDoc.length,
                      endDocIdx !== -1 ? endDocIdx : text.length);
  }

  text = text
    .replace(/^[ \t]*\\documentclass(?:\[[^\]]*\])?\{[^}]+\}[ \t]*\n?/gm, '')
    .replace(/^[ \t]*\\usepackage(?:\[[^\]]*\])?\{[^}]+\}[ \t]*\n?/gm,    '')
    .replace(/^[ \t]*\\(?:title|date|author)\{.*\}[ \t]*\n?/gm,            '')
    .replace(/^[ \t]*\\maketitle[ \t]*\n?/gm,                              '')
    .replace(/^[ \t]*\\newcommand\{\\documentName\}\{.*\}[ \t]*\n?/gm,     '')
    .replace(/^[ \t]*\\(?:this)?pagestyle\{[^}]*\}[ \t]*\n?/gm,            '')
    .trim();

  return text;
}

export function buildLatexDocument(title, bodyText, settings, preamble) {
  const s = settings || DEFAULTS;
  const escapedTitle = escapeLatexText(title);

  const preambleLines = preamble.split('\n');
  const resultLines = [];
  let injected = false;
  const alreadyHasDN = preamble.indexOf('\\newcommand{\\documentName}') !== -1;
  const alreadyHasXcolor = /\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\bxcolor\b[^}]*\}/.test(preamble);
  let xcolorInjected = alreadyHasXcolor;

  for (let i = 0; i < preambleLines.length; i++) {
    resultLines.push(preambleLines[i]);
    if (/^\\documentclass/.test(preambleLines[i].trim())) {
      if (!injected && !alreadyHasDN) {
        resultLines.push('\\newcommand{\\documentName}{' + escapedTitle + '}');
        injected = true;
      }
      if (!xcolorInjected) {
        resultLines.push('\\usepackage[table]{xcolor}');
        xcolorInjected = true;
      }
    }
  }
  if (!injected && !alreadyHasDN) {
    resultLines.unshift('\\newcommand{\\documentName}{' + escapedTitle + '}');
  }
  if (!xcolorInjected) {
    // A custom preamble without a documentclass is invalid LaTeX already;
    // keep the package alongside its other preamble material in that case.
    resultLines.push('\\usepackage[table]{xcolor}');
  }

  resultLines.push(LUA_DECODER);
  resultLines.push('');
  resultLines.push('\\begin{document}');

  if (s.docType === 'exam') {
    resultLines.push(
      '\\begingroup',
      '    \\centering',
      '    \\LARGE \\documentName\\\\[0.5em]',
      '\\endgroup',
      '\\rule{\\textwidth}{0.4pt}',
      '\\printanswers',
      '\\renewcommand{\\solutiontitle}{}',
      ''
    );
  } else {
    resultLines.push('\\maketitle', '');
  }

  resultLines.push(bodyText);
  resultLines.push('');
  resultLines.push('\\end{document}');
  return resultLines.join('\n');
}

// ── Settings access (shared by background worker and option pages) ──────────

export function getDocumentSettingsKey(docId) {
  return 'setting_documentSettings_' + docId;
}

export function getDocumentPreambleKey(docId) {
  return 'setting_documentPreamble_' + docId;
}

export async function getSettingsFromStorage(docId = null) {
  let stored;
  try {
    const keys = Object.values(SK);
    if (docId) keys.push(getDocumentSettingsKey(docId));
    stored = await Promise.race([
      chrome.storage.local.get(keys),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
  } catch (_) {
    stored = {};
  }
  const overrides = docId ? (stored[getDocumentSettingsKey(docId)] || {}) : {};
  const value = (key, fallback) => overrides[key] || stored[key] || fallback;
  return {
    docType:        value(SK.DOC_TYPE, DEFAULTS.docType),
    fontFamily:     value(SK.FONT_FAMILY, DEFAULTS.fontFamily),
    fontSize:       parseInt(value(SK.FONT_SIZE, DEFAULTS.fontSize), 10),
    clrDefault:     value(SK.CLR_DEFAULT, DEFAULTS.clrDefault),
    clrCommand:     value(SK.CLR_COMMAND, DEFAULTS.clrCommand),
    clrEnvName:     value(SK.CLR_ENV_NAME, DEFAULTS.clrEnvName),
    clrMathContent: value(SK.CLR_MATH_CONTENT, DEFAULTS.clrMathContent),
    clrMathCommand: value(SK.CLR_MATH_COMMAND, DEFAULTS.clrMathCommand),
    clrComment:     value(SK.CLR_COMMENT, DEFAULTS.clrComment)
  };
}

export async function getPreambleFromStorage(docId = null) {
  const settings = await getSettingsFromStorage(docId);
  const keys = [SK.PREAMBLE];
  if (docId) keys.push(getDocumentPreambleKey(docId));
  const stored = await chrome.storage.local.get(keys);
  const custom = docId && stored[getDocumentPreambleKey(docId)] !== undefined
    ? stored[getDocumentPreambleKey(docId)]
    : stored[SK.PREAMBLE];
  if (custom && String(custom).trim()) {
    return { preamble: custom, isCustom: true, docType: settings.docType };
  }
  return { preamble: getDefaultPreamble(settings.docType), isCustom: false, docType: settings.docType };
}

export async function getStyFilesFromStorage() {
  const stored = await chrome.storage.local.get([SK.STY_FILES]);
  const files = stored[SK.STY_FILES] || {};
  return Object.keys(files).sort().map(name => ({ name, content: files[name] }));
}
