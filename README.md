# BETTER AutoLaTeX

A Chrome extension that renders a Google Doc as a LaTeX PDF. Write LaTeX directly in Google Docs, then preview the compiled PDF in a split-screen panel next to the document or in a new tab.

**Website:** https://better-autolatex.github.io

<a href="https://better-autolatex.github.io/better-autolatex.zip" target="_blank" rel="noopener noreferrer">Download the extension ZIP</a>

## Features

- Compile the document with LuaLaTeX via [texlive.net](https://texlive.net), with no local TeX install needed
- Split-screen PDF preview inside the Docs tab (resizable), or open the PDF in a new tab
- Download the rendered PDF
- Converts Google Docs bold/italic/underline, tables, images, soft line breaks, and page breaks
- Built-in preambles for `article` and `exam`, plus a custom preamble per document and uploadable `.sty` files
- In-document LaTeX syntax highlighting and environment indentation (`Ctrl+Shift+F`), with an optional auto-format mode

## Install

### 1. Download and extract the extension

Download the ZIP above. In your Downloads folder, right-click `better-autolatex.zip`, click **Extract All...**, and extract it somewhere you plan to keep it.

<img src="assets/screenshots/Step%201%20-%20download%20and%20unzip.png" width="75%" alt="Windows File Explorer with better-autolatex.zip selected and Extract All highlighted">

### 2. Load the extension in Chrome

Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and choose the extracted **better-autolatex** folder.

<img src="assets/screenshots/Step%202%20-%20developer%20mode%20and%20load%20unpacked.png" width="75%" alt="Chrome Extensions showing Developer mode, Load unpacked, and the folder selection dialog">

### 3. Approve the Google Docs formatter

Open <a href="https://script.google.com/macros/s/AKfycbw5jMbf7fJPBY59YsVOyCyUnqL2OpgjkheVPkHIQeBrbdPGAtNcVZ8WidbEfVaKr5QS/exec" target="_blank" rel="noopener noreferrer">Approve Apps Script access</a> while signed into the Google account you use for Docs. If Google shows a warning screen, click **Advanced**, then **Go to Untitled project (unsafe)**, then **Review permissions** and accept.

<img src="assets/screenshots/Step%203%20-%20approve%20apps%20script%20formatter.png" width="75%" alt="Google Apps Script authorization screen with Advanced, Go to Untitled project unsafe, and Review permissions highlighted">

> Google shows this warning because the Apps Script hasn't gone through Google's public verification process. The script is only used to apply syntax highlighting to your own documents. This step is only needed for formatting; rendering PDFs works without it.

### 4. Pin and enable the extension

Click the **Extensions** puzzle icon in Chrome's toolbar and pin **BETTER AutoLaTeX**. Click its icon and make sure the enable switch is on.

<img src="assets/screenshots/Step%204%20-%20pin%20extension%20in%20top%20bar.png" width="75%" alt="Chrome Extensions menu showing the puzzle icon and BETTER AutoLaTeX pin icon highlighted">

### 5. Use it

Refresh any open Google Docs tab. Click **Better AutoLaTeX** in the Docs menu bar, choose **Render to (Split Screen)** or **Render to (New Tab)**, then click **Render PDF** or **Download PDF**.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+Z` | Render PDF |
| `Ctrl+Shift+X` | Download PDF |
| `Ctrl+Shift+F` | Format the document (double-tap to toggle auto-format) |
| `Ctrl+Shift+L` | Open the extension popup |

On macOS, use `Command` instead of `Ctrl`. Shortcuts can be changed at `chrome://extensions/shortcuts`.

## How it works

1. The content script reads the document (via a copy of the editor contents, falling back to Docs' HTML/text export) and converts it to LaTeX source.
2. The background service worker wraps it in the chosen preamble and POSTs it, along with any images and `.sty` files, to texlive.net, which returns the compiled PDF.
3. Syntax highlighting is applied through a small Google Apps Script web app ([AppsScript.gs](AppsScript.gs)), since extensions can't edit Docs formatting directly. See [FORMATTER_SETUP.md](FORMATTER_SETUP.md).

## Project structure

```
manifest.json          Chrome extension manifest (MV3)
scripts/
  background.js        Service worker: rendering, settings storage, formatter relay
  content.js           Runs in Google Docs: text extraction, split view, menu, hotkeys
  formatter.js         Syntax highlighting and indentation logic
  shared.js            Preambles, LaTeX helpers, settings keys
  popup.js             Toolbar popup (plus inline settings/preamble pages)
  settings.js, preamble.js, resize-bridge.js
html/, styles/, icons/ Extension UI
AppsScript.gs          Formatter backend (deployed separately to Apps Script)
index.html, assets/    GitHub Pages site
better-autolatex.zip   Packaged extension for download
```

## Development

There is no build step. Load the folder with **Load unpacked**, and after editing, click reload on the extension card at `chrome://extensions` and refresh the Google Docs tab.

When releasing, rebuild `better-autolatex.zip` from the extension files only (everything except the paths in `.zipignore`).
