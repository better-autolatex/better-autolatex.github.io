# Formatter backend (Ctrl+Shift+F)

BETTER AutoLaTeX ships with a **shared** Apps Script backend baked in, so
in-document syntax formatting works out of the box — no setup, no URL to
paste, no Settings field. The first time you run Format / Auto-format,
Google will show a one-time authorization prompt for your own account;
that's expected (see "Why the consent prompt exists" below).

There is no per-user override anymore — the extension always calls the
single URL baked into [scripts/shared.js](scripts/shared.js) as
`APPS_SCRIPT_URL`. (An earlier version had a Settings field for pasting a
different deployment's URL; it was removed after a stale value left in it
silently shadowed the shared backend and caused confusing 404s. If you need
a different backend, change `APPS_SCRIPT_URL` directly in shared.js — see
below.)

## If you're maintaining this extension and need to redeploy the backend

1. Go to **[script.google.com](https://script.google.com)** and sign in.
2. **New project** → delete the placeholder code → paste in the contents of
   [AppsScript.gs](AppsScript.gs) from this repo → **Save**.
3. **Deploy → New deployment** → gear icon → **Web app**.
4. Set:
   - **Execute as:** `User accessing the web app` (so it acts on each
     caller's own documents, not just the deployer's)
   - **Who has access:** `Anyone`
5. **Deploy**, copy the **Web app URL** (`.../exec`).
6. Paste that URL into `APPS_SCRIPT_URL` in
   [scripts/shared.js](scripts/shared.js). This is a code change, not a
   setting — it ships with the extension for everyone.

## If you ever change the script afterward

Use **Deploy → Manage deployments → (pencil icon) → New version → Deploy**
so the `/exec` URL stays the same and `APPS_SCRIPT_URL` doesn't need
updating.

## Why the consent prompt exists

Formatting a Google Doc requires Google's Docs edit permission (OAuth scope
`.../auth/documents`). With "Execute as: User accessing the web app," each
caller authorizes that permission for their **own** account the first time
they use the backend — a real, one-time Google consent screen the extension
cannot skip or automate. This is expected and is what lets one shared
deployment format documents for many different users, each only ever
touching their own docs.

(An earlier design had each user deploy and run their own copy under
"Execute as: Me" to sidestep exactly this prompt. That's still a valid
option — see above — but isn't necessary by default now that the shared
deployment has been confirmed working, including on managed/school Google
accounts.)
