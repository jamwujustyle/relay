# Relay

A desktop inbox for incoming requests, screenshots, and LLM handoffs. Capture quickly, keep the original context, and choose your next move from a stable working queue.

## Install and launch

Relay uses Electron with a React and TypeScript interface. AI is optional and uses your own API key.

On Ubuntu (64-bit Intel/AMD), install the local Debian package with APT:

```sh
cd ~/Desktop/relay
sudo apt install ./release/relay-desktop_0.1.1_amd64.deb
```

Then open **Relay** from the applications menu, or run `relay-desktop` in a terminal. Node.js is not needed for the installed app. Remove it with `sudo apt remove relay-desktop`; your personal workspace remains in your user data directory.

This installs a local package. Relay does not have an APT repository yet, so `apt upgrade` will not download new Relay versions. Install a newer `.deb` the same way when one is available.

On Windows (64-bit Intel/AMD), run `release/Relay Setup 0.1.1.exe`, follow the setup wizard, and open **Relay** from the Start menu. It is an unsigned development installer and has not been runtime-tested on Windows.

To update an installed copy, quit Relay from its tray menu, install the newer package, and reopen it. The application ID and data location stay the same, so requests and settings are retained.

To try the app without installing on Ubuntu, run `npm start` from this project after building, or use the executable `release/Relay-0.1.1.AppImage` if your system supports AppImage/FUSE.

## Run from source

Requires Node.js 22 or newer.

```sh
npm install
npm run desktop
```

The desktop app runs on Linux and Windows. `npm run dev` opens a browser preview at `http://127.0.0.1:5173`; the preview uses browser storage and disables API credentials and desktop shortcuts.

```sh
npm run build
npm start
```

## Daily use

- **Capture:** click Capture, press `N` inside Relay, or use `Ctrl+Shift+Space` from another app. The system shortcut picks up clipboard text or a screenshot. Copy the desired message first.
- **Screen capture:** `Ctrl+Alt+Space` takes a screenshot before bringing Relay forward, then opens a capture preview. On X11 and Windows it uses the screen at the pointer; Wayland may open the system screen chooser. The toolbar and tray offer the same action. If unavailable, take a system screenshot, copy it, and use clipboard capture instead.
- **Extract:** in the capture window, click **Extract requests** to propose up to eight separate requests from the text or images. Review, rename, and deselect suggestions, then click **Save selected**. Each saved request retains the original text and images, with the AI summary in its activity. Nothing is saved automatically by extraction.
- **Next:** `Ctrl+Shift+Enter` opens the next-move panel. Active tasks retain their order. Waiting, Later, and Done stay out of recommendations.
- **Context:** keep the original request, attach PNG/JPEG/WebP screenshots, add progress notes, and copy a handoff to your next conversation.
- **Waiting:** record the dependency and a follow-up date. Due follow-ups appear on Overview and dates remain visible in Waiting rows.
- **Focus:** use the compact Focus field on Overview to guide next-request suggestions. Press Enter or leave the field to save.
- **Queue:** set priorities, commitments, projects and deadlines; reorder with row arrows. “Not now” puts a request in Later until you bring it back.
- **Backup:** export/import the workspace in Settings. Imports replace the current workspace after confirmation. API keys are excluded.

The app starts empty. The sample workspace uses example notes and explicitly illustrative project assignments, deadlines, and priorities. Start fresh clears the entire sample workspace, including additions made while exploring it.

In Relay, `Ctrl+K` focuses search, `Ctrl+Enter` saves a capture, and `Esc` closes the current dialog or details. Settings lists all shortcuts and reports unavailable system bindings. An open capture draft is preserved if another capture shortcut is pressed. Screen capture is an explicit single snapshot; there is no background screen monitoring or automatic account scraping.

## Optional AI

In the desktop app, open Settings and supply your own Gemini API key. The default model is `gemini-3.1-flash-lite`; the model is editable. Relay calls Google's API directly from its desktop process. There is no Relay AI server and no local model to run.

AI runs only when you press **Extract requests**, **Ask AI to organize**, or **Get an AI perspective**. Extraction sends the reviewed capture text/images, current focus, and the titles, projects, statuses and IDs of up to 60 recently updated requests to Google. An organize request sends the captured text, selected task screenshots, current focus, and snippets of existing requests. A next-move request sends actionable task context. Suggestions require your action before changing tasks. Original captured text is retained.

Extraction distinguishes outstanding requests from completed work, examples, and conversational context. It may return no requests. The app validates the response shape and relation IDs, while the user reviews meaning before saving. Priorities, commitments, and dates remain manual. Live model accuracy needs evaluation with a user-supplied key; automated checks mock provider responses and do not establish extraction quality.

Keys use Electron's OS-backed `safeStorage` when available. If Linux has no secure keyring, the key is kept for the current session only. It is never sent to the renderer or included in backups. An attempted-request limit defaults to 30/day and counts provider failures; it is not a dollar spending cap. Settings shows estimated daily model usage for Gemini 3.1 and 3.5 Flash-Lite from reported tokens, including thinking tokens. Unknown model prices show as unavailable. Failed calls may not return usage, and the provider's bill is authoritative.

AI payloads and responses are bounded, timed out, and validated. No real provider call is required to use or test the app. Live AI integration needs a valid user-supplied key and account access to the configured model.

## Local data

Desktop data is an atomically written JSON workspace in Electron's per-user application data directory. The original file is preserved if it fails validation. Saves are serialized, and quitting flushes pending desktop writes. Workspace limits: 2,000 requests, 32 MB total, and screenshots up to 5 MB each. Capture allows up to three images; AI image payloads are limited to 10 MB total. The browser preview may have a smaller storage quota.

Telegram and ChatGPT capture use copy/paste or an explicit screen snapshot with optional source links. Automatic account sync, screenshot region selection, cross-device sync, and background notification scheduling are not implemented. Follow-up dates appear in the app. Attachments remain local unless explicitly sent for AI processing; copied handoffs include their names, so attach the images separately when needed.

## Build installers

```sh
npm run package:linux  # release/*.AppImage and release/*.deb
npm run package:deb    # release/*.deb only
npm run package:win    # release/*.exe (build on Windows recommended)
```

Linux global shortcuts depend on the desktop and portal support. The packaged desktop identity must match the installed `.desktop` file on Wayland. If a shortcut is unavailable, use the tray menu or app buttons; Settings reports registration status. Closing the window keeps Relay in the tray when the tray is available. Quit from the tray/application menu to stop it.

Installers are unsigned development builds. Windows signing and a production release/update pipeline are future work.

## Verify

```sh
npm test
npm run build
npm run test:desktop
npm run test:screen # Linux, requires Xvfb; uses an isolated virtual screen
npx playwright install chromium
npm run test:ui
```

Unit tests cover stable recommendations, local calendar dates, context-preserving handoffs, schema validation, atomic persistence/corruption protection, credential handling, bounded Gemini requests, extraction response limits, and screen-capture lifecycle. Browser tests cover capture, extraction acceptance and manual fallback, screenshots, queue behavior, waiting, persistence, backup actions, compact windows, and keyboard focus. The Linux screen smoke test captures a controlled fixture on an isolated X11 display and verifies that Relay hides and returns. Windows and Wayland capture still need platform testing. API tests mock the provider; they do not spend credits.
