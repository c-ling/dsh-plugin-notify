/**
 * dsh-plugin-notify host half: notification dispatch + config persistence + routes.
 *
 * Target: DeepSeek Harness 0.2.1+ (Web and Desktop). The plugin is a plain
 * Cordis plugin on the host and a factory-CJS bundle on the client.
 *
 * Config storage: `$DSH_HOME/storages/dsh-plugin-notify/config.json`
 * (overridable through `config.directory`). The loader entry config is the
 * composition base; with DSH 0.2.x the one-time `settings.yaml` import can
 * also land in that entry config, so legacy users are seeded without a
 * settings-service dependency. Every write is atomic and serialized in-process.
 *
 * Routes are registered on `ctx.connection.fetch`, the authenticated exact
 * Fetch registry, under `/api/dsh-plugin-notify/...`. The old raw
 * `webServer` routes were not protected by the Connection Host/Origin fence
 * after DSH 0.1.2 and exposed the config anonymously; they are intentionally
 * gone.
 *
 * Triggers on the `session/event` firehose:
 *
 *   - `turn/end` — completed / blocked / aborted / error / max-tokens /
 *     interrupted, filterable through config.
 *   - `approval/asked` — execution is waiting for a tool approval.
 *   - `tool/call` with name `ask_user_question` — the model is asking a
 *     question through the interactive question tool.
 *
 * Every matched message is also remembered in a bounded in-memory journal.
 * Browser/desktop clients use `GET /last` to recover the exact turn-end kind
 * for a running → idle transition, while host channels (system + webhooks)
 * are dispatched fire-and-forget here.
 *
 * Config model, merged over DEFAULT_CONFIG:
 *   {
 *     triggers: { turnEnd, turnEndKinds: [], approval },
 *     browser:  { enabled, toast, native },
 *     system:   { enabled, sound },
 *     webhooks: {
 *       feishu:   { enabled, url, secret, bodyTemplate },
 *       dingtalk: { enabled, url, secret, bodyTemplate },
 *       wecom:    { enabled, url, bodyTemplate },
 *       generic:  [{ id, name, enabled, url, headers, bodyTemplate }]
 *     }
 *   }
 *
 * Wire format: `secret` signing keys are write-only — GET returns them as ""
 * and a `secretSet` sidecar; POST accepts a new non-empty value, keeps the
 * stored value on "", and clears only paths listed in `clearSecrets`.
 */

import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const name = "dsh-plugin-notify";

// The authenticated exact-Fetch registry is provided by dsh-client-connection
// (the Web/Desktop composition always mounts it). Declaring it makes the fiber
// wait for Connection before registering routes. `sessionTitle` is optional and
// read through ctx.get, so profiles without it still work.
export const inject = ["connection"];

// ── constants ──────────────────────────────────────────────────────────────

export const TURN_END_KINDS = Object.freeze([
  "completed",
  "blocked",
  "aborted",
  "error",
  "max-tokens",
  "interrupted",
]);

export const TURN_END_KIND_LABELS = Object.freeze({
  completed: "已完成",
  blocked: "目标阻塞",
  aborted: "已中止",
  error: "出错",
  "max-tokens": "输出达到上限",
  interrupted: "已中断",
});

/** Tool name the harness uses when the model asks the user a question. */
export const ASK_USER_QUESTION_TOOL = "ask_user_question";

const CONFIG_FILE = "config.json";
const MAX_CONFIG_BYTES = 256 * 1024;
const WEBHOOK_TIMEOUT_MS = 10_000;
const EXEC_TIMEOUT_MS = 10_000;
const TEXT_LIMIT = 200;
const MAX_GENERIC_ITEMS = 32;
const MAX_HEADERS = 32;
const STR_LIMIT = 4096;
const JOURNAL_LIMIT = 32;

export const DEFAULT_CONFIG = Object.freeze({
  triggers: Object.freeze({
    turnEnd: true,
    turnEndKinds: Object.freeze(["completed", "blocked", "aborted", "error", "max-tokens"]),
    approval: true,
  }),
  browser: Object.freeze({ enabled: true, toast: true, native: false }),
  system: Object.freeze({ enabled: false, sound: true }),
  webhooks: Object.freeze({
    feishu: Object.freeze({ enabled: false, url: "", secret: "", bodyTemplate: "" }),
    dingtalk: Object.freeze({ enabled: false, url: "", secret: "", bodyTemplate: "" }),
    wecom: Object.freeze({ enabled: false, url: "", bodyTemplate: "" }),
    generic: Object.freeze([]),
  }),
});

// ── paths ──────────────────────────────────────────────────────────────────

/** Resolve the DSH home directory (same rule as @deepseek-ai/dsh-home-paths). */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** Default notify state directory. */
export function notifyDir() {
  return join(dshHome(), "storages", "dsh-plugin-notify");
}

