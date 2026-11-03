# dsh-plugin-notify

Message reminders for **DeepSeek Harness Web and Desktop**: in-page banners, native
desktop notifications, host system notifications, and Feishu/DingTalk/WeCom/generic
webhooks when a task turn ends, execution waits for user confirmation, or an interactive
question arrives. Includes a **Settings → Notifications** section.

[中文](README.md)

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> Targets **DeepSeek Harness 0.2.1+**. Older 0.1.x (including 0.1.5) is no longer a
> compatibility target; after updating the web side, Web and Desktop use the same API.

## Channels

| Channel | Location | Notes |
| --- | --- | --- |
| In-page reminders (banner) | Client | Text banner in the top-right while the page is visible; supports multiple sessions and click-to-open, independent of native notifications. |
| Desktop / browser system notifications | Client | Desktop uses the Electron notification center, works while the window is hidden or minimized, and needs no browser permission. Web uses the browser Notification API and requires browser permission. Independent of the in-page reminder switch. |
| Host system notification | Host | macOS `osascript` / Linux `notify-send` / Windows PowerShell toast; works with the browser closed. Optional system sound. |
| Feishu group bot | Host | Text message, optional signed secret (timestamp + HMAC-SHA256), optional template. |
| DingTalk group bot | Host | Text message, optional sign (timestamp + sign), optional template. |
| WeCom group bot | Host | Text message, optional template. |
| Generic webhook | Host | Custom URL + headers + JSON/text template for Slack / Discord / ntfy / Bark / ServerChan / PushPlus, etc. |

> The in-page banner is controlled by `browser.enabled` + `browser.toast`; desktop/browser system notifications are controlled independently by `browser.native`.

## Message format

All webhook channels share the placeholders
`{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}`.

- Feishu/DingTalk/WeCom use a unified default format (title + details + session + local time);
  fill **Message template** to override it.
- A generic webhook with an empty template sends the plain-text message body.
- Placeholders are inserted **verbatim** by default. For a JSON request body (Bark `/push`,
  ntfy JSON, …) use `{{json:title}}` / `{{json:body}}` instead: the value is escaped for a JSON
  string literal, so quotes and newlines no longer break the payload — for example
  `{"title":"{{json:title}}","body":"{{json:body}}"}`.

## Triggers

- `turn/end`: filtered by `triggers.turnEndKinds` —
  `completed` / `blocked` / `aborted` / `error` / `max-tokens` / `interrupted`.
  Default: `completed, blocked, aborted, error, max-tokens`; `interrupted` is opt-in.
- `approval/asked`: a tool call waits for user approval.
- `tool/call` with `ask_user_question`: the model asks the user a question.
- The browser channel also covers `plan-review` pending interactions and all sessions.

Host system/webhook channels cover every session. The browser channel covers every session
too and opens the matching session when its banner/native notification is clicked.

## Install

### A. Bundle (recommended on 0.2.x; Web and Desktop)

The package declares `dsh.bundle`; `dsh plugin` adds it to the profile's bundle list and
activates it automatically:

```sh
# local checkout
dsh plugin --profile web add "link:/absolute/path/to/dsh-plugin-notify"
dsh plugin --profile desktop add "link:/absolute/path/to/dsh-plugin-notify"

# or a pinned GitHub release
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.4.0"
dsh plugin --profile desktop add "github:c-ling/dsh-plugin-notify#v1.4.0"

# without a global dsh (web only; the desktop profile is managed by the Desktop CLI/Plugins page)
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.4.0"
```

> On Desktop you can also open **Plugins → Add plugin** and enter the local absolute path or
> `github:c-ling/dsh-plugin-notify#v1.4.0`, then enable it.

Restart the host after installing/updating (client-modules caches package verdicts per
process), then hard-refresh the page or reopen the Desktop window.

### B. Manual loader row (existing `link:` installs)

If you do not want the package in `dsh.profile.bundles`, install it as a dependency and add
one row:

```sh
# dependency only; does not add the package to the bundle list
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-notify#v1.4.0"
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: dsh-plugin-notify
      name: 'dsh-plugin-notify'
```

**Choose one mode**: do not both add the bundle and hand-write the loader row for the same
profile.

## Verify

```sh
# Unauthenticated access should return 401 (route registered + protected by Connection)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/dsh-plugin-notify/config
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:56928/api/dsh-plugin-notify/config

# The old anonymous route should return 404
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/dsh-plugin-notify/config
```

Use **Settings → Notifications** to configure channels and send per-channel tests. Desktop
shows a Desktop badge; the native notification test should appear in the system notification
center.

