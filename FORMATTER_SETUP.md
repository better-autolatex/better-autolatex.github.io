# Formatter backend (Ctrl+Shift+F)

In-document syntax highlighting goes through a shared Google Apps Script web app ([AppsScript.gs](AppsScript.gs)). Its `/exec` URL is set as `APPS_SCRIPT_URL` in [scripts/shared.js](scripts/shared.js), so users don't need to configure anything. The first time someone formats a document, Google asks them to authorize the script for their own account.

Rendering PDFs does not use this backend; only formatting does.

## Why a consent prompt is needed

Formatting needs permission to edit Google Docs (`https://www.googleapis.com/auth/documents`). The script is deployed as **Execute as: User accessing the web app**, so each user authorizes it once for their own account and it can only edit documents that user already has access to.

## Redeploying the backend

1. Go to [script.google.com](https://script.google.com) and create a **New project**.
2. Replace the placeholder code with the contents of [AppsScript.gs](AppsScript.gs) and save.
3. **Deploy → New deployment → Web app**, with:
   - **Execute as:** User accessing the web app
   - **Who has access:** Anyone
4. Copy the web app URL (ending in `/exec`) into `APPS_SCRIPT_URL` in [scripts/shared.js](scripts/shared.js), and update the approval links in [README.md](README.md) and [index.html](index.html).

## Updating the script later

Use **Deploy → Manage deployments → Edit (pencil) → New version → Deploy**. This keeps the same `/exec` URL, so nothing in the extension needs to change.