/**
 * Whether this host process runs inside the Electron desktop shell. Used only
 * for UI hints; the renderer can detect `html[data-platform]` on its own.
 */
export function isDesktopHost() {
  return process.env.ELECTRON_RUN_AS_NODE === "1"
    || typeof process.versions?.electron === "string"
    || typeof process.env.DSH_CLIENT_VERSION === "string";
}

// ── config normalization ───────────────────────────────────────────────────

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function str(value) {
  return typeof value === "string" ? value.slice(0, STR_LIMIT) : "";
}

function urlStr(value) {
  return str(value).trim();
}

function cleanKinds(value) {
  if (!Array.isArray(value)) return [...DEFAULT_CONFIG.triggers.turnEndKinds];
  const out = [];
  for (const entry of value) {
    if (typeof entry === "string" && TURN_END_KINDS.includes(entry) && !out.includes(entry)) out.push(entry);
  }
  return out.length > 0 ? out : [...DEFAULT_CONFIG.triggers.turnEndKinds];
}

function cleanHeaders(value) {
  const out = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= MAX_HEADERS) break;
    if (typeof entry !== "string") continue;
    out[key.slice(0, 128)] = entry.slice(0, STR_LIMIT);
    count += 1;
  }
  return out;
}

function cleanGenericItem(entry, index) {
  const id = str(entry?.id).trim().slice(0, 64) || `wh-${index + 1}`;
  return {
    id,
    name: str(entry?.name).slice(0, 64) || id,
    enabled: bool(entry?.enabled, false),
    url: urlStr(entry?.url),
    headers: cleanHeaders(entry?.headers),
    bodyTemplate: str(entry?.bodyTemplate),
  };
}

/** Merge an arbitrary stored/input value over the defaults and sanitize it. */
export function normalizeConfig(value) {
  const source = typeof value === "object" && value !== null ? value : {};
  const triggers = typeof source.triggers === "object" && source.triggers !== null ? source.triggers : {};
  const browser = typeof source.browser === "object" && source.browser !== null ? source.browser : {};
  const system = typeof source.system === "object" && source.system !== null ? source.system : {};
  const webhooks = typeof source.webhooks === "object" && source.webhooks !== null ? source.webhooks : {};
  const feishu = typeof webhooks.feishu === "object" && webhooks.feishu !== null ? webhooks.feishu : {};
  const dingtalk = typeof webhooks.dingtalk === "object" && webhooks.dingtalk !== null ? webhooks.dingtalk : {};
  const wecom = typeof webhooks.wecom === "object" && webhooks.wecom !== null ? webhooks.wecom : {};
  const generic = Array.isArray(webhooks.generic) ? webhooks.generic : [];
  return {
    triggers: {
      turnEnd: bool(triggers.turnEnd, DEFAULT_CONFIG.triggers.turnEnd),
      turnEndKinds: cleanKinds(triggers.turnEndKinds),
      approval: bool(triggers.approval, DEFAULT_CONFIG.triggers.approval),
    },
    browser: {
      enabled: bool(browser.enabled, DEFAULT_CONFIG.browser.enabled),
      toast: bool(browser.toast, DEFAULT_CONFIG.browser.toast),
      native: bool(browser.native, DEFAULT_CONFIG.browser.native),
    },
    system: {
      enabled: bool(system.enabled, DEFAULT_CONFIG.system.enabled),
      sound: bool(system.sound, DEFAULT_CONFIG.system.sound),
    },
    webhooks: {
      feishu: { enabled: bool(feishu.enabled, false), url: urlStr(feishu.url), secret: str(feishu.secret), bodyTemplate: str(feishu.bodyTemplate) },
      dingtalk: { enabled: bool(dingtalk.enabled, false), url: urlStr(dingtalk.url), secret: str(dingtalk.secret), bodyTemplate: str(dingtalk.bodyTemplate) },
      wecom: { enabled: bool(wecom.enabled, false), url: urlStr(wecom.url), bodyTemplate: str(wecom.bodyTemplate) },
      generic: generic.slice(0, MAX_GENERIC_ITEMS).map(cleanGenericItem),
    },
  };
}

const SECRET_PATHS = Object.freeze([
  ["webhooks", "feishu", "secret"],
  ["webhooks", "dingtalk", "secret"],
]);

