# BETTER AutoLaTeX

Render Google Docs as LaTeX PDFs from a Chrome extension. It supports split-screen or new-tab rendering, PDF downloads, document settings and preambles, rich text, and Google Docs tables.

> Before publishing, replace `YOUR_GITHUB_USERNAME` in the download URL below with the GitHub account or organization that owns this repository.

[Download the extension ZIP](https://github.com/neevshaw/better-autolatex/archive/refs/heads/main.zip)

## Install

1. Download and extract the ZIP. Keep the extracted folder somewhere permanent.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted folder that contains `manifest.json`.
6. Open the formatter deployment once and approve Google access: [Approve Apps Script access](https://script.google.com/macros/s/AKfycbwRXFpuAWmADQgR0fru4ny5jGrunQsDPgXNTHPpcuvzG7JEthSWD_qqydP0C3cqlonF/exec).
7. Refresh any open Google Docs tab.

## Use

Open a Google Doc and choose **Better AutoLaTeX** from the Docs menu bar.

- **Render PDF** renders to the selected destination.
- **Download PDF** renders and downloads a PDF.
- **Render to (Split Screen/New Tab)** switches the destination.
- **Auto-format** toggles automatic LaTeX formatting.
- **Settings** and **Edit Preamble** open in the extension popup.

Keyboard shortcuts:

- `Ctrl + Shift + Z` — Render PDF
- `Ctrl + Shift + X` — Download PDF

On macOS, use `Command` in place of `Ctrl`.

## Screenshots

Add the following images before publishing, then replace these placeholders with regular Markdown images.

<!-- TODO: ![Load unpacked in chrome://extensions](assets/screenshots/install.png) -->

<!-- TODO: ![Better AutoLaTeX menu in Google Docs](assets/screenshots/menu.png) -->

<!-- TODO: ![Rendered PDF in split screen](assets/screenshots/rendered-pdf.png) -->

## Development

After changing extension files, click Reload on `chrome://extensions`, then refresh the Google Docs tab.
