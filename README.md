# dsh-plugin-notify

DeepSeek Harness Web GUI 的消息提醒插件：任务回合执行结束、或执行到需要用户确认时，按配置向所选渠道发送提醒，并在设置面板提供「消息提醒」菜单页。

[English](README-en.md)

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 渠道

| 渠道 | 位置 | 说明 |
| --- | --- | --- |
| 浏览器通知（页面内横幅）＋ 系统原生通知（可选） | 客户端 | 两个独立设置项：「浏览器通知」在页面可见时于右上角弹出文字横幅；「系统原生通知」通过浏览器 Notification API 弹出操作系统通知，标签页在后台/最小化时也能收到（需浏览器通知权限）；完全离开页面时请配合系统通知使用 |
| 系统通知 | 宿主机 | macOS `osascript` / Linux `notify-send` / Windows PowerShell 原生 toast（Windows 10/11 操作中心），浏览器关闭也能收到；可选系统提示音（macOS `afplay` / Windows 系统内置提示音）；可用 [`system.notifier`](#自定义通知器systemnotifier) 换成任意通知器命令 |
| 飞书群机器人 | 宿主机 | 文本消息，可选签名密钥（timestamp + HMAC-SHA256），可选自定义消息模板 |
| 钉钉群机器人 | 宿主机 | 文本消息，可选加签（timestamp + sign），可选自定义消息模板 |
| 企业微信群机器人 | 宿主机 | 文本消息，可选自定义消息模板 |
| 通用 Webhook | 宿主机 | 自定义 URL + headers + JSON/文本模板，占位符 `{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}`，可对接 Slack / Discord / ntfy / Bark / Server酱 / PushPlus 等 |

## 自定义通知器（`system.notifier`）

宿主机通道默认调用操作系统自带的通知命令。但在某些环境里这会**静默失效**——最典型的是 macOS：`osascript display notification` 的通知身份取自启动链上的宿主 App，如果那个 App 从未申请过通知权限，系统会把通知丢掉，而 `osascript` 仍然以 `0` 退出，所以插件无从察觉。

`system.notifier` 是逃生舱：填了 `command` 就改用它，`args` 里可用 `{{title}}` / `{{body}}` 占位符（与 Webhook 模板同一套写法；未识别的 token 原样保留）。

**插件不对通知器做任何假设，也没有默认参数模板**——`command` 指向什么就执行什么，`args` 就是它的完整 argv。参数是工具专属的，所以必须照你所选工具的用法写：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-plugin-notify
  config:
    system:
      # terminal-notifier（brew install terminal-notifier）
      notifier:
        command: /opt/homebrew/bin/terminal-notifier
        args: ["-title", "{{title}}", "-message", "{{body}}"]
```

下面两个是同一个 `notifier:` 块的替换内容：

```yaml
# alerter（无参数则永久等待，记得给 --timeout）
notifier:
  command: /Users/you/.local/bin/alerter
  args: ["--title", "{{title}}", "--message", "{{body}}", "--timeout", "30"]
```

```yaml
# 自编译的 app bundle（UNUserNotificationCenter + 自己的 bundle id 与图标）
notifier:
  command: /Users/you/Applications/DSH Notifier.app/Contents/MacOS/notifier
  args: ["-title", "{{title}}", "-message", "{{body}}"]
```

⚠️ `command` **必须是绝对路径**：插件用 `execFile` 直接执行，不经过 shell，所以 `~` 不会被展开（写 `~/.local/bin/alerter` 只会得到 `ENOENT`）。`$HOME` 之类的环境变量同理。

选型上的两点提醒：

- **`terminal-notifier` 3.0.0 起移除了 `-sender`**，因为它改用了 `UserNotifications`，而该框架读取真实签名身份、不允许覆盖。所以它会以自己的名义出现在「系统设置 → 通知」里，首次使用需要授权一次。
- **`alerter` 仍走旧的 `NSUserNotification`，因此仍支持 `--sender` 冒充一个已授权的 bundle id**。在宿主终端从未申请过通知权限、又不想新增授权的环境里，这是能立刻出通知的办法；代价是通知显示的是被冒充 App 的名字与图标。不介意多授权一次的话，自编译 app bundle 是更干净的选择。

`command` 留空即维持原有的系统默认行为（也是默认值），因此不配置时行为完全不变；`args: []` 表示"不带参数执行"，是合法配置。

相比系统默认命令，**正经的通知器带有真实退出码**（terminal-notifier 用 `3` 表示未授权、`4` 表示拿不到通知服务），发送失败会真正冒泡到插件日志里的告警，而不是静默报成功。

## 消息格式

所有 Webhook 渠道共用同一套占位符：`{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}`。

- 飞书/钉钉/企业微信默认使用统一格式（标题 + 详情 + 会话 + 本地时间），在设置页的「消息模板」留空即用默认；填写后按你的模板渲染。
- 通用 Webhook 的模板留空时发送纯文本消息正文。

## 触发

- `turn/end`：回合结束，按 `triggers.turnEndKinds` 过滤（completed/blocked/aborted/error，默认 completed+blocked）。
- `approval/asked`：工具调用等待用户审批（宿主机渠道）。
- `tool/call`（`name` 为 `ask_user_question`）：模型通过提问工具向用户提问，等待用户回答（宿主机渠道）。
- 浏览器渠道额外覆盖等待用户确认的交互（审批/提问，来自会话快照的 pending 列表）。

宿主机的系统/Webhook 渠道覆盖所有会话；浏览器渠道跟随当前打开的会话。

## 安装

从 GitHub 安装到 web profile（需要 `pnpm` 在 `PATH` 上；没有则用下面的 corepack 方式）：

```sh
npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.3.0"
```

或使用已有的 `dsh` 命令：

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.3.0"
```

pnpm 不在 `PATH` 上时：

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-notify#v1.3.0"
```

> `dsh plugin` 把参数原样转发给 pnpm，直接从本仓库拉取包（pnpm 9+，本机需装有 `git`）。
> 安装时若看到 `declares no dsh.bundle — installed as a plain dependency` 的提示属正常现象：
> 本插件不是 profile bundle 层，而是通过下面的 loader 行激活。

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 增加一行插入：

```yaml
- insert:
    - id: notify
      name: 'dsh-plugin-notify'
```

重启 `dsh web`（client-modules 按进程缓存包裁决，新包必须重启宿主），然后硬刷新页面。
设置页位于「设置 → 消息提醒」。

## 验证

```sh
curl -s http://127.0.0.1:3080/plugins/dsh-plugin-notify/client.js | head -c 60
```

应输出 `window.__ModuleLoader__.load({` 开头的 factory bundle；设置页「设置 → 消息提醒」可配置并逐渠道发送测试消息。

## 更新

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.3.0"
# 或：npx @deepseek-ai/dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.3.0"
# 或：cd ~/.dsh/profiles/web && corepack pnpm add "github:c-ling/dsh-plugin-notify#v1.3.0"
```

用新的 `#v1.3.0` 重新执行安装命令即可升级依赖；`cordis.patch.yml` 中的 loader 行保持不变。
重启 `dsh web`，然后硬刷新页面。

## 卸载

```sh
cd ~/.dsh/profiles/web
corepack pnpm remove dsh-plugin-notify   # 或 dsh plugin --profile web remove dsh-plugin-notify
```

同时删除 `cordis.patch.yml` 中对应的 insert 行，然后重启 `dsh web`。
配置数据保存在 Harness 设置文档 `$DSH_HOME/settings.yaml` 的 `dsh-plugin-notify:` 段（回退存储在 `$DSH_HOME/storages/dsh-plugin-notify/`），删除该段与目录即可彻底清除。

## 配置存储

自 v1.3.0 起配置优先存入 Harness 官方设置服务：挂载了 settings provider 的环境里，配置写入 `$DSH_HOME/settings.yaml` 的 `dsh-plugin-notify:` 命名空间（宿主端经 `installSettingsSection` 注册，浏览器端通过 `settingsScope` 镜像响应式读取）；没有 settings provider 时自动回退到经典存储 `$DSH_HOME/storages/dsh-plugin-notify/config.json`（可通过插件行的 `config.directory` 覆盖）。升级后首次启动会把既有 config.json 作为 base 一次性迁移，无需手动操作。

飞书/钉钉签名密钥按 schema 声明为 `role('secret')` 只写字段：设置文档与所有 wire 面都看不到明文，只暴露「是否已配置」标记；接口读回空串并用 `secretSet` 标记，写入时空串表示保持不变，`clearSecrets` 列出要清除的路径。Webhook 地址与通用请求头以明文保存，请勿在其中放置敏感凭据（除飞书/钉钉签名密钥外）。

### 接口访问控制

三条 `/dsh-plugin-notify/*` 路由都带一道**信任栅栏**，守护的是浏览器对本地 HTTP API 打开的两条「混淆代理」路径：

- **DNS rebinding** —— `Host` 指向攻击者域名，而连接实际落到本机；
- **跨站请求** —— 恶意页面直接向本地 API 发起的写入。

这条 API 是**写入面**（`system.notifier.command` 会被执行），所以两条路径都必须堵死。栅栏同时约束浏览器与非浏览器客户端：纯 HTTP 下浏览器可能既不发送 `Origin` 也不发送 Fetch 元数据，因此 `Host` 是唯一始终可靠的依据。

默认只信任回环地址（`localhost` / `::1` / `127.x.x.x`）。通过局域网、隧道或反向代理对外提供访问时，把对外的 authority（精确的 `host:port`）加进 `security.trustedHosts`：

```yaml
- id: dsh-plugin-notify
  config:
    security:
      trustedHosts: ["dsh.example:3443"]
```

不配时行为等同只信任回环。DSH 自身对 `/api` 桥有同一套设计（`dsh-client-connection` 的 `isTrustedApiRequest`），但**通过 `webServer.register` 注册的插件路由不会继承它**，所以插件需要自带。

**转发时重写 Host / Origin 的网关不需要任何配置。** 例如 `dsh-mobile` 在 LAN 侧完成认证后，会以**上游身份**转发请求：

```js
headers.host = upstream.host;                                // 127.0.0.1:3080
headers.origin = upstream.origin;                            // http://127.0.0.1:3080
headers["sec-fetch-site"] = "same-origin";
```

于是插件收到的是一个干净的环回同源请求，栅栏直接放行。只有**原样透传外部 Host** 的反向代理（nginx / Caddy 的默认行为，或裸隧道）才需要把对外 authority 加进 `security.trustedHosts`。

## 开发

```sh
node --check lib/index.js lib/client.js
node --test
```

客户端为手写 factory-CJS bundle（`window.__ModuleLoader__.load({ id: "dsh-plugin-notify", factory })`），无构建步骤；UI 通过 `settings.section` 与 `shell.overlay` 插槽注册。宿主端对 `@deepseek-ai/dsh-settings` / `@deepseek-ai/schemastery` 做惰性可选导入（包不可解析或无 settings provider 时自动回退 config.json），通过 `webServer` 服务注册三条路由并订阅 `session/event` 事件流。

接口：

- `GET  /dsh-plugin-notify/config` — 脱敏后的当前配置 + secretSet
- `POST /dsh-plugin-notify/config` — `{ config, clearSecrets? }` 整体替换用户可编辑配置
- `POST /dsh-plugin-notify/test` — `{ channel: "system" | "feishu" | "dingtalk" | "wecom" | "generic", genericId? }` 发送测试消息

## 更新日志

- **v1.3.0** — 适配 DeepSeek Harness 0.1.1（迁移 A）：配置优先存入官方设置文档 `$DSH_HOME/settings.yaml`（`installSettingsSection` + `settingsScope` 响应式读取），旧 `config.json` 自动作为 base 迁移、无 settings provider 时仍回退经典存储；飞书/钉钉签名密钥改为 schema `role('secret')` 只写字段，设置文档与 wire 面均不可见明文；浏览器端外部配置变更（其他标签页/手改 YAML）现在实时生效，无需刷新。
- **v1.2.0** — 宿主机渠道支持 `ask_user_question` 提问通知：模型调用 `ask_user_question` 时，系统通知与飞书/钉钉/企业微信/通用 Webhook 会发送「等待回答」提醒；修复浏览器原生通知因固定 tag 导致连续审批/提问只显示首条的问题。
- **v1.1.3** — README 结构规范化：默认 `README.md` 改为中文，英文文档移至 `README-en.md`（删除 `README-ZH.md`），安装命令统一固定到 `#v1.1.3`。
- **v1.1.2** — README 拆分为默认英文 `README.md` + 中文 `README-ZH.md`（顶部互相切换），补充 `npx @deepseek-ai/dsh plugin ...` 安装方式与「更新」章节，安装命令统一固定到 `#v1.1.2`。
- **v1.1.1** — 修复「设置 → 消息提醒」页在黑夜模式下的样式：保存按钮、开关、卡片/输入框边框、状态文字等统一改用 `--dsw-alias-*` 设计变量，跟随明暗主题。
- **v1.1.0** — 新增浏览器系统原生通知、Windows 系统通知与提示音，浏览器与原生通知拆分为独立设置项。
- **v1.0.0** — 首个 GitHub 版本：浏览器横幅、系统通知、飞书/钉钉/企业微信/通用 Webhook 渠道与设置页。

## 已知限制

- 浏览器渠道默认是页面内文字横幅；开启「系统原生通知」后，标签页在后台或窗口最小化时也会通过浏览器 Notification API 弹出系统通知（需要浏览器通知权限，且浏览器必须保持运行）。浏览器完全关闭时请使用宿主机系统通知渠道。
- 宿主机系统通知依赖运行 `dsh web` 的进程在操作系统里的通知身份。macOS 上这个身份取自启动链上的宿主 App（终端 / 启动器）：如果它从未申请过通知权限（例如 Ghostty 的 `app-notifications` 默认是 `never`），或者 `dsh web` 由 launchd 启动而没有 GUI 会话，`osascript` 会被系统静默丢弃且仍以 `0` 退出。遇到这种情况请用上面的 [`system.notifier`](#自定义通知器systemnotifier) 指向一个自带身份的通知器。
- 飞书/钉钉签名密钥仅做「只写 + 读回脱敏」，保存在本地 `settings.yaml`（或回退 `config.json`）中但未加密；请勿在通用 Webhook 的地址或请求头中放置其他敏感凭据。

## License

[MIT](LICENSE)
