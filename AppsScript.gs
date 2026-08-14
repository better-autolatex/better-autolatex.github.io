// Standalone Apps Script web app — the OAuth-free replacement for the direct
// docs.googleapis.com calls the extension used to make with chrome.identity.
//
// Deploy as: Deploy > New deployment > type "Web app".
//   Execute as:      User accessing the web app
//   Who has access:  Anyone
// One deployment, one /exec URL, shared by every user — baked into the
// extension as the default setting_appsScriptUrl (see shared.js), so no
// per-user setup is required. Each caller authorizes the script's OAuth
// scopes under their OWN account the first time they use it (a real Google
// consent screen the extension cannot skip), which is what lets
// DocumentApp.openById below act on THAT caller's documents rather than the
// deployer's. See CLAUDE.md for what was tried before landing here.
//
// This project is standalone (not container-bound) — DocumentApp.getActiveDocument()
// is not available to a web app in any case (bound or not), so openById(docId)
// is required either way.
//
// ── Concurrency model ────────────────────────────────────────────────────
// The REST API's writeControl.requiredRevisionId has no DocumentApp
// equivalent — there is no way to reject a whole batch atomically if the
// document changed since it was read. Instead, every "apply" op carries the
// paragraph text the extension observed at read time (expectedText). Before
// writing, this script re-fetches that paragraph BY INDEX and skips the op
// (reporting it back) if the live text no longer matches. That is the
// re-resolution step replacing optimistic-concurrency: a stale op is
// dropped instead of being applied to the wrong range.

// Handles GET requests to /exec. The extension never sends one of these —
// it always POSTs — but Google's own OAuth consent flow does: the first
// time a user authorizes this deployment (under "Execute as: User accessing
// the web app"), the consent screen redirects the browser to a plain GET on
// this exact URL to complete the flow. Without a doGet(), that lands on
// Apps Script's default "Script function not found: doGet" error page,
// which reads as a failure even though authorization itself succeeded.
// Returning a friendly HTML page here just replaces that error with a
// clear "you're done" message — it has no effect on the extension's own
// POST-based read/apply calls.
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
    // Keep every diagnostic Apps Script exposes. Workspace policy failures are
    // often reported only as "Action not allowed", but this makes the
    // operation, error type, string form, and stack available to the extension
    // rather than reducing them to one short message.
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
// Returns every paragraph in document order, addressed by INDEX into this
// array (not by any Docs-API character offset — those don't exist here).
// Mirrors the REST-API extractParagraphs() shape in formatter.js:
//   text            full paragraph text (no trailing newline)
//   fingerprint     text + per-run font, so the extension's LCS delta and
//                   manual-font-override detection keep working unchanged
//   curIndentPt     current left indent in points
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

// Fingerprint = text + font-per-run, matching paragraphFingerprint() in
// formatter.js closely enough that the same LCS diff / override detection
// applies. DocumentApp doesn't expose "runs" directly, so we walk the
// paragraph's child Text elements (a paragraph normally has exactly one,
// but manual formatting can split it into several).
function paragraphFingerprint(para) {
  var parts = [];
  var n = para.getNumChildren();
  for (var i = 0; i < n; i++) {
    var child = para.getChild(i);
    if (child.getType() !== DocumentApp.ElementType.TEXT) continue;
    var t = child.asText();
    var content = t.getText();
    var font = '';
    // A run can carry mixed fonts across its characters; sample the first
    // character the same way the fingerprint only needs to detect *that*
    // an override exists, not describe it exhaustively.
    if (content.length > 0) {
      font = t.getFontFamily(0) || '';
    }
    parts.push(font + '\x00' + content);
  }
  return parts.join('\x01');
}

// Return every ordinary paragraph in document order, including paragraphs
// inside table cells.  The original implementation only walked Body's direct
// children, which meant table text was invisible to both manual formatting
// and auto-format.  The same traversal is used for read and apply, so the
// positional paraIndex remains stable across the round trip.
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
// paraIndex is positional into the SAME child-paragraph enumeration as
// handleRead. start/endInclusive are 0-based offsets WITHIN the paragraph
// text (DocumentApp ranges are inclusive on both ends — no +1/-1 needed
// here; formatter.js does that conversion before sending).
//
// Any op whose live paragraph text no longer matches expectedText is
// skipped and reported in `skipped` rather than applied — this is the
// re-resolution replacing requiredRevisionId.
function handleApply(body) {
  var doc = DocumentApp.openById(body.docId);
  var body_ = doc.getBody();

  // Build the same positional paragraph index handleRead used, once, so
  // random-access by paraIndex is a plain array lookup below. This includes
  // paragraphs nested inside table cells.
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
