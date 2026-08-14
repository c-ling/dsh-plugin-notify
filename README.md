# dsh-plugin-notify

DeepSeek Harness Web GUI 的消息提醒插件：任务回合执行结束、或执行到需要用户确认时，按配置向所选渠道发送提醒，并在设置面板提供「消息提醒」菜单页。

[![dsh-plugin topic](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## 渠道

| 渠道 | 位置 | 说明 |
| --- | --- | --- |
| 浏览器通知（页面内横幅） | 客户端 | 页面可见时在右上角弹出文字横幅，不依赖系统通知权限；离开页面时请配合系统通知使用 |
| 系统通知 | 宿主机 | macOS `osascript` / Linux `notify-send`，浏览器关闭也能收到；可选 macOS 系统提示音（`afplay`） |
| 飞书群机器人 | 宿主机 | 文本消息，可选签名密钥（timestamp + HMAC-SHA256），可选自定义消息模板 |
| 钉钉群机器人 | 宿主机 | 文本消息，可选加签（timestamp + sign），可选自定义消息模板 |
| 企业微信群机器人 | 宿主机 | 文本消息，可选自定义消息模板 |
| 通用 Webhook | 宿主机 | 自定义 URL + headers + JSON/文本模板，占位符 `{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}`，可对接 Slack / Discord / ntfy / Bark / Server酱 / PushPlus 等 |

## 消息格式

所有 Webhook 渠道共用同一套占位符：`{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}`。

- 飞书/钉钉/企业微信默认使用统一格式（标题 + 详情 + 会话 + 本地时间），在设置页的「消息模板」留空即用默认；填写后按你的模板渲染。
- 通用 Webhook 的模板留空时发送纯文本消息正文。

## 触发

- `turn/end`：回合结束，按 `triggers.turnEndKinds` 过滤（completed/blocked/aborted/error，默认 completed+blocked）。
- `approval/asked`：工具调用等待用户审批（宿主机渠道）。
- 浏览器渠道额外覆盖等待用户确认的交互（审批/提问，来自会话快照的 pending 列表）。

宿主机的系统/Webhook 渠道覆盖所有会话；浏览器渠道跟随当前打开的会话。

## 安装

从 GitHub 安装到 web profile（需要 `pnpm` 在 `PATH` 上；没有则用下面的 corepack 方式）：

```sh
dsh plugin --profile web add "github:c-ling/dsh-plugin-notify#v1.0.0"
```

pnpm 不在 `PATH` 上时：

```sh
cd ~/.dsh/profiles/web
corepack pnpm add "github:c-ling/dsh-plugin-notify#v1.0.0"
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

## 卸载

```sh
cd ~/.dsh/profiles/web
corepack pnpm remove dsh-plugin-notify   # 或 dsh plugin --profile web remove dsh-plugin-notify
```

同时删除 `cordis.patch.yml` 中对应的 insert 行，然后重启 `dsh web`。
配置数据保留在 `$DSH_HOME/storages/dsh-plugin-notify/config.json`，删除该目录即可彻底清除。

## 配置存储

配置保存在 `$DSH_HOME/storages/dsh-plugin-notify/config.json`（可通过插件行的 `config.directory` 覆盖）。Webhook 签名密钥为只写字段：接口读回空串并用 `secretSet` 标记是否已配置，写入时空串表示保持不变，`clearSecrets` 列出要清除的路径。Webhook 地址与通用请求头以明文保存，请勿在其中放置敏感凭据（除飞书/钉钉签名密钥外）。

## 开发

```sh
node --check lib/index.js lib/client.js
node --test
```

客户端为手写 factory-CJS bundle（`window.__ModuleLoader__.load({ id: "dsh-plugin-notify", factory })`），无构建步骤；UI 通过 `settings.section` 与 `shell.overlay` 插槽注册。宿主端为纯 Node 内置模块实现（无 `@deepseek-ai/*` 依赖），通过 `webServer` 服务注册三条路由并订阅 `session/event` 事件流。

接口：

- `GET  /dsh-plugin-notify/config` — 脱敏后的当前配置 + secretSet
- `POST /dsh-plugin-notify/config` — `{ config, clearSecrets? }` 整体替换用户可编辑配置
- `POST /dsh-plugin-notify/test` — `{ channel: "system" | "feishu" | "dingtalk" | "wecom" | "generic", genericId? }` 发送测试消息

## 已知限制

- 浏览器渠道是页面内文字横幅（不调用浏览器 Notification API），页面不可见时不会送达，需配合系统通知渠道使用。
- 飞书/钉钉签名密钥仅做「只写 + 读回脱敏」，保存在本地 `config.json` 中但未加密；请勿在通用 Webhook 的地址或请求头中放置其他敏感凭据。

## License

[MIT](LICENSE)