function readPath(config, path) {
  let node = config;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/** Produce the wire view: secret fields blanked plus a `secretSet` sidecar. */
export function redactConfig(config) {
  const normalized = normalizeConfig(config);
  const value = JSON.parse(JSON.stringify(normalized));
  const secretSet = {};
  for (const path of SECRET_PATHS) {
    const node = path.slice(0, -1).reduce((acc, key) => acc[key], value);
    const leaf = path[path.length - 1];
    secretSet[path.join(".")] = node[leaf] !== "";
    node[leaf] = "";
  }
  return { config: value, secretSet };
}

/** Merge a wire write: keep stored secrets on "", replace on non-empty, clear listed paths. */
export function mergeSecrets(stored, incoming, clearSecrets) {
  const next = JSON.parse(JSON.stringify(incoming === null || typeof incoming !== "object" ? {} : incoming));
  const clears = new Set(Array.isArray(clearSecrets) ? clearSecrets.filter((entry) => typeof entry === "string") : []);
  for (const path of SECRET_PATHS) {
    const key = path.join(".");
    let node = next;
    for (let index = 0; index < path.length - 1; index += 1) {
      if (node[path[index]] === null || typeof node[path[index]] !== "object") node[path[index]] = {};
      node = node[path[index]];
    }
    const leaf = path[path.length - 1];
    const incomingValue = readPath(incoming, path);
    if (clears.has(key)) node[leaf] = "";
    else if (typeof incomingValue === "string" && incomingValue !== "") node[leaf] = incomingValue;
    else node[leaf] = readPath(stored, path) ?? "";
  }
  return next;
}

/** Merge a draft channel config over the saved one for a test send: secret
 * fields keep stored values on "", every other field follows the draft. */
export function mergeTestConfig(saved, draft) {
  if (draft === null || typeof draft !== "object") return saved;
  const next = { ...(saved ?? {}), ...draft };
  if (Object.hasOwn(next, "secret")) {
    next.secret = typeof draft.secret === "string" && draft.secret !== "" ? draft.secret : (saved?.secret ?? "");
  }
  if (draft.headers !== null && typeof draft.headers === "object" && saved?.headers !== null && typeof saved?.headers === "object") {
    next.headers = { ...saved.headers, ...draft.headers };
  }
  return next;
}

// ── URLs ───────────────────────────────────────────────────────────────────

/** Empty is allowed (channel unconfigured); otherwise only http(s). */
export function isValidHttpUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return true;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Return the first invalid webhook URL path, or undefined when all are valid. */
export function firstInvalidUrl(config) {
  const normalized = normalizeConfig(config);
  const entries = [
    ["webhooks.feishu.url", normalized.webhooks.feishu.url],
    ["webhooks.dingtalk.url", normalized.webhooks.dingtalk.url],
    ["webhooks.wecom.url", normalized.webhooks.wecom.url],
  ];
  for (const [path, value] of entries) if (!isValidHttpUrl(value)) return path;
  for (const item of normalized.webhooks.generic) {
    if (!isValidHttpUrl(item.url)) return `webhooks.generic.${item.id}.url`;
  }
  return undefined;
}

// ── message building ───────────────────────────────────────────────────────

function truncate(value, limit = TEXT_LIMIT) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Read the latest title from the official title service, then the log. */
export function sessionTitle(session, titleService) {
  try {
    const snapshot = typeof titleService?.get === "function" ? titleService.get(session) : undefined;
    const title = snapshot?.title;
    if (typeof title === "string" && title !== "") return title;
  } catch {
    // fall through to the log scan
  }
  try {
    const events = typeof session?.snapshotEvents === "function"
      ? session.snapshotEvents()
      : [];
    const titleEvent = typeof events?.findLast === "function"
      ? events.findLast((event) => event?.type === "session/title")
      : undefined;
    const title = titleEvent?.data?.title;
    if (typeof title === "string" && title !== "") return title;
  } catch {
    // no readable log
  }
  return undefined;
}

function shortId(sessionId) {
  const id = typeof sessionId === "string" ? sessionId : "?";
  const suffix = id.split("-").pop();
  return suffix !== undefined && suffix !== "" ? suffix.slice(0, 8) : id.slice(0, 8);
}

/** Local wall-clock timestamp for message bodies. */
function localTime() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** Build the owned message for a `turn/end` session event. */
export function buildTurnEndMessage(session, event, titleService) {
  const data = event?.data;
  const kind = typeof data?.reason?.kind === "string" ? data.reason.kind : "completed";
  const errorMessage = kind === "error" && typeof data?.reason?.error?.message === "string" ? data.reason.error.message : "";
  const title = sessionTitle(session, titleService);
  const body = title !== undefined
    ? `「${title}」回合 #${typeof data?.turn === "number" ? data.turn : "?"} ${TURN_END_KIND_LABELS[kind] ?? kind}`
    : `会话 ${shortId(session?.id)} 回合 #${typeof data?.turn === "number" ? data.turn : "?"} ${TURN_END_KIND_LABELS[kind] ?? kind}`;
  return {
    kind: "turnEnd",
    title: "DSH · 任务结束",
    body: errorMessage === "" ? body : `${body}\n${truncate(errorMessage)}`,
    turnEndKind: kind,
    sessionId: typeof session?.id === "string" ? session.id : "",
    turn: typeof data?.turn === "number" ? data.turn : 0,
    reason: truncate(errorMessage),
    time: localTime(),
  };
}

/** Build the owned message for an `approval/asked` session event. */
export function buildApprovalMessage(session, event, titleService) {
  const data = event?.data;
  const toolName = typeof data?.toolName === "string" ? data.toolName : "工具调用";
  const reason = truncate(typeof data?.displayReason === "string" && data.displayReason !== ""
    ? data.displayReason
    : typeof data?.reason === "string" ? data.reason : "");
  const title = sessionTitle(session, titleService);
  const body = title !== undefined
    ? `「${title}」需要确认：${toolName}${reason === "" ? "" : `\n${reason}`}`
    : `会话 ${shortId(session?.id)} 需要确认：${toolName}${reason === "" ? "" : `\n${reason}`}`;
  return {
    kind: "approval",
    title: "DSH · 等待确认",
    body,
    toolName,
    sessionId: typeof session?.id === "string" ? session.id : "",
    turn: 0,
    reason,
    time: localTime(),
  };
}

/** Parse raw tool-call arguments and return the first question text. */
export function firstQuestionText(data) {
  let args;
  try {
    args = typeof data?.arguments === "string" && data.arguments.trim() !== "" ? JSON.parse(data.arguments) : undefined;
  } catch {
    args = undefined;
  }
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const first = questions.find((entry) => entry && typeof entry === "object");
  if (first === undefined) return "";
  const header = typeof first.header === "string" ? first.header.replace(/\s+/g, " ").trim() : "";
  const question = typeof first.question === "string" ? first.question.replace(/\s+/g, " ").trim() : "";
  if (header !== "" && question !== "") return `${header}：${question}`;
  return header !== "" ? header : question;
}

/** Build the owned message for a `tool/call` of `ask_user_question`. */
export function buildQuestionMessage(session, event, titleService) {
  const data = event?.data;
  const question = truncate(firstQuestionText(data));
  const title = sessionTitle(session, titleService);
  const label = question === "" ? ASK_USER_QUESTION_TOOL : question;
  const body = title !== undefined
    ? `「${title}」等待你的回答：${label}`
    : `会话 ${shortId(session?.id)} 等待你的回答：${label}`;
  return {
    kind: "question",
    title: "DSH · 等待回答",
    body,
    toolName: ASK_USER_QUESTION_TOOL,
    sessionId: typeof session?.id === "string" ? session.id : "",
    turn: typeof data?.turn === "number" ? data.turn : 0,
    reason: question,
    time: localTime(),
  };
}

/** Unified default message template shared by every chat-webhook channel. */
export const DEFAULT_MESSAGE_TEMPLATE = "{{title}}\n{{body}}\n\n会话：{{sessionId}}\n时间：{{time}}";

/**
 * Render one chat-webhook channel's text: its own `bodyTemplate` when set,
 * else the unified default template.
 */
export function renderChannelText(cfg, message) {
  const template = typeof cfg?.bodyTemplate === "string" && cfg.bodyTemplate.trim() !== ""
    ? cfg.bodyTemplate
    : DEFAULT_MESSAGE_TEMPLATE;
  return renderTemplate(template, message);
}

// ── webhook signatures ─────────────────────────────────────────────────────

/** Feishu custom bot signature: base64(HMAC-SHA256(secret, ts + "\n" + secret)), ts in seconds. */
export function feishuSign(secret, timestampSeconds) {
  return createHmac("sha256", secret).update(`${timestampSeconds}\n${secret}`).digest("base64");
}

/** DingTalk custom bot signature: url-encoded base64(HMAC-SHA256(secret, tsMs + "\n" + secret)). */
export function dingtalkSign(secret, timestampMs) {
  return encodeURIComponent(createHmac("sha256", secret).update(`${timestampMs}\n${secret}`).digest("base64"));
}

async function postJson(fetchImpl, url, headers, payload) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

/** Feishu/Lark custom bot (msg_type text, optional timestamp+sign). */
export async function sendFeishu(cfg, text, fetchImpl = fetch) {
  const payload = { msg_type: "text", content: { text } };
  if (cfg?.secret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    payload.timestamp = timestamp;
    payload.sign = feishuSign(cfg.secret, timestamp);
  }
  const { res, data } = await postJson(fetchImpl, cfg.url, {}, payload);
  if (!res.ok || (data !== null && data.code !== 0)) {
    throw new Error(`飞书 webhook 失败：HTTP ${res.status}${data?.msg ? `（${data.msg}）` : ""}`);
  }
  return data;
}

/** DingTalk custom bot (msgtype text, optional timestamp+sign query). */
export async function sendDingTalk(cfg, text, fetchImpl = fetch) {
  let url = cfg.url;
  if (cfg?.secret) {
    const timestamp = String(Date.now());
    url += `${url.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${dingtalkSign(cfg.secret, timestamp)}`;
  }
  const { res, data } = await postJson(fetchImpl, url, {}, { msgtype: "text", text: { content: text } });
  if (!res.ok || (data !== null && data.errcode !== 0)) {
    throw new Error(`钉钉 webhook 失败：HTTP ${res.status}${data?.errmsg ? `（${data.errmsg}）` : ""}`);
  }
  return data;
}

/** WeCom (企业微信) group robot (msgtype text). */
export async function sendWecom(cfg, text, fetchImpl = fetch) {
  const { res, data } = await postJson(fetchImpl, cfg.url, {}, { msgtype: "text", text: { content: text } });
  if (!res.ok || (data !== null && data.errcode !== 0)) {
    throw new Error(`企业微信 webhook 失败：HTTP ${res.status}${data?.errmsg ? `（${data.errmsg}）` : ""}`);
  }
  return data;
}

/**
 * Render a generic webhook body template with message placeholders.
 *
 * `{{key}}` inserts the raw value. `{{json:key}}` inserts the value escaped for
 * a JSON string literal (without the surrounding quotes), so a template that is
 * itself JSON — a Bark `/push` payload, for example — can safely carry free text
 * such as a session title or an error message containing quotes and newlines.
 * The raw pass runs first, because `json:` never matches a bare `\w+` token.
 */
export function renderTemplate(template, message) {
  if (typeof template !== "string" || template.trim() === "") return message.body;
  const vars = {
    title: message.title,
    body: message.body,
    kind: message.kind,
    sessionId: message.sessionId,
    turn: String(message.turn ?? 0),
    toolName: message.toolName ?? "",
    reason: message.reason ?? "",
    time: message.time ?? "",
  };
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (key in vars ? vars[key] : match))
    .replace(/\{\{\s*json:(\w+)\s*\}\}/g, (match, key) => (key in vars ? JSON.stringify(String(vars[key])).slice(1, -1) : match));
}