## Update

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.4.0"
dsh plugin --profile desktop add "github:c-ling/dsh-plugin-notify#v1.4.0"
```

For manual loader installs, re-run the install command with the new `#v1.4.0`; the loader row
stays unchanged. Restart the host and hard-refresh.

## Uninstall

```sh
dsh plugin --profile web remove dsh-plugin-notify
dsh plugin --profile desktop remove dsh-plugin-notify
```

For manual loader installs, also remove the matching `insert` row from `cordis.patch.yml`,
then restart the host. Config data lives in
`$DSH_HOME/storages/dsh-plugin-notify/config.json`; delete that directory to remove it fully.

## Config storage

- Single durable store: `$DSH_HOME/storages/dsh-plugin-notify/config.json` (overridable via the
  plugin row's `config.directory`).
- Atomic writes with mode `0600`; writes are serialized in-process and carry a `revision` for
  optimistic concurrency. Concurrent editors get a 409 and are asked to reload.
- The plugin row config is the composition base; DSH 0.2.x's one-time `settings.yaml` import can
  also land there by entry id. `config.json` wins when present.
- Web and Desktop share `$DSH_HOME`, and therefore the same notification config.

Feishu/DingTalk signature secrets are write-only: GET returns an empty string plus a
`secretSet` marker; an empty POST value keeps the stored secret, and `clearSecrets` lists paths
to clear. Webhook URLs and generic headers are stored in plain text — do not put other sensitive
credentials there.

## Development

```sh
node --check lib/index.js lib/client.js
node --test
```

- The client is a hand-written factory-CJS bundle
  (`window.__ModuleLoader__.load({ id: "dsh-plugin-notify", factory })`) with no build step; its
  UI registers through `settings.section` and `shell.overlay`.
- The host half has no `@deepseek-ai/*` runtime dependency. It registers authenticated routes
  through `ctx.connection.fetch`, subscribes to `session/event`, and reads titles through
  `ctx.sessionTitle` (optional).

Endpoints (all authenticated; the browser uses the `/api` prefix):

- `GET  /api/dsh-plugin-notify/config` — redacted config + `secretSet` + `revision` + `meta`
- `POST /api/dsh-plugin-notify/config` — `{ config, clearSecrets?, expectedRevision? }`
- `POST /api/dsh-plugin-notify/test` — `{ channel, genericId?, config?, sound? }`
- `GET  /api/dsh-plugin-notify/last?sessionId=&kinds=` — latest matched notification (used by the browser for the exact turn-end kind)
- `POST /api/dsh-plugin-notify/system-settings` — open the system notification settings (Desktop)

## Changelog

- **v1.4.0** — Adapt to DeepSeek Harness 0.2.1+ (Web + Desktop): the client now uses
  `sessions.list` + `uiSession.sessionStatus`, restoring browser notifications with multiple
  sessions and click-to-open; host routes moved to `ctx.connection.fetch` and require
  authentication; config moved to `config.json` with revision-based conflict protection; added
  `max-tokens` / `interrupted` turn-end reasons; Desktop uses Electron native notifications and
  the toast respects window chrome; added `dsh.bundle` for installation from the Plugins page.
- **v1.3.0** — Adapt to DeepSeek Harness 0.1.1 (migration A): settings-document persistence
  (`installSettingsSection` + `settingsScope`), config.json base migration, and write-only
  secret fields. Removed in 0.2.1 upstream; deleted in this release.
- **v1.2.0** — Host-channel `ask_user_question` notifications; fixed the fixed notification tag
  that hid successive approval/question alerts.
- **v1.1.3** — Default README in Chinese, English moved to `README-en.md`.
- **v1.1.2** — Split README into English + Chinese, add the `npx` install path and Update section.
- **v1.1.1** — Dark-mode styling for the settings page using `--dsw-alias-*` tokens.
- **v1.1.0** — Browser OS notifications, Windows system notifications, alert sounds.
- **v1.0.0** — First GitHub release: browser banner, system notification, Feishu/DingTalk/WeCom/
  generic webhooks, and the settings page.

## Known limitations

- The OS notification switch cannot be read through the Web API. The desktop page no longer shows a potentially misleading "granted" status; it shows a hint and an "Open system notification settings" button instead.
- Clicking a desktop notification tries `window.focus()` and opens the session. Electron does
  not expose a plugin API to restore a window hidden to the tray, so it may not come back
  automatically.
- Windows Electron notifications depend on the app's AUMID; if they do not appear, use the host
  system notification channel.
- Browser native notifications need permission and the page/host running; use the host system
  channel or webhooks when the app is fully closed.
- Enabling both Desktop and host system notifications may duplicate reminders; the settings
  page warns about it.
- Feishu/DingTalk secrets are write-only + read-sanitized but are stored unencrypted in the
  local `config.json`.

## License

[MIT](LICENSE)
