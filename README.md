# <picture><source media="(prefers-color-scheme: dark)" srcset="docs/references/badges/openchamber-logo-dark.svg"><img src="docs/references/badges/openchamber-logo-light.svg" width="32" height="32" align="absmiddle" /></picture> OpenChamber

[![GitHub stars](https://img.shields.io/github/stars/openchamber/openchamber?style=flat&labelColor=100F0F&color=66800B)](https://github.com/openchamber/openchamber/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/openchamber/openchamber?style=flat&labelColor=100F0F&color=205EA6)](https://github.com/openchamber/openchamber/releases/latest)
[![Discord](https://img.shields.io/badge/Discord-join.svg?style=flat&labelColor=100F0F&color=8B7EC8&logo=discord&logoColor=FFFCF0)](https://discord.gg/ZYRSdnwwKA)
[![Support the project](https://img.shields.io/badge/Support-Project-black?style=flat&labelColor=100F0F&color=EC8B49&logo=patreon&logoColor=FFFCF0)](https://www.patreon.com/openchamber)

<a href="https://www.blacksmith.sh/"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/references/badges/blacksmith-dark.svg"><img src="docs/references/badges/blacksmith-light.svg" height="28" alt="CI powered by Blacksmith" /></picture></a>

## Run agent work. Keep control. Ship from anywhere.

**OpenChamber is an open-source workspace for running and reviewing AI coding work on desktop, web, VS Code, and mobile.**

Start agent work, see what changed, and take it through review and release. Your projects and sessions remain available when you switch devices or step away.

![OpenChamber Chat](docs/references/chat_example.png)

<details>
<summary>More screenshots</summary>

![VS Code Extension](packages/vscode/extension.jpg)

<p>
<img src="docs/references/pwa_chat_example.png" width="45%" alt="OpenChamber PWA chat">
<img src="docs/references/pwa_diff_example.png" width="45%" alt="OpenChamber PWA diff review">
</p>

</details>

## What you can do with OpenChamber

### Goals that continue on their own

Give a session a finish line with **Session Goals**. OpenChamber checks the result after every turn and keeps the agent working until it completes the goal, gets blocked, or reaches the limit you set. It can continue after you close the app.

### Compare and combine runs

Use **Multi-run** to give the same task to up to five models, each in its own session and optionally its own worktree. See what each one actually built, choose the best result, or use **Fusion** to combine the strongest parts into a new session.

### Guided changes walkthroughs

**Changes Walkthrough** turns a large diff into an AI-guided tour of the change. It groups related edits into steps, puts them in the order the change makes sense, and explains how the pieces fit together.

### Inspect a running app

Open your app beside the conversation with **Preview**. Point at an element to send the agent its screenshot, styles, position, and browser errors. No more trying to explain "this thing here." The desktop app can do the same with any web page in its built-in browser.

### GitHub context from issue to pull request

Start a session from a GitHub issue or pull request with its context attached. Send failed checks or review comments back to the agent, then update or merge the pull request from OpenChamber.

### Continue on another device

Open the same projects and sessions from Desktop, Web/PWA, VS Code, iOS, or Android. Check progress, answer questions, review changes, and reattach to a running terminal.

### Private remote access

Pair a device with a one-time QR code and connect through **Private Relay** without opening ports or exposing a public server. The connection is end-to-end encrypted and can be revoked at any time. Direct connections, LAN/VPN access, Cloudflare/Ngrok tunnels, and SSH are also supported.

### Track work across projects

See which sessions are working, waiting, finished, or failed, along with approvals, scheduled tasks, provider limits, token use, and costs. Organize sessions into folders and keep notes, todos, and reusable project actions nearby.

### Schedule recurring work

Run a prompt once, daily, weekly, or on a cron schedule. Scheduled tasks can use Session Goals, so they continue toward an outcome instead of stopping after one response.

## Use it where you work

| Surface | Role |
| --- | --- |
| **Desktop** | The complete workspace for macOS, Windows, and Linux, with multiple windows, Mini Chat, remote machines, SSH, and native notifications |
| **Web / PWA** | Open your workspace in a browser, install it as an app, and stay up to date through background notifications |
| **VS Code** | Keep sessions beside your code, send selections to the agent, open results in the editor, and compare parallel runs |
| **iOS / Android** | Review and steer work away from your desk, receive completion alerts, and use the terminal with touch controls |
| **CLI / Server** | Run OpenChamber on a workstation or server, schedule work, manage remote access, and keep it available after login |

## Quick start

### Server install (this fork: Linux, Raspberry Pi, macOS)

This fork runs Claude Code, Codex and Antigravity as engines inside the server. You install only OpenChamber; the app installs and updates the CLIs for you. The OpenCode CLI is not needed.

Requirements: Node.js 22+ and npm. Everything runs as your normal user, no `sudo`.

**1. Build the package** (on any machine with the repo and [Bun](https://bun.sh)):

```bash
bun install
bun run build:web
bun pm pack --cwd packages/web --destination .
```

This writes `openchamber-web-<version>.tgz`. Copy it to the server.

**2. Let npm install into your home folder** (Linux; skip on macOS with Homebrew Node). The app installs the CLIs with npm too, so this is what lets it do that without `sudo`:

```bash
npm config set prefix "$HOME/.npm-global"
echo 'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"' >> ~/.profile
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
```

**3. Install OpenChamber:**

```bash
npm install -g ./openchamber-web-<version>.tgz
openchamber --version
```

**4. Set the UI password** (kept in a file only you can read):

```bash
mkdir -p ~/.config/openchamber && umask 077
read -rs -p "UI password: " PW && echo
printf 'OPENCHAMBER_UI_PASSWORD=%s\n' "$PW" > ~/.config/openchamber/ui-password.env
```

**5. Start it at boot.**

Linux (systemd user service):

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/openchamber.service <<'EOF'
[Unit]
Description=OpenChamber
After=network-online.target

[Service]
EnvironmentFile=%h/.config/openchamber/ui-password.env
Environment=PATH=%h/.npm-global/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.npm-global/bin/openchamber serve --foreground --port 3000 --host 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
sudo loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now openchamber
curl -s http://127.0.0.1:3000/health
```

`enable-linger` (the only `sudo` step, once) keeps the service running without a login session.

macOS: create `~/Library/LaunchAgents/dev.openchamber.web.plist` that runs `openchamber serve --foreground --port 3000 --host 0.0.0.0` with `OPENCHAMBER_UI_PASSWORD` in `EnvironmentVariables`, `RunAtLoad` and `KeepAlive` true, then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.openchamber.web.plist`. Keep the plist readable only by you (`chmod 600`).

**6. First start.** Open `http://<server-ip>:3000` and sign in with the password. The setup wizard lists Claude Code, Codex and Antigravity: pick the ones you want and press Install; the server installs them (npm for Claude Code and Codex, the official script for Antigravity into `~/.local/bin`). Then sign in to each from **Settings → Engines → Sign in**; it opens the login in the in-app terminal, so it works from a phone too:

| Engine | Sign-in command | Notes |
|---|---|---|
| Claude Code | `claude auth login` | Open the printed link, paste the code back |
| Codex | `codex login --device-auth` | Open the link, enter the shown code |
| Antigravity | `agy` | Type `/login` inside agy |

Settings → Engines is also where you update, reinstall, uninstall or diagnose each CLI later.

**7. Connect the phone app.** On the server:

```bash
openchamber connect-url --server http://<server-ip>:3000 --name "<server name>"
```

Open the printed `openchamber://connect?...` link on the phone (scan it as a QR code with the camera, or paste it into **Add by address**). Add each of your servers the same way; the app shows them all in one sidebar, and personal settings follow you across them.

**Updating:** rebuild the package (step 1), then `npm install -g ./openchamber-web-<version>.tgz` and `systemctl --user restart openchamber` (macOS: `launchctl kickstart -k gui/$(id -u)/dev.openchamber.web`).

**Troubleshooting**
- `Port 3000 is already in use`: another program holds the port; the service retries every 5 seconds, or pick another `--port`.
- An engine install fails with `EACCES`: npm is still installing into a system folder; redo step 2 and restart the service.
- Logs: `journalctl --user -u openchamber -f` (Linux), `~/Library/Logs/OpenChamber/` (macOS).

#### Push notifications (this fork)

The phone gets a push when an agent asks a question, needs permission or finishes its turn, and when a scheduled task starts and finishes. The app is `com.agft.openchamber`, so every server sends with your own APNs key (the upstream relay cannot reach this app).

1. **Create the key once** at [developer.apple.com](https://developer.apple.com/account/resources/authkeys/list): **Keys → +**, name it, tick **Apple Push Notifications service (APNs)** (environment: Sandbox & Production), **Register**, then **Download** the `AuthKey_<KEYID>.p8`. Apple lets you download it only once. Note the **Key ID**; the Team ID is `Z78PY5RC4C`.
2. **Enable push on the App ID:** **Identifiers → com.agft.openchamber → Push Notifications → Save**. Rebuild the app afterwards so its provisioning profile includes push.
3. **On every server** (the same key works for all of them):

   ```bash
   mkdir -p ~/.config/openchamber/apns && chmod 700 ~/.config/openchamber/apns
   cp AuthKey_<KEYID>.p8 ~/.config/openchamber/apns/
   printf '{"keyId":"%s","teamId":"Z78PY5RC4C","bundleId":"com.agft.openchamber"}\n' "<KEYID>" > ~/.config/openchamber/apns/apns.json
   chmod 600 ~/.config/openchamber/apns/*
   ```

4. **Restart** OpenChamber (`systemctl --user restart openchamber`, macOS: `launchctl kickstart -k gui/$(id -u)/dev.openchamber.web`).
5. **On the phone**, tap **Enable** when the app offers notifications (or turn them on in **Settings → Notifications**) and allow them in the iOS prompt. The phone registers with every saved server, so pushes arrive from all of them. **Settings → Notifications** picks which events notify.

The server logs a warning when the key file is readable by other users; it never logs the key. Details: `packages/web/server/lib/notifications/APNS.md`.

### Desktop for macOS, Windows, and Linux

Download the latest release from [GitHub Releases](https://github.com/openchamber/openchamber/releases/latest). Desktop bundles the matching OpenCode CLI, so no separate OpenCode installation is required.

Linux releases come for x86_64 and ARM64 as a `.deb` (Debian, Ubuntu), an `.rpm` (Fedora, openSUSE) and an AppImage. The packages install OpenChamber into the app menu, and in-app updates ask for your password to install the new package:

```bash
sudo apt install ./OpenChamber-*-linux-amd64.deb    # Debian, Ubuntu
sudo dnf install ./OpenChamber-*-linux-x86_64.rpm   # Fedora
```

The AppImage needs no install. Make it executable and keep it in a writable location for in-app updates; on its first start it adds itself to the app menu:

```bash
chmod +x OpenChamber-*.AppImage
./OpenChamber-*.AppImage
```

Linux AppImages require FUSE (`libfuse.so.2`). Without FUSE, run with `APPIMAGE_EXTRACT_AND_RUN=1`.

### VS Code

Install [OpenChamber from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=fedaykindev.openchamber), or search for "OpenChamber" in Extensions.

### CLI for Web and PWA

Requires Node.js 24.14+. CLI/Web and VS Code use your installed [OpenCode CLI](https://opencode.ai).

```bash
curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh | bash
openchamber --ui-password be-creative-here
```

Common operations:

```bash
openchamber status
openchamber connect-url --qr
openchamber tunnel start --provider cloudflare --mode quick --qr
openchamber startup enable
openchamber logs
openchamber stop
openchamber update
```

OpenChamber binds to localhost by default. Use `--lan` only on a trusted network and protect browser access with `--ui-password`.

## Guides

Go deeper with the OpenChamber guides:

- [Quick start](packages/docs/content/docs/quickstart.mdx)
- [Installation](packages/docs/content/docs/install.mdx)
- [Connect devices](packages/docs/content/docs/connect-devices.mdx)
- [Private Relay](packages/docs/content/docs/private-relay.mdx)
- [Multi-run](packages/docs/content/docs/multi-run.mdx)
- [Session Goals](packages/docs/content/docs/session-goals.mdx)
- [Changes Walkthrough](packages/docs/content/docs/walkthrough.mdx)
- [Preview and dev servers](packages/docs/content/docs/preview.mdx)
- [GitHub workflows](packages/docs/content/docs/github.mdx)
- [Mobile](packages/docs/content/docs/mobile.mdx)
- [Security](packages/docs/content/docs/security.mdx)
- [Troubleshooting](packages/docs/content/docs/troubleshooting.mdx)

For self-hosting details, see the [reverse proxy guide](docs/REVERSE_PROXY.md). For custom theme authoring, see the [custom themes guide](docs/CUSTOM_THEMES.md).

## Why OpenCode?

OpenChamber uses [OpenCode](https://opencode.ai) to run coding agents. We chose it because it is open source, has a solid API, and is easy to extend.

OpenChamber handles the rest of the workflow. You can decide what to try, keep the agent on track, review the result, connect from another device, and ship the change.

OpenChamber is an independent project and is not affiliated with the OpenCode team.

## Contributing

Bug fixes and small improvements are welcome as PRs. Features and behavior changes start in an [Ideas discussion](https://github.com/openchamber/openchamber/discussions/categories/ideas) so we agree on the product side before anyone writes code. Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a PR; it has the setup, the review contract, and what happens to large unplanned PRs. Documentation authoring guidance lives in [`packages/docs`](packages/docs/README.md).

Bugs go to [issues](https://github.com/openchamber/openchamber/issues/new/choose). Questions go to [Q&A discussions](https://github.com/openchamber/openchamber/discussions/categories/q-a).

## Acknowledgments

Special thanks to:

- [OpenCode](https://opencode.ai) for the API and open-source architecture OpenChamber builds on
- [Pierre](https://pierrejs-docs.vercel.app/) for the diff viewer and syntax highlighting
- The [T3 Code](https://github.com/pingdotgg/t3code) team for their browser adapter for [libghostty-vt](https://github.com/ghostty-org/ghostty), which our terminal is built on
- [Yulia Ivashko](https://github.com/yulia-ivashko), who built the firework celebration that plays on every successful push
- Everyone who contributed code, reported bugs, or shared ideas

## License

MIT