/** Generic JSON/plain webhook: user URL, optional headers, optional template. */
export async function sendGeneric(cfg, message, fetchImpl = fetch) {
  const body = renderTemplate(cfg.bodyTemplate, message);
  const trimmed = body.trim();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const headers = { ...(cfg.headers ?? {}) };
  if (headers["content-type"] === undefined && headers["Content-Type"] === undefined) {
    headers["content-type"] = looksJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";
  }
  const res = await fetchImpl(cfg.url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`webhook ${cfg.name ?? cfg.id} 失败：HTTP ${res.status}`);
  return res;
}

// ── system channel ─────────────────────────────────────────────────────────

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** PowerShell double-quoted string literal: backtick-escape `, $ and ". */
function psString(value) {
  return `"${String(value).replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"')}"`;
}

function runExecFile(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS }, (error) => (error ? reject(error) : resolve()));
  });
}

/** Best-effort native toast: macOS osascript / Linux notify-send / Windows
 * PowerShell WinRT toast (Windows 10/11 Action Center, no install needed).
 * The last two params are injectable for tests. */
export function systemNotify(title, body, execImpl = runExecFile, platformImpl = platform) {
  const current = platformImpl();
  if (current === "darwin") {
    return execImpl("osascript", ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]);
  }
  if (current === "linux") {
    return execImpl("notify-send", [title, body]);
  }
  if (current === "win32") {
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      '$texts = $xml.GetElementsByTagName("text")',
      `$texts.Item(0).AppendChild($xml.CreateTextNode(${psString(title)})) | Out-Null`,
      `$texts.Item(1).AppendChild($xml.CreateTextNode(${psString(body)})) | Out-Null`,
      "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
      // PowerShell's own AUMID lets an unregistered host show Action Center toasts.
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show($toast)',
    ].join("; ");
    return execImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }
  return Promise.reject(new Error(`当前平台（${current}）不支持系统通知`));
}

