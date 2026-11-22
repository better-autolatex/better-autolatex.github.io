// Formatter backend for BETTER AutoLaTeX, deployed as a standalone web app:
//   Execute as:      User accessing the web app
//   Who has access:  Anyone
// Each user authorizes it once for their own account; the extension calls
// its /exec URL (APPS_SCRIPT_URL in scripts/shared.js).
//
// DocumentApp has no revision-based write control, so each apply op
// carries the paragraph text seen at read time (expectedText) and is
// skipped if the live paragraph no longer matches.

// The extension only POSTs. GET is hit once by Google's consent redirect,
// so show a friendly page instead of "Script function not found: doGet".
function doGet(e) {
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>BETTER AutoLaTeX — Authorized</title>' +
    '<style>' +
    'body{font:15px/1.5 -apple-system,Segoe UI,Arial,sans-serif;' +
    'background:#0e0710;color:#fdeef5;display:flex;align-items:center;' +
    'justify-content:center;height:100vh;margin:0;text-align:center}' +
    '.card{max-width:420px;padding:32px}' +
    '.check{font-size:40px;margin-bottom:12px}' +
    'h1{font-size:20px;margin:0 0 8px}' +
    'p{color:#c9a8ba;margin:0}' +
    '</style></head><body><div class="card">' +
    '<div class="check">✅</div>' +
    '<h1>Success!</h1>' +
    '<p>The formatter backend is authorized. You can close this tab and ' +
    'go back to your Google Doc — Ctrl+Shift+F is ready to use.</p>' +
    '</div></body></html>'
  ).setTitle('BETTER AutoLaTeX — Authorized');
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' });
  }

  try {
    switch (body.op) {
      case 'read':  return jsonResponse(handleRead(body));
      case 'apply': return jsonResponse(handleApply(body));
      default:      return jsonResponse({ ok: false, error: 'Unknown op: ' + body.op });
    }
  } catch (err) {
    // Return full diagnostics; Workspace policy errors are often vague.
    return jsonResponse({
      ok: false,
      error: String(err && err.message || err),
      details: {
        operation: body.op || '(missing)',
        name: String(err && err.name || ''),
        message: String(err && err.message || err),
        string: String(err),
        stack: String(err && err.stack || '')
      }
    });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── read ─────────────────────────────────────────────────────────────────
//
// Returns every paragraph in order, addressed by index:
//   text, fingerprint (text + per-run font), curIndentPt
function handleRead(body) {
  var doc = DocumentApp.openById(body.docId);
  var body_ = doc.getBody();
  var docParagraphs = collectParagraphs(body_);
  var paragraphs = [];

  for (var i = 0; i < docParagraphs.length; i++) {
    var para = docParagraphs[i];
    var text = para.getText();
    var fingerprint = paragraphFingerprint(para);
    var curIndentPt = para.getIndentStart() || 0;

    paragraphs.push({
      text: text,
      fingerprint: fingerprint,
      curIndentPt: curIndentPt
    });
  }

  return { ok: true, paragraphs: paragraphs };
}

// Fingerprint = text + font per Text element, matching formatter.js.
function paragraphFingerprint(para) {
  var parts = [];
  var n = para.getNumChildren();
  for (var i = 0; i < n; i++) {
    var child = para.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.TEXT) continue;
    var t = child.asText();
    var content = t.getText();
    var font = '';
    // Sampling the first character is enough to detect a font override.
    if (content.length > 0) {
      font = t.getFontFamily(0) || '';
    }
    parts.push(font + '\x00' + content);
  }
  return parts.join('\x01');
}

// Every paragraph in document order, including ones inside table cells.
// read and apply share this so paraIndex stays stable.
function collectParagraphs(container) {
  var result = [];
  var n = container.getNumChildren();
  for (var i = 0; i < n; i++) {
    var el = container.getChild(i);
    var type = el.getType();
    if (type === DocumentApp.ElementType.PARAGRAPH) {
      result.push(el.asParagraph());
    } else if (type === DocumentApp.ElementType.TABLE) {
      var table = el.asTable();
      for (var r = 0; r < table.getNumRows(); r++) {
        var row = table.getRow(r);
        for (var c = 0; c < row.getNumCells(); c++) {
          result = result.concat(collectParagraphs(row.getCell(c)));
        }
      }
    }
  }
  return result;
}

// ── apply ────────────────────────────────────────────────────────────────
//
// body.ops: array of
//   { paraIndex, expectedText, lineSpacing, fontFamily, fontSize,
//     indentPt, spans: [{start, endInclusive, color}] }
// paraIndex uses the same enumeration as handleRead. Offsets are 0-based
// within the paragraph and inclusive. Ops whose text no longer matches
// expectedText are reported in `skipped`.
function handleApply(body) {
  var doc = DocumentApp.openById(body.docId);
  var body_ = doc.getBody();

  var paragraphs = collectParagraphs(body_);

  var applied = [];
  var skipped = [];

  (body.ops || []).forEach(function (op) {
    var para = paragraphs[op.paraIndex];
    if (!para) { skipped.push(op.paraIndex); return; }

    if (para.getText() !== op.expectedText) {
      skipped.push(op.paraIndex);
      return;
    }

    if (op.lineSpacing != null) para.setLineSpacing(op.lineSpacing);
    if (op.indentPt != null) {
      para.setIndentStart(op.indentPt);
      para.setIndentFirstLine(op.indentPt);
    }

    if (op.expectedText.length > 0 && (op.fontFamily || op.fontSize != null)) {
      var textEl = para.editAsText();
      var lastOffset = op.expectedText.length - 1;
      if (op.fontFamily) textEl.setFontFamily(0, lastOffset, op.fontFamily);
      if (op.fontSize != null) textEl.setFontSize(0, lastOffset, op.fontSize);
    }

    if (op.spans && op.spans.length) {
      var textEl2 = para.editAsText();
      op.spans.forEach(function (span) {
        if (span.endInclusive < span.start) return;
        textEl2.setForegroundColor(span.start, span.endInclusive, span.color);
      });
    }

    applied.push(op.paraIndex);
  });

  return { ok: true, applied: applied, skipped: skipped };
}
