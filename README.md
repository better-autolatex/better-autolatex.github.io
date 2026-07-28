# BETTER AutoLaTeX

Render Google Docs as LaTeX PDFs from a Chrome extension. It supports split-screen or new-tab rendering, PDF downloads, document settings and preambles, rich text, and Google Docs tables.

<a href="https://better-autolatex.github.io/better-autolatex.zip" target="_blank" rel="noopener noreferrer">Download the extension ZIP</a>

## Install

### 1. Download and extract the extension

Download the ZIP above. In your Downloads folder, right-click `better-autolatex.zip`, click **Extract All...**, and finish extracting it somewhere you plan to keep it.

<img src="assets/screenshots/Step%201%20-%20download%20and%20unzip.png" width="75%" alt="Windows File Explorer with better-autolatex.zip selected and Extract All highlighted">

### 2. Load the extension in Chrome

Open `chrome://extensions` in Chrome. Turn on the **Developer mode** switch in the upper-right corner. Click **Load unpacked**, choose the extracted **better-autolatex** folder, then click **Select Folder**.

<img src="assets/screenshots/Step%202%20-%20developer%20mode%20and%20load%20unpacked.png" width="75%" alt="Chrome Extensions showing Developer mode, Load unpacked, and the folder selection dialog">

### 3. Approve the Google Docs formatter

Open <a href="https://script.google.com/macros/s/AKfycbwRXFpuAWmADQgR0fru4ny5jGrunQsDPgXNTHPpcuvzG7JEthSWD_qqydP0C3cqlonF/exec" target="_blank" rel="noopener noreferrer">Approve Apps Script access</a> while signed into the Google account you use for Docs. If Google shows the warning screen, click **Advanced**, then **Go to Untitled project (unsafe)**. Next, click **Review permissions** and complete the permission prompt.

<img src="assets/screenshots/Step%203%20-%20approve%20apps%20script%20formatter.png" width="75%" alt="Google Apps Script authorization screen with Advanced, Go to Untitled project unsafe, and Review permissions highlighted">

> **About the Google warning:** Google shows it because this Apps Script has not completed Google&apos;s public verification process. That does not mean your computer found malware. BETTER AutoLaTeX uses the script only as a Google Docs formatter - it is not an installer or separate executable. Continue only if you trust the developer/account shown and intend to use this project.

### 4. Activate the extension

In Chrome&apos;s top toolbar, click the **Extensions** puzzle icon. Find **BETTER AutoLaTeX** and click its **pin** icon so it stays visible in the toolbar. Then click the new BETTER AutoLaTeX toolbar icon. Its popup opens; make sure the enable switch is turned on, then close the popup.

<img src="assets/screenshots/Step%204%20-%20pin%20extension%20in%20top%20bar.png" width="75%" alt="Chrome Extensions menu showing the puzzle icon and BETTER AutoLaTeX pin icon highlighted">

### 5. Start using BETTER AutoLaTeX

Refresh any open Google Docs tab. Click **Better AutoLaTeX** in the Docs menu bar, choose **Render to (Split Screen)** or **Render to (New Tab)**, then click **Render PDF** or **Download PDF**.

## Keyboard shortcuts

- `Ctrl + Shift + Z` - Render PDF
- `Ctrl + Shift + X` - Download PDF

On macOS, use `Command` in place of `Ctrl`.

## Development

After changing extension files, click Reload on `chrome://extensions`, then refresh the Google Docs tab.