/** System sound: macOS afplay / Windows built-in wav via SoundPlayer (no-op
 * failure elsewhere). The last two params are injectable for tests. */
export function playSystemSound(execImpl = runExecFile, platformImpl = platform) {
  const current = platformImpl();
  if (current === "darwin") {
    return execImpl("afplay", ["/System/Library/Sounds/Glass.aiff"]);
  }
  if (current === "win32") {
    const script = [
      '$wav = Join-Path $env:WINDIR "Media\\Alarm01.wav"',
      "if (Test-Path $wav) { (New-Object System.Media.SoundPlayer $wav).PlaySync() } else { [System.Media.SystemSounds]::Exclamation.Play() }",
    ].join("; ");
    return execImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  }
  return Promise.reject(new Error("仅 macOS / Windows 支持系统提示音"));
}

// ── dispatch planning (pure, testable) ─────────────────────────────────────

/**
 * Select the enabled channel jobs for one message. `impls` maps channels to
 * zero-arg thunks returning promises; the caller owns concurrency and errors.
 */
export function planJobs(cfg, message, impls) {
  const jobs = [];
  if (cfg.system?.enabled && impls.system) {
    jobs.push({ label: "system", run: () => impls.system(cfg.system, message) });
  }
  const feishu = cfg.webhooks?.feishu;
  if (feishu?.enabled && feishu.url !== "" && impls.feishu) {
    jobs.push({ label: "feishu", run: () => impls.feishu(feishu, renderChannelText(feishu, message)) });
  }
  const dingtalk = cfg.webhooks?.dingtalk;
  if (dingtalk?.enabled && dingtalk.url !== "" && impls.dingtalk) {
    jobs.push({ label: "dingtalk", run: () => impls.dingtalk(dingtalk, renderChannelText(dingtalk, message)) });
  }
  const wecom = cfg.webhooks?.wecom;
  if (wecom?.enabled && wecom.url !== "" && impls.wecom) {
    jobs.push({ label: "wecom", run: () => impls.wecom(wecom, renderChannelText(wecom, message)) });
  }
  for (const generic of cfg.webhooks?.generic ?? []) {
    if (generic.enabled && generic.url !== "" && impls.generic) {
      jobs.push({ label: `generic:${generic.id}`, run: () => impls.generic(generic, message) });
    }
  }
  return jobs;
}

