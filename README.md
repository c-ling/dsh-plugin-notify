# dsh-plugin-notify

DeepSeek Harness **Web 与桌面端**的消息提醒插件：任务回合结束、执行等待用户确认、或模型通过提问工具等待回答时，按配置向所选渠道发送提醒，并在设置面板提供「消息提醒」菜单页。

[English](README-en.md)

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> 适用于 **DeepSeek Harness 0.2.1+**。旧版 0.1.x（含 0.1.5）不再作为兼容目标；升级 web 端后与桌面端使用同一套 API。

## 渠道

| 渠道 | 位置 | 说明 |
| --- | --- | --- |
| 页面内提醒（横幅） | 客户端 | 页面可见时在右上角弹出文字横幅；支持多会话、点击跳转会话，与原生通知相互独立。 |
| 桌面通知 / 浏览器系统通知 | 客户端 | 桌面端通过 Electron 通知中心发送，窗口隐藏或最小化仍会提醒，无需浏览器授权；Web 端通过浏览器 Notification API 发送，需要浏览器通知权限。不受页面内提醒总开关影响。 |
| 宿主系统通知 | 宿主机 | macOS `osascript` / Linux `notify-send` / Windows PowerShell 原生 toast；浏览器关闭也能收到。可选系统提示音。 |
| 飞书群机器人 | 宿主机 | 文本消息，可选签名密钥（timestamp + HMAC-SHA256），可选自定义消息模板。 |
| 钉钉群机器人 | 宿主机 | 文本消息，可选加签（timestamp + sign），可选自定义消息模板。 |
| 企业微信群机器人 | 宿主机 | 文本消息，可选自定义消息模板。 |
| 通用 Webhook | 宿主机 | 自定义 URL + headers + JSON/文本模板，可对接 Slack / Discord / ntfy / Bark / Server酱 / PushPlus 等。 |

> 页面内横幅由 `browser.enabled` + `browser.toast` 控制；桌面/浏览器系统通知由 `browser.native` 独立控制，两者互不门控。

## 消息格式

所有 Webhook 渠道共用同一套占位符：`{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}`。

- 飞书/钉钉/企业微信默认使用统一格式（标题 + 详情 + 会话 + 本地时间）；在设置页填写「消息模板」可覆盖。
- 通用 Webhook 的模板留空时发送纯文本消息正文。
- 模板里的占位符默认**原样插入**。要把它放进 JSON 请求体（Bark `/push`、ntfy JSON 等），请改用 `{{json:title}}` / `{{json:body}}`：值会按 JSON 字符串转义（引号、换行都不再破坏结构），例如 `{"title":"{{json:title}}","body":"{{json:body}}"}`。

## 触发

- `turn/end`：回合结束，按 `triggers.turnEndKinds` 过滤，支持
  `completed` / `blocked` / `aborted` / `error` / `max-tokens` / `interrupted`。
  默认 `completed, blocked, aborted, error, max-tokens`；`interrupted` 可选。
- `approval/asked`：工具调用等待用户审批。
- `tool/call`（`name` 为 `ask_user_question`）：模型通过提问工具向用户提问。
- 浏览器渠道还覆盖 `plan-review` 等待确认交互，并支持多会话通知。

宿主系统/Webhook 渠道覆盖所有会话；浏览器渠道覆盖所有会话，并在点击横幅/原生通知时打开对应会话。

## 安装

### 方式 A：Bundle（0.2.x 推荐，Web/桌面端通用）

包已声明 `dsh.bundle`，`dsh plugin` 会把它加入 profile 的 bundle 列表并自动激活：

```sh
# 本地开发目录
dsh plugin --profile web add "link:/absolute/path/to/dsh-plugin-notify"
dsh plugin --profile desktop add "link:/absolute/path/to/dsh-plugin-notify"

# 或从 GitHub 固定版本安装
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.4.0"
dsh plugin --profile desktop add "github:c-ling/dsh-plugin-notify#v1.4.0"

# 没有全局 dsh 时（仅 web profile；desktop profile 由 Desktop 自带 CLI/Plugins 页管理）
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.4.0"
```

> 桌面端也可以打开侧边栏 **Plugins → Add plugin**，在包名/路径输入框填入本地绝对路径或
> `github:c-ling/dsh-plugin-notify#v1.4.0`，安装后按提示启用。

安装/更新后重启对应宿主（客户端模块按进程缓存包裁决），然后硬刷新页面或重新打开桌面窗口。

### 方式 B：手动 loader 行（已有 `link:` 安装可继续使用）

如果不想让包进入 `dsh.profile.bundles`，可以只安装依赖并手动加一行：

```sh
# 只安装依赖，不会自动加入 bundle 列表
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-notify#v1.4.0"
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: dsh-plugin-notify
      name: 'dsh-plugin-notify'
```

**两种方式二选一**：同一 profile 不要同时把包加入 bundle 列表又手写 loader 行。

## 验证

```sh
# 未认证访问应返回 401，说明路由已注册且受 Connection 保护
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/dsh-plugin-notify/config
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:56928/api/dsh-plugin-notify/config

# 旧匿名路由应返回 404
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/dsh-plugin-notify/config
```

在 **设置 → 消息提醒** 中可配置渠道并逐渠道发送测试消息。桌面端会显示桌面徽标，原生通知测试应出现在系统通知中心。

