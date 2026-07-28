# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

BETTER AutoLaTeX — a Manifest V3 Chrome extension that renders a Google Doc's contents as a LaTeX PDF via texlive.net and shows it in a split-view panel inside the Doc tab. It also syntax-highlights LaTeX source *in* the Doc via a companion Apps Script web app ([AppsScript.gs](AppsScript.gs)). One shared deployment, its `/exec` URL baked in as `APPS_SCRIPT_URL` in [scripts/shared.js](scripts/shared.js), serves every install with zero setup — there is no per-user override or Settings field for this; see [FORMATTER_SETUP.md](FORMATTER_SETUP.md) for why and for how to redeploy it if you're maintaining the extension itself.

It is a port of an older Apps Script add-on. The LaTeX logic in [scripts/shared.js](scripts/shared.js) (preambles, Lua base64 decoder, escape rules, body normalization) and the highlight pattern ordering in [scripts/formatter.js](scripts/formatter.js) are preserved 1:1 from that add-on so renders stay byte-identical. Don't "clean up" those without a reason.

## Build / run / test

There is no build step, no bundler, no package.json, no test suite, and no git repo. The source *is* the extension.

- **Load:** `chrome://extensions` → Developer mode → Load unpacked → pick this folder (the one with `manifest.json`).
- **Iterate:** edit a file, hit the reload icon on the extension card, then **reload the Google Doc tab** (content scripts are injected at `document_idle` and won't re-inject on their own).
- **Debug:** background service worker logs are behind the "service worker" link on the extension card; content script / formatter logs appear in the Doc tab's DevTools console.
- **Rebind hotkeys:** `chrome://extensions/shortcuts`.

The extension ID is pinned by the `key` field in [manifest.json](manifest.json). (Originally required for `chrome.identity.getAuthToken`; OAuth has since been removed entirely, but the ID stays pinned for a stable install identity.) The private signing key lives outside this folder at `../key.pem`.

**Formatter backend deployment:** [AppsScript.gs](AppsScript.gs) is deployed **once**, standalone, as **Execute as: User accessing the web app / Who has access: Anyone**, and its `/exec` URL is baked into the extension as `APPS_SCRIPT_URL` in [scripts/shared.js](scripts/shared.js) — no per-user setup. Each caller authorizes the script's OAuth scopes for their own account the first time they use it (a real, one-time Google consent screen the extension cannot skip), which is what lets one deployment act on many different users' own documents rather than only the deployer's. **There is deliberately no Settings field or storage override for this URL** — one used to exist and is why a formatter setup ever needs revisiting: it's not a design decision, it's an incident record. Without a backend configured (`APPS_SCRIPT_URL` empty), render/PDF/split-view all work normally — only Ctrl+Shift+F formatting is unavailable.

**This shared-deployment model was reached after ruling out/learning from several things — know this history before repeating any of it:**

- **A Settings field for overriding the backend URL was added, then removed.** A stale value left in that field silently took priority over `APPS_SCRIPT_URL` and caused the extension to call a dead/old deployment — surfacing as a real HTTP 404 from Google's servers, with the *correct* URL sitting unused right next to it in shared.js. The fix was removing the override path entirely, not debugging the URL — when there are two possible sources for a config value, a stale one wins silently and looks exactly like a broken deployment. If a per-user override is ever reintroduced, make sure whichever value is actually in effect is unambiguous and logged, not silently layered.
- **A previous attempt at "Execute as: User accessing the web app" failed on a real managed Workspace (school) account** with `Error 400: access_not_configured` on Google's `access_type=offline` consent screen. At the time this looked like a hard, permanent admin-level block (external Apps Script API access disabled domain-wide). **It was later retried, unchanged, on the same account and succeeded** — so the failure was not permanent (likely a transient propagation delay on Google's or the admin's side, not a structural block). Do not treat a single `access_not_configured` failure as proof this mode is unusable; it has since been confirmed working, including on a school account. If it recurs, retry before concluding it's blocked again.
- **DOM/keystroke simulation** (drive the Docs editor directly, no Google API involved at all) was researched and ruled out before writing any code, and this conclusion still stands regardless of the above. Google migrated Docs to canvas-based rendering in 2021 specifically to break this class of technique (Google's own announcement says so). Synthetic `dispatchEvent`s are untrusted and Docs ignores them; synthetic paste events are blocked by the browser from ever writing document content (a W3C-specified restriction, not a Docs quirk). The only channel that produces genuinely trusted input, `chrome.debugger`, requires a permanent non-suppressible "this extension is debugging this browser" infobar — incompatible with silent background formatting — and even then only automates slow UI menu clicks, not precise per-substring styling. The one prior open-source project attempting this (`docs-plus`) is confirmed dead, killed by the same 2021 migration. Do not revisit this path; it is not a matter of more engineering effort, it's a browser/Docs security boundary.
- **`doGet` on the Apps Script side exists solely to make the OAuth consent redirect land on a friendly "Success!" page** instead of Apps Script's default "Script function not found: doGet" error. The extension itself never sends a GET — only Google's own consent flow does, once, per user, the first time they authorize. Don't repurpose or remove `doGet` without checking that flow still ends somewhere reasonable.

## Architecture

Four contexts, all message-passing through the background worker:

1. **[scripts/background.js](scripts/background.js)** (service worker, ES module) — the only place that talks to texlive.net *and* the only place that talks to the Apps Script backend. A big `chrome.runtime.onMessage` switch is the API surface: `render`, `download`, `get/save/resetSettings`, `get/save/resetPreamble`, `list/save/deleteStyFile`, `openPage`, `formatRead`, `formatApply`. Also owns `chrome.commands` hotkey routing.
2. **[scripts/content.js](scripts/content.js)** (isolated world, on `docs.google.com/document/*`) — extracts doc text, drives the render, injects the split panel, handles in-page hotkeys and toasts. Guarded by `window.__BETTER_AUTOLATEX_LOADED__` because popup.js also `executeScript`s it defensively.
3. **[scripts/formatter.js](scripts/formatter.js)** (same content-script bundle) — the syntax highlighter. Builds highlight/indent ops in-page, but has no direct network access of its own (see below); calls `background.js` via `chrome.runtime.sendMessage` to actually read/write the doc. Exposes `window.autoLatexFormatNow` / `autoLatexFormatDelta` / `autoLatexFormatBusy`; content.js calls those, never the internals.
4. **[scripts/resize-bridge.js](scripts/resize-bridge.js)** (`world: "MAIN"`) — 24 lines whose only job is `Object.defineProperty(documentElement, 'clientWidth')` in the page's own JS world.
5. **[AppsScript.gs](AppsScript.gs)** — a standalone Apps Script project, deployed separately from the extension (see setup note above). Exposes `doPost` with `op: 'read'` (returns paragraphs + fingerprints + indent) and `op: 'apply'` (writes styles via `DocumentApp`, re-resolving each paragraph by text match first).

[scripts/popup.js](scripts/popup.js) renders `html/settings.html` and `html/preamble.html` **inline inside the popup** (fetch → DOMParser → extract `.page` → `innerHTML`), then calls the `init()` exported by [scripts/settings.js](scripts/settings.js) / [scripts/preamble.js](scripts/preamble.js). Those pages are not opened as tabs; only `html/help.html` is. If you add a field to a settings page you must touch both the HTML and the corresponding module's `fields` list.

### No OAuth anywhere — and why the formatter is a separate deployment

The extension has zero `oauth2` config and zero `chrome.identity` usage. Both features avoid Google API auth entirely, but by different means:

- **Render → PDF and split view** need no auth at all. Pure DOM + clipboard + `fetch` to texlive.net.
- **Formatting write-back** (`formatNow`/`formatDelta`) used to call `docs.googleapis.com` directly via `chrome.identity.getAuthToken`, which managed Workspace domains commonly blocked outright ("Service has been disabled for this account") — see [[school-oauth-block-analysis]] in project memory for the historical failure mode. It now goes through the shared [AppsScript.gs](AppsScript.gs) deployment instead: each caller authorizes the script for their own account once, confirmed (empirically, on a real school account) to survive the restriction that killed the direct-API path. The extension itself makes no Google-authenticated call of any kind; `AppsScript.gs` runs under the authority of whichever account authorized it, per caller.

Never route render through the Docs/Apps Script path to "simplify" — that would tie PDF rendering to formatter-backend setup for no reason.

## Non-obvious constraints

**Text extraction** ([content.js](scripts/content.js) `extractDocumentText`) tries two strategies in order: a synthetic copy event on the hidden `iframe.docs-texteventtarget-iframe` (clipboard is intercepted and `preventDefault`ed, so the user's real clipboard is never touched), then a `credentials: 'include'` fetch of `/export?format=html`, then `?format=txt`. The clipboard path deliberately awaits ~100 ms after `focus()` before `selectAll` and retries up to 3× — `focus()` is effectively async, and selecting in the same tick captures an empty selection whenever focus was on the split-view PDF iframe. That sleep is a fix, not a smell.

**Blank-document guard** short-circuits in content.js *before* any server call, and returns `{ blank: true }`. Both popup.js and background.js special-case `blank` so the user sees only the in-doc toast, never a duplicate error. Compile errors, likewise, are displayed only in the render destination (split panel or new tab) — popup.js swallows them on purpose.

**texlive.net POST**: build the body with `FormData` and never set `Content-Type` by hand — a manual header destroys the multipart boundary. Engine is fixed to `lualatex` because inline images are decoded in-document by the `\directlua` base64 decoder (`LUA_DECODER` in shared.js); each image is uploaded as a `.b64` text file and turned back into a real `.png`/`.jpg` at compile time.

**MV3 worker keep-alive**: a 25-second `chrome.alarms` no-op keeps the worker from being killed mid-fetch. Renders can take 20–40 s; the fetch has a 90 s timeout with 3 attempts and exponential backoff.

**Split view width** is a three-way dance: content.js sets `--bal-split-width` / `--bal-doc-width` CSS vars (consumed by [styles/panel.css](styles/panel.css)), writes the target width to `data-bal-doc-width` on `<html>`, then fires `__bal_resize__`. resize-bridge.js picks that up in the main world, spoofs `clientWidth`, and dispatches a real `resize` so Google Docs reflows its toolbar. DOM attributes are the only channel between the isolated and main worlds here. The `_inTriggerResize` flag exists to break the resize feedback loop.

**Formatter concurrency has no revision pinning.** `DocumentApp` (unlike the REST API) has no `writeControl`/`revisionId` equivalent — there is no way to reject a whole batch atomically if the doc changed since it was read. Instead, addressing is by **paragraph index + text match**: every op sent to `AppsScript.gs`'s `apply` carries `expectedText`, and the script re-fetches that paragraph by index and skips the op (reporting it in `skipped`) if the live text no longer matches, rather than applying a stale range. `formatDelta` in [formatter.js](scripts/formatter.js) treats any skipped index as "not yet formatted" by nulling that paragraph's snapshot entry, forcing a retry on the next poll — this is the direct replacement for the old `requiredRevisionId` benign-retry path, just decided per-paragraph instead of per-batch.

**Delta formatting** diffs paragraph *fingerprints* (font family + text per run, computed identically on both sides — `paragraphFingerprint` in both [formatter.js](scripts/formatter.js) history and [AppsScript.gs](AppsScript.gs)) with an LCS, so a paragraph that merely shifted position is skipped and a manual font override still triggers a re-format. The **indent pass (`computeIndentChanges`) always runs over every paragraph**, not just the changed ones — indent depth is order-dependent, so typing one `\begin{env}` must re-indent everything below it. It self-limits by emitting an op only when the needed indent differs from the current one.

**Offset conventions differ between the two sides and this is the easiest place to introduce an off-by-one.** `buildHighlightSpans` in formatter.js produces `{start, endInclusive}` — DocumentApp's `Text.setForegroundColor(startOffset, endOffsetInclusive, color)` takes an **inclusive** end offset, so no `+1` conversion happens anywhere in the current code. (The old Docs REST API used a half-open `endIndex`, requiring a `+1`; if you ever see `+1` reappear near a span offset, it's a regression from that era, not a fix.)

**Auto-format poll interval** (`AUTO_FORMAT_POLL_MS` in [content.js](scripts/content.js)) is unchanged at 2 s even though the formatter backend is now an Apps Script round trip (cold start + redirect hop), which is slower than the direct API call the interval was originally tuned for. This is safe only because the single-flight guard (`autoLatexFormatBusy` + `_autoFormatDirty`) prevents overlapping requests regardless of interval — a tick that lands mid-request just sets the dirty flag and waits its turn. If auto-format ever feels laggy or backend calls pile up, widening this constant is the first lever to pull.

**Ctrl+Shift+F** is intentionally *not* intercepted at the window level (Google Docs uses it natively for compact controls). It's only captured inside the editing iframe, in `attachIframeKeyHandlers`, which is re-run on a 1.5 s interval because Docs recreates that iframe. Single tap = format once; double tap within 400 ms = toggle auto-format. That double-tap logic is duplicated in popup.js `handleFormatKey` — keep the two in sync.

**Hotkey routing**: in-page `keydown` can't see keystrokes while Chrome's sandboxed PDF viewer has focus, so `Ctrl+Shift+Z`/`X` are also registered as browser-level `chrome.commands`. background.js resolves the target Docs tab via active tab → `lastDocsTabId` → any Docs tab. popup.js additionally mirrors the same chords, since commands are swallowed while the popup holds focus.

## Storage keys

All state is `chrome.storage.local`, flat, prefixed `setting_`. The canonical list is `SK` in [shared.js](scripts/shared.js) — but note these are read by string literal in content.js and formatter.js and are *not* all in `SK`: `setting_renderMode` (`'split'`|`'tab'`), `setting_splitPanelWidth` (px), `setting_enabled`, `setting_autoFormat`. Adding a key means updating `SK`, `DEFAULTS`, `getSettingsFromStorage`, the `resetSettings` removal list in background.js, and any literal reader.

**The Apps Script backend URL is *not* a storage key** — it's the `APPS_SCRIPT_URL` constant in [shared.js](scripts/shared.js), a code value, not something read from `chrome.storage`. This is intentional (see the incident note above): a prior version stored it as `setting_appsScriptUrl` with a Settings-page override, and a stale stored value silently beat the shared default. Don't reintroduce a storage-backed override for this without solving that ambiguity.

The syntax colour settings (`clr*`) are used *only* by the formatter, not by the PDF render.