function runJobs(jobs, logger) {
  for (const job of jobs) {
    Promise.resolve()
      .then(job.run)
      .then(undefined, (error) => {
        logger?.warn?.(`dsh-plugin-notify: ${job.label} 通知发送失败：${String(error?.message ?? error)}`);
      });
  }
}

/**
 * Translate one session event into an owned message and dispatch it. Pure of
 * the runtime: cfg is the current normalized config, impls the channel thunks.
 *
 * Returns `{ message, dispatched }` when the event is a recognized trigger.
 * `dispatched` is false for a turn-end kind excluded by `turnEndKinds`; the
 * message is still journaled so the browser channel can honor the same filter.
 */
export function handleSessionEvent(cfg, session, event, impls, logger, options = {}) {
  const titleService = options.titleService;
  let message;
  let dispatched = false;
  if (event?.type === "turn/end") {
    if (!cfg.triggers.turnEnd) return undefined;
    const kind = event?.data?.reason?.kind;
    if (typeof kind !== "string") return undefined;
    message = buildTurnEndMessage(session, event, titleService);
    dispatched = cfg.triggers.turnEndKinds.includes(kind);
    if (!dispatched) {
      options.remember?.(message, false);
      return { message, dispatched };
    }
  } else if (event?.type === "approval/asked") {
    if (!cfg.triggers.approval) return undefined;
    message = buildApprovalMessage(session, event, titleService);
    dispatched = true;
  } else if (event?.type === "tool/call" && event?.data?.name === ASK_USER_QUESTION_TOOL) {
    if (!cfg.triggers.approval) return undefined;
    message = buildQuestionMessage(session, event, titleService);
    dispatched = true;
  } else {
    return undefined;
  }
  options.remember?.(message, true);
  runJobs(planJobs(cfg, message, impls), logger);
  return { message, dispatched };
}

// ── the plugin ─────────────────────────────────────────────────────────────

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, file);
}

/** Serialize concurrent writes through one in-process chain. */
export function createMutex() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
}

function httpError(status, code, message) {
  const error = new Error(message ?? code);
  error.statusCode = status;
  error.code = code;
  return error;
}

function readJsonBody(request) {
  return (async () => {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_CONFIG_BYTES) {
      throw httpError(413, "body-too-large");
    }
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
      throw httpError(413, "body-too-large");
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw httpError(400, "invalid-json");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw httpError(400, "invalid-config");
    }
    return body;
  })();
}