## 更新

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.4.0"
dsh plugin --profile desktop add "github:c-ling/dsh-plugin-notify#v1.4.0"
```

手动 loader 方式则用新的 `#v1.4.0` 重新执行安装命令，loader 行保持不变。更新后重启宿主并硬刷新。

## 卸载

```sh
dsh plugin --profile web remove dsh-plugin-notify
dsh plugin --profile desktop remove dsh-plugin-notify
```

手动 loader 方式需同时删除 `cordis.patch.yml` 中对应的 `insert` 行，然后重启宿主。
配置数据保存在 `$DSH_HOME/storages/dsh-plugin-notify/config.json`；彻底清除时删除该目录即可。

## 配置存储

- 唯一持久化位置：`$DSH_HOME/storages/dsh-plugin-notify/config.json`（可通过插件行 `config.directory` 覆盖）。
- 文件以 `0600` 权限原子写入；写入在宿主进程内串行化，并带 `revision` 乐观并发保护。多个窗口同时编辑时，后保存者会收到 409 并提示重新加载。
- 插件行 config 作为组合基础层；0.2.x 的一次性 `settings.yaml` 导入若按 entry id 落到本插件，也会作为基础层被读取。`config.json` 存在时优先使用它。
- Web 与桌面端共享同一份 `$DSH_HOME`，因此也共享同一份通知配置。

飞书/钉钉签名密钥按只写字段处理：GET 只返回空串和 `secretSet` 标记；POST 空串表示保持原值，`clearSecrets` 列出要清除的路径。Webhook 地址与通用请求头以明文保存，请勿在其中放置其他敏感凭据。

## 开发

```sh
node --check lib/index.js lib/client.js
node --test
```

- 客户端为手写 factory-CJS bundle（`window.__ModuleLoader__.load({ id: "dsh-plugin-notify", factory })`），无构建步骤；UI 通过 `settings.section` 与 `shell.overlay` 注册。
- 宿主端不依赖任何 `@deepseek-ai/*` 运行时包；通过 `ctx.connection.fetch` 注册认证路由，订阅 `session/event`，并用 `ctx.sessionTitle`（可选）读取会话标题。

接口（均需 Connection 认证，浏览器实际访问 `/api` 前缀）：

- `GET  /api/dsh-plugin-notify/config` — 脱敏配置 + `secretSet` + `revision` + `meta`
- `POST /api/dsh-plugin-notify/config` — `{ config, clearSecrets?, expectedRevision? }`
- `POST /api/dsh-plugin-notify/test` — `{ channel, genericId?, config?, sound? }` 发送测试消息
- `GET  /api/dsh-plugin-notify/last?sessionId=&kinds=` — 最近一条已匹配通知（浏览器用于精确回合结束原因）
- `POST /api/dsh-plugin-notify/system-settings` — 打开系统通知设置（桌面端）

## 更新日志

- **v1.4.0** — 适配 DeepSeek Harness 0.2.1+（Web + 桌面端）：客户端改用 `sessions.list` + `uiSession.sessionStatus`，页面内提醒恢复并支持多会话、点击跳转；宿主路由迁移到 `ctx.connection.fetch` 并强制认证；配置改为 `config.json` + revision 并发保护；新增 `max-tokens` / `interrupted` 结束原因；桌面端使用 Electron 原生通知，Toast 适配窗口 chrome；新增 `dsh.bundle`，可由 Plugins 页安装。
- **v1.3.0** — 适配 DeepSeek Harness 0.1.1（迁移 A）：配置优先存入官方设置文档（`installSettingsSection` + `settingsScope`），旧 `config.json` 自动作为 base 迁移；飞书/钉钉签名密钥改为 schema `role('secret')` 只写字段。（0.2.1 起该机制已被上游移除，本版删除。）
- **v1.2.0** — 宿主机渠道支持 `ask_user_question` 提问通知；修复浏览器原生通知固定 tag 导致连续审批/提问只显示首条。
- **v1.1.3** — README 结构规范化：默认 `README.md` 为中文，英文文档移至 `README-en.md`。
- **v1.1.2** — README 拆分为默认英文 + 中文，补充 `npx` 安装方式与「更新」章节。
- **v1.1.1** — 修复设置页黑夜模式样式，统一使用 `--dsw-alias-*` 设计变量。
- **v1.1.0** — 新增浏览器系统原生通知、Windows 系统通知与提示音。
- **v1.0.0** — 首个 GitHub 版本：浏览器横幅、系统通知、飞书/钉钉/企业微信/通用 Webhook 与设置页。

## 已知限制

- macOS/Windows 的系统通知开关无法通过 Web API 读取；桌面端不再显示可能失真的“已授权”状态，改为提示与「打开系统通知设置」按钮。
- 桌面通知点击会尝试 `window.focus()` 并打开会话；如果桌面窗口已被隐藏到系统托盘，Electron 未向插件暴露“恢复窗口”接口，可能无法自动拉回窗口。
- Windows 的 Electron 通知依赖应用 AUMID；若系统通知中心不显示，请改用宿主系统通知渠道。
- 浏览器原生通知需要浏览器授权，且页面/宿主必须保持运行；完全退出桌面或浏览器时请使用宿主系统通知/Webhook。
- 宿主系统通知与桌面通知同时开启可能产生重复提醒；设置页会提示。
- 飞书/钉钉签名密钥只做只写 + 读回脱敏，未加密存储在本地 `config.json`。

## License

[MIT](LICENSE)
