BETTER AutoLaTeX — Chrome Extension v2.0.0
============================================

LaTeX rendering inside Google Docs. Press Ctrl+Shift+Z in any Google
Doc and the document compiles to PDF via texlive.net and opens in a split view.


INSTALLATION
------------

1. Unzip BETTER-AutoLaTeX-chrome.zip somewhere stable on your machine.
2. Open Chrome and go to:    chrome://extensions
3. Enable "Developer mode" (toggle at the top right of that page).
4. Click "Load unpacked".
5. Pick the unzipped "better-autolatex-chrome" folder
   (the folder that contains manifest.json).
6. Open any Google Doc — a "LaTeX Renderer" dropdown appears in the
   Chrome extension popup next to File / Edit / View.


KEYBOARD SHORTCUTS
------------------

    Ctrl + Shift + Z            Render the doc as PDF (opens in split view).
    Ctrl + Shift + X            Render and download the PDF.

On macOS, Cmd works in place of Ctrl.

These shortcuts also work while the rendered PDF has focus — both in the
split-view panel and in a separate PDF tab — because they are registered as
browser-level commands. You can rebind them at chrome://extensions/shortcuts.


DROPDOWN MENU
-------------

Click "LaTeX Renderer" in the Chrome extension popup:

    Render PDF                  Same as Ctrl+Shift+Z.
    Render and Download PDF     Same as Ctrl+Shift+X.

    Settings                    Document class, fonts, colours.
    Edit Preamble               Customise the LaTeX preamble; upload .sty files.

    Help                        Full documentation.


HOW IT WORKS
------------

When you trigger a render, the extension reads your doc text via Google
Docs' own copy mechanism (your clipboard is NOT overwritten), parses out
inline images and formatting (bold / italic / underline), wraps the body
in your chosen LaTeX preamble, and POSTs it directly to texlive.net.
The PDF response streams straight into a split view.

This is much faster than the original Apps Script add-on because:
  * No Apps Script execution round-trip
  * No double base64 encoding of the PDF response
  * Native chrome.downloads API for downloads


WHAT'S DIFFERENT FROM THE APPS SCRIPT VERSION
---------------------------------------------

Kept:
  * Full LaTeX rendering pipeline (article + exam preambles)
  * Custom preamble editor
  * .sty file uploads
  * Inline image handling via Lua base64 decoder
  * Bold/italic/underline conversion to \textbf/\textit/\underline
  * Document title injected as \documentName
  * All syntax settings (stored for compatibility)

Changed / new:
  * Toolbar button is a dropdown menu (top-bar HTML, not a sidebar)
  * Ctrl+Shift+Z and Ctrl+Shift+X hotkeys
  * Faster rendering (direct fetch to texlive.net, no Apps Script hop)
  * Faster download (chrome.downloads native API)
  * Settings / Preamble / Help open as full-tab pages

Removed:
  * "Start Formatting" and "Format Now" — Chrome extensions can't change
    the colour of text inside Google Docs' canvas-rendered surface.
    The syntax-colour settings are preserved in storage for compatibility
    but are no longer visually applied to the doc itself.


TROUBLESHOOTING
---------------

"Could not find Google Docs input target"
    Refresh the doc and try again. Make sure the doc has fully loaded.

"Could not copy from the document"
    Click once inside the document body, then try the hotkey or menu
    item again.

"LaTeX compilation failed"
    The error log from texlive.net is shown directly. Check your LaTeX
    source for unbalanced braces, missing packages, etc.


--
Built on https://texlive.net
