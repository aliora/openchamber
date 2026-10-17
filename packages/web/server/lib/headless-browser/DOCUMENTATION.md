# Server Browser

## Purpose

A web build has no Chromium view it can drive: its browser panel is an iframe, so an agent's `browser.open` used to answer `drivable: false`, and many sites (google.com) refuse framing. This module gives the server its own headless Chrome. The panel shows it as a live picture and forwards the user's mouse and keyboard, so the user and the agent look at and use the same page. The desktop app is unchanged: it keeps driving its own webview.

## How an action reaches it

Nothing in the agent path is new. The server still publishes `openchamber:browser-control-request` to clients that declared `browser=1`; one client claims it and its registered tab runs the action (`../browser-control/DOCUMENTATION.md`). What changed is who can declare it:

- `GET /api/headless-browser/status` answers `{ available, ... }`. A web client reads it once before it opens its event stream (`primeBrowserCapability`). When `available` is true, `canDriveBrowserPage()` is true, the stream opens with `browser=1`, and `browser.open` reports `drivable: true`.
- The web panel then mounts `HeadlessBrowserPane` instead of the iframe. It registers as an ordinary browser controller, so tab ids, ownership by session, claiming, background tabs and the tab list in snapshots all work as they do on desktop.
- The pane runs actions with the page scripts from `packages/ui/src/lib/browser/pageActions.ts` (`headlessActions.ts`) and sends them to this module as commands. The scripts live in one place; this module never builds them.

A web client with no panel mounted cannot answer, so an agent action then fails with the broker's "no client" answer. A server with no Chrome reports `available: false` and the panel stays an iframe.

## Files

| File | Role |
| --- | --- |
| `chrome-path.js` | `resolveChromePath()`: `OPENCHAMBER_CHROME_PATH`, then an installed Chrome, Chromium, Edge or Brave (macOS apps, Windows Program Files and Edge, Linux `PATH`), then the newest Playwright download. No download is ever started. An explicit path that does not exist does not fall back. |
| `cdp-client.js` | One WebSocket to the browser's debugging address: calls matched by id, events by method and session, a timeout per call, every call failed when the socket closes. |
| `browser-process.js` | Starts Chrome (`--headless=new`, `--remote-debugging-port=0`, a profile directory, `--no-sandbox` only as root), reads the debugging address from its stderr, connects. |
| `headless-tab.js` | One page: navigate and wait for the load to end, evaluate, screenshot, history, viewport emulation, console problems, dialogs, screencast viewers, input. |
| `input-bridge.js` | Validates a panel input event and maps it to a CDP `Input.*` call. Anything it cannot map is refused. |
| `manager.js` | Lazy start, tab table, tab limit, idle stop. |
| `routes.js` | The HTTP surface below. |
| `fake-connection.js` | Test double for a CDP connection. |

## HTTP surface

All under `/api`, so the UI auth gate applies. Tab ids are `[A-Za-z0-9:._-]{1,128}`; the panel derives them from its project and tab id (`headlessTabKey`).

| Route | Purpose |
| --- | --- |
| `GET /api/headless-browser/status` | `{ available, source?, reason?, tabs, running }`. |
| `POST /api/headless-browser/tabs/:id/command` | `navigate`, `evaluate`, `settle`, `capture`, `history`, `reload`, `viewport`, `fit`, `info`. The first command for an id creates the tab. |
| `POST /api/headless-browser/tabs/:id/input` | One mouse, key or text event. 404 for a tab that is not open. |
| `GET /api/headless-browser/tabs/:id/stream` | Server-sent events: `meta` (url, title, loading), `frame` (base64 JPEG and its size), `crashed`, `closed`. A new viewer gets the last frame at once. |
| `DELETE /api/headless-browser/tabs/:id` | Closes the tab. |

## Decisions and invariants

- **Engine.** Raw CDP over `ws` (already a dependency); no Playwright. The browser is whatever the machine has, which keeps Pi5 (ARM Chromium from the OS) and the MSI PC (Edge is always there) working without a download.
- **One shared profile.** `<data dir>/headless-browser/profile` keeps logins and cookies between runs. All tabs share it; a tab belongs to a panel tab id.
- **Lazy and bounded.** Nothing starts until a tab is asked for. The browser stops after 10 minutes with no request and no viewer (`HEADLESS_IDLE_MS`). At most 8 tabs (`HEADLESS_MAX_TABS`); a ninth closes the least recently used tab nobody watches, and fails with 409 when all are on screen. The browser is also killed when the server process exits.
- **Loopback only.** The debugging port is ephemeral and bound by Chrome to loopback; only the server holds the connection. Every panel request goes through the authenticated `/api` routes. `file://` addresses can be typed in the panel's address bar; the agent tool keeps its http and https only rule, which it shares with the desktop panel.
- **Looks like a browser.** The user agent drops `HeadlessChrome`. New windows and `target=_blank` links are turned into navigation of the same tab, because an agent cannot see a tab it did not open. Page dialogs are dismissed and recorded as a console problem.
- **Real input.** `browser.click` and `browser.type` find the element with the page script in a locate-only mode (`locateOnly`, `focusOnly` in `pageActions.ts`; the desktop webview keeps the default scripts) and then act with trusted CDP input: a pointer move, press and release at the element's centre, and one key event per character with Enter for `submit`. Scripted DOM events (`isTrusted: false`) made Google answer with its "unusual traffic" page; trusted input through its home page passes. Page-level fingerprints are normalised too: `navigator.webdriver` is off (`--disable-blink-features=AutomationControlled`), the client hints carry real brands (`user-agent.js`), and the window and screen size match the viewport.
- **Bot checks.** A site can still show a check to a browser with a fresh profile (Google does for a direct search URL). The panel is interactive, so the user solves it once there; the shared profile keeps the exemption.
- **Layout.** In `fill` the page is laid out at the panel's size (`fit`, debounced); a chosen viewport (`mobile`, `tablet`, `desktop`) is fixed and the picture is scaled down in the panel. Widths up to 500 are emulated as a phone.
- **Frames.** `Page.startScreencast` runs only while at least one viewer is connected and each frame is acknowledged. Screenshots for `browser.capture` use `Page.captureScreenshot` and do not need a viewer.
- **Tab cleanup.** When the pane unmounts and the panel tab no longer exists in the store, it deletes the server tab. Switching projects unmounts panes without closing the panel tab, so those server tabs stay until the tab limit or the idle stop reclaims them.
- **Not covered.** No downloads, no file chooser, no clipboard copy out of the page, no multi-touch. A second client viewing the same tab shares one page; the last viewport command wins.

## Testing

`*.test.js` here run under Vitest with fakes for the browser (`fake-connection.js`) and a real `ws` server for the CDP client. The UI half is `packages/ui/src/lib/browser/headless*.test.ts` (Bun): the action runner, the input mapping, and the routing from a claimed request through a registered server-browser tab to `drivable: true`.