export function apply(ctx, config = {}) {
  const directory = typeof config.directory === "string" ? config.directory : notifyDir();
  const configPath = join(directory, CONFIG_FILE);
  const mutex = createMutex();

  const sendJson = (status, payload) => new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

  const handleError = (error) => {
    const status = error?.statusCode ?? 500;
    const code = typeof error?.code === "string" ? error.code : (status === 500 ? "internal" : "request-failed");
    const message = status === 500 && typeof error?.code !== "string"
      ? "internal error"
      : String(error?.message ?? error);
    if (status === 500) ctx.logger?.warn?.(`dsh-plugin-notify: request failed: ${String(error?.stack ?? error)}`);
    const includeDetail = code === "channel-failed"
      || code === "system-unsupported"
      || code === "invalid-url"
      || code === "storage-failed"
      || code === "system-settings-failed";
    return sendJson(status, includeDetail
      ? { ok: false, code, error: message, detail: message }
      : { ok: false, code, error: message });
  };

  // Entry config is the composition base. DSH 0.2.x's one-time settings.yaml
  // import can also land here by entry id; config.json is the durable store and
  // wins when present.
  let current = normalizeConfig(config);
  let revision = 0;
  try {
    if (existsSync(configPath)) {
      current = normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-plugin-notify: ignoring unreadable config at ${configPath}: ${String(error?.message ?? error)}`);
  }

  const getTitleService = () => (typeof ctx.get === "function" ? ctx.get("sessionTitle") : undefined);
  const journal = [];
  let journalSeq = 0;
  // Identifies this in-memory journal so a client can tolerate a host-half
  // reload (HMR) resetting the sequence without skipping new notifications.
  const journalId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const remember = (message, dispatched) => {
    journal.push({ seq: (journalSeq += 1), message, dispatched });
    if (journal.length > JOURNAL_LIMIT) journal.shift();
  };

  const meta = () => ({ platform: platform(), desktop: isDesktopHost() });

  async function writeConfig(next) {
    const normalized = normalizeConfig(next);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeAtomic(configPath, JSON.stringify(normalized, null, 2));
    } catch (error) {
      throw httpError(500, "storage-failed", String(error?.message ?? error));
    }
    current = normalized;
    revision += 1;
    return normalized;
  }

  const impls = {
    system: (systemCfg, message) => systemNotify(message.title, message.body).then(() => {
      if (systemCfg.sound) return playSystemSound().catch(() => {});
    }),
    feishu: (cfg, text) => sendFeishu(cfg, text),
    dingtalk: (cfg, text) => sendDingtalk(cfg, text),
    wecom: (cfg, text) => sendWecom(cfg, text),
    generic: (cfg, message) => sendGeneric(cfg, message),
  };

  const emptyTestMessage = () => ({
    kind: "test",
    title: "DSH · 通知测试",
    body: "这是一条来自 DeepSeek Harness 的测试消息，渠道工作正常。",
    sessionId: "",
    turn: 0,
    reason: "",
    toolName: "",
    time: localTime(),
  });

  const configFetch = async (request) => {
    if (request.method === "GET") {
      return sendJson(200, { ok: true, ...redactConfig(current), revision, meta: meta() });
    }
    if (request.method !== "POST") {
      return sendJson(405, { ok: false, code: "method-not-allowed", error: `method ${request.method} not allowed` });
    }
    try {
      const body = await readJsonBody(request);
      if (body.config === null || typeof body.config !== "object" || Array.isArray(body.config)) {
        throw httpError(400, "invalid-config");
      }
      const expected = body.expectedRevision;
      if (Number.isInteger(expected) && expected !== revision) {
        return sendJson(409, { ok: false, code: "stale-config", error: "stale config", ...redactConfig(current), revision });
      }
      const merged = mergeSecrets(current, body.config, body.clearSecrets);
      const invalid = firstInvalidUrl(merged);
      if (invalid !== undefined) throw httpError(400, "invalid-url", invalid);
      const normalized = await mutex(() => writeConfig(merged));
      return sendJson(200, { ok: true, ...redactConfig(normalized), revision, meta: meta() });
    } catch (error) {
      return handleError(error);
    }
  };

  const testFetch = async (request) => {
    if (request.method !== "POST") {
      return sendJson(405, { ok: false, code: "method-not-allowed", error: `method ${request.method} not allowed` });
    }
    try {
      const body = await readJsonBody(request);
      const message = emptyTestMessage();
      const channel = typeof body.channel === "string" ? body.channel : "";
      const draft = body.config !== null && typeof body.config === "object" && !Array.isArray(body.config)
        ? body.config
        : undefined;

      if (channel === "system") {
        try {
          await systemNotify(message.title, message.body);
        } catch (error) {
          const detail = String(error?.message ?? error);
          if (/不支持系统通知/.test(detail)) throw httpError(400, "system-unsupported", detail);
          throw httpError(502, "channel-failed", detail);
        }
        const wantSound = typeof body.sound === "boolean" ? body.sound : current.system.sound;
        if (wantSound) playSystemSound().catch(() => {});
        return sendJson(200, { ok: true });
      }

      if (channel === "feishu" || channel === "dingtalk" || channel === "wecom") {
        const testCfg = mergeTestConfig(current.webhooks[channel], draft);
        if (typeof testCfg.url !== "string" || testCfg.url.trim() === "") {
          throw httpError(400, "channel-not-configured", channel);
        }
        if (!isValidHttpUrl(testCfg.url)) throw httpError(400, "invalid-url", `${channel}.url`);
        try {
          if (channel === "feishu") await sendFeishu(testCfg, renderChannelText(testCfg, message));
          else if (channel === "dingtalk") await sendDingtalk(testCfg, renderChannelText(testCfg, message));
          else await sendWecom(testCfg, renderChannelText(testCfg, message));
        } catch (error) {
          throw httpError(502, "channel-failed", String(error?.message ?? error));
        }
        return sendJson(200, { ok: true });
      }

      if (channel === "generic") {
        const saved = current.webhooks.generic.find((entry) => entry.id === body.genericId);
        const testCfg = mergeTestConfig(saved ?? {}, draft);
        if (typeof testCfg.url !== "string" || testCfg.url.trim() === "") {
          throw httpError(400, "channel-not-configured", "generic");
        }
        if (!isValidHttpUrl(testCfg.url)) throw httpError(400, "invalid-url", "generic.url");
        try {
          await sendGeneric(testCfg, message);
        } catch (error) {
          throw httpError(502, "channel-failed", String(error?.message ?? error));
        }
        return sendJson(200, { ok: true });
      }

      throw httpError(400, "unknown-channel", "unknown channel");
    } catch (error) {
      return handleError(error);
    }
  };

  const lastFetch = async (request) => {
    if (request.method !== "GET") {
      return sendJson(405, { ok: false, code: "method-not-allowed", error: `method ${request.method} not allowed` });
    }
    try {
      const url = new URL(request.url);
      const sessionId = url.searchParams.get("sessionId") ?? "";
      if (sessionId === "" || sessionId.length > 256) throw httpError(400, "invalid-config", "sessionId");
      const requested = (url.searchParams.get("kinds") ?? "turnEnd,approval,question")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
      const kinds = requested.length > 0 ? requested : ["turnEnd", "approval", "question"];
      for (let index = journal.length - 1; index >= 0; index -= 1) {
        const entry = journal[index];
        if (entry.message.sessionId !== sessionId) continue;
        if (!kinds.includes(entry.message.kind)) continue;
        return sendJson(200, { ok: true, journalId, seq: entry.seq, message: entry.message, dispatched: entry.dispatched });
      }
      return sendJson(200, { ok: true, journalId, seq: 0, message: null, dispatched: false });
    } catch (error) {
      return handleError(error);
    }
  };

  const systemSettingsFetch = async (request) => {
    if (request.method !== "POST") {
      return sendJson(405, { ok: false, code: "method-not-allowed", error: `method ${request.method} not allowed` });
    }
    try {
      const currentPlatform = platform();
      if (currentPlatform === "darwin") {
        await runExecFile("open", ["x-apple.systempreferences:com.apple.Notifications-Settings.extension"]).catch(() =>
          runExecFile("open", ["x-apple.systempreferences:com.apple.preference.notifications"]));
      } else if (currentPlatform === "win32") {
        await runExecFile("cmd", ["/c", "start", "", "ms-settings:notifications"]);
      } else {
        await runExecFile("gnome-control-center", ["notifications"]).catch(() =>
          runExecFile("systemsettings5", ["kcm_notifications"]));
      }
      return sendJson(200, { ok: true });
    } catch (error) {
      return handleError(httpError(500, "system-settings-failed", String(error?.message ?? error)));
    }
  };

  if (ctx.connection === undefined || typeof ctx.connection.fetch?.register !== "function") {
    ctx.logger?.warn?.("dsh-plugin-notify: connection.fetch is unavailable; routes were not registered");
    return;
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: "/api/dsh-plugin-notify/config",
    methods: ["GET", "POST"],
    requestBody: "buffered",
    fetch: configFetch,
  }), "dsh-plugin-notify: config route");

  ctx.effect(() => ctx.connection.fetch.register({
    path: "/api/dsh-plugin-notify/test",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: testFetch,
  }), "dsh-plugin-notify: test route");

  ctx.effect(() => ctx.connection.fetch.register({
    path: "/api/dsh-plugin-notify/last",
    methods: ["GET"],
    requestBody: "buffered",
    fetch: lastFetch,
  }), "dsh-plugin-notify: last route");

  ctx.effect(() => ctx.connection.fetch.register({
    path: "/api/dsh-plugin-notify/system-settings",
    methods: ["POST"],
    requestBody: "buffered",
    fetch: systemSettingsFetch,
  }), "dsh-plugin-notify: system settings route");

  // The session/event firehose: every appended event, synchronously, with
  // per-listener containment upstream. This listener never blocks and never
  // throws: it reads leaf scalars, journals the message, and fires jobs.
  ctx.on("session/event", (session, event) => {
    try {
      handleSessionEvent(current, session, event, impls, ctx.logger, { titleService: getTitleService(), remember });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-plugin-notify: session/event listener failed: ${String(error?.message ?? error)}`);
    }
  });
}
