# dsh-plugin-notify

Message reminders for the DeepSeek Harness web GUI: browser, system, webhook
(Feishu/DingTalk/WeCom/generic JSON) and sound notifications when a task turn finishes or
execution waits for user confirmation, plus a settings section to manage channels.

[中文](README.md)

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## Channels

| Channel | Location | Notes |
| --- | --- | --- |
| Browser notification (in-page banner) + optional OS notification | Client | Two independent settings. **Browser notification** shows a text banner in the top-right while the page is visible. **OS notification** uses the browser Notification API, so it also fires when the tab is in the background or the window is minimized (browser notification permission required). Keep the browser running and use the host system channel if you leave the page entirely. |
| System notification | Host | macOS `osascript` / Linux `notify-send` / Windows PowerShell native toast (Windows 10/11 action center); works even when the browser is closed. Optional system sound (macOS `afplay` / Windows built-in alert sound). |
| Feishu group bot | Host | Text message, optional signed secret (timestamp + HMAC-SHA256), optional custom message template. |
| DingTalk group bot | Host | Text message, optional signed secret (timestamp + sign), optional custom message template. |
| WeCom group bot | Host | Text message, optional custom message template. |
| Generic webhook | Host | Custom URL + headers + JSON/text template. Placeholders: `{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}`. Works with Slack / Discord / ntfy / Bark / ServerChan / PushPlus, etc. |

## Message format

All webhook channels share the same placeholders:
`{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}`.

- Feishu/DingTalk/WeCom use a unified default format (title + details + session + local time).
  Leave the **Message template** field empty in settings to use the default; fill it to render
  with your own template.
- The generic webhook sends the plain-text message body when its template is empty.

## Triggers

- `turn/end`: fired when a turn ends, filtered by `triggers.turnEndKinds`
  (completed/blocked/aborted/error; default completed+blocked).
- `approval/asked`: fired when a tool call waits for user approval (host channels).
- `tool/call` (with `name` `ask_user_question`): fired when the model asks the
  user a question through the interactive question tool (host channels).
- The browser channel additionally covers interactions waiting for user confirmation
  (approval / question, from the pending list in the session snapshot).

Host system/webhook channels cover all sessions; the browser channel follows the currently
open session.

## Install

Install into the web profile from GitHub (requires `pnpm` on `PATH`; otherwise use the
corepack fallback below):

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.2.0"
```

Or with an existing `dsh` binary:

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.2.0"
```

When `pnpm` is not on `PATH`:

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-notify#v1.2.0"
```

> `dsh plugin` forwards its arguments to pnpm and fetches the package from this repo
> (pnpm 9+, `git` required). The warning
> `declares no dsh.bundle — installed as a plain dependency` is expected: this plugin is
> not a profile bundle layer; it is activated by the loader row below.

Then add a loader row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: notify
      name: 'dsh-plugin-notify'
```

Restart `dsh web` (client-modules caches package verdicts per process; new packages require a
host restart), then hard-refresh the page. The settings page appears under
**Settings → Message reminders**.

## Verify

```sh
curl -s http://127.0.0.1:3080/plugins/dsh-plugin-notify/client.js | head -c 60
```

It should print a factory bundle starting with `window.__ModuleLoader__.load({`; in
**Settings → Message reminders** you can configure each channel and send a test message.

## Update

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.2.0"
# or: npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.2.0"
# or: cd ~/.dsh/profiles/web && corepack pnpm add "github:c-ling/dsh-plugin-notify#v1.2.0"
```

Re-running the install command with the new `#v1.2.0` pin upgrades the dependency;
the loader row in `cordis.patch.yml` stays unchanged. Restart `dsh web`, then hard-refresh.

## Uninstall

```sh
cd ~/.dsh/profiles/web
corepack pnpm remove dsh-plugin-notify   # or: dsh plugin --profile web remove dsh-plugin-notify
```

Also remove the matching `insert` row from `cordis.patch.yml`, then restart `dsh web`.
Configuration data remains under `$DSH_HOME/storages/dsh-plugin-notify/config.json`; delete
that directory to remove it completely.

## Config storage

Configuration is stored in `$DSH_HOME/storages/dsh-plugin-notify/config.json` (overridable
via `config.directory` in the plugin loader row). Webhook signature secrets are write-only:
the API reads them back as empty strings and marks configured ones with `secretSet`. An empty
string on write means “keep unchanged”; `clearSecrets` lists paths to clear. Webhook URLs and
generic request headers are stored in plain text, so do not put sensitive credentials there
(other than the Feishu/DingTalk signature secrets).

## Development

```sh
node --check lib/index.js lib/client.js
node --test
```

The client is a hand-written factory-CJS bundle
(`window.__ModuleLoader__.load({ id: "dsh-plugin-notify", factory })`) with no build step;
its UI is registered through the `settings.section` and `shell.overlay` slots. The host half
uses only Node built-in modules (no `@deepseek-ai/*` dependencies), registers three routes on
the `webServer` service, and subscribes to the `session/event` stream.

Endpoints:

- `GET  /dsh-plugin-notify/config` — sanitized current config + `secretSet`
- `POST /dsh-plugin-notify/config` — `{ config, clearSecrets? }` replaces the user-editable config
- `POST /dsh-plugin-notify/test` — `{ channel: "system" | "feishu" | "dingtalk" | "wecom" | "generic", genericId? }` sends a test message

## Changelog

- **v1.2.0** — Host channels now support `ask_user_question` notifications: when the model
  calls `ask_user_question`, the system channel and Feishu/DingTalk/WeCom/generic webhooks
  send a "waiting for answer" reminder. Also fixed browser native notifications only
  showing the first pending notification because of a fixed notification tag.
- **v1.1.3** — Normalize the README structure: the default `README.md` is now Chinese and
  the English doc moved to `README-en.md` (`README-ZH.md` removed); every install command is
  pinned to `#v1.1.3`.
- **v1.1.2** — Split the README into default English `README.md` + Chinese `README-ZH.md`
  (reciprocal language links at the top), add the `npx @deepseek-ai/dsh plugin ...` install
  path and an Update section, and pin every install command to `#v1.1.2`.
- **v1.1.1** — Fix dark-mode styling for the **Settings → Message reminders** page: save
  button, switches, card/input borders and status colors now use `--dsw-alias-*` design
  tokens and follow the light/dark theme.
- **v1.1.0** — Add browser OS notifications, Windows system notifications and alert sounds;
  browser and OS notifications are now independent settings.
- **v1.0.0** — First GitHub release: browser banner, system notification,
  Feishu/DingTalk/WeCom/generic webhook channels, and the settings page.

## Known limitations

- The browser channel is an in-page text banner by default. When **OS notification** is
  enabled, the browser Notification API can notify while the tab is in the background or the
  window is minimized (permission required, and the browser must stay running). Use the host
  system notification channel when the browser is fully closed.
- Feishu/DingTalk signature secrets are write-only + read-sanitized and stored unencrypted in
  the local `config.json`; do not put other sensitive credentials in generic-webhook URLs or
  request headers.

## License

[MIT](LICENSE)
