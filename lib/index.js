/**
 * dsh-plugin-notify host half: notification dispatch + config persistence + routes.
 *
 * A plain Cordis plugin (out-of-tree plugin files resolve their own imports
 * from their real path, not the profile's node_modules, so the DSH settings
 * integration is imported lazily and stays optional — without the packages or
 * without a settings provider the plugin keeps working off the entry config
 * and the classic config.json exactly as before).
 *
 * Config storage (0.1.1 migration A): when `@deepseek-ai/dsh-settings` and a
 * settings provider are available the config lives in the harness settings
 * document (`$DSH_HOME/settings.yaml`, namespace `dsh-plugin-notify`) through
 * `installSettingsSection`; the legacy `$DSH_HOME/storages/dsh-plugin-notify/
 * config.json` (overridable through `config.directory`) seeds the composition
 * base once at startup so existing users keep their channels, and remains the
 * store whenever settings are unavailable. Feishu/DingTalk signing keys are
 * schema-declared `role('secret')` fields, so every wire surface (settings
 * describe, client mirror) sees them stripped with a set/unset sidecar; the
 * custom GET /config route keeps its own equivalent redacted view for the
 * settings page. Writes always flow through POST /config: only the host holds
 * the stored secrets, so it merges them back (write-only fields + clearSecrets)
 * before persisting — a browser holding a redacted view could not write nested
 * secrets without wiping them.
 *
 * It serves the redacted config and a per-channel test endpoint over the
 * harness `webServer` service, and listens to the `session/event` firehose for
 * three triggers:
 *
 *   - `turn/end`   — a task turn finished (reason kinds completed/blocked/
 *                    aborted/error, filterable through config).
 *   - `approval/asked` — execution is waiting for the user to confirm a tool
 *                    approval (payload carries toolName and reason).
 *   - `tool/call` with name `ask_user_question` — the model is asking the
 *                    user a question through the interactive question tool
 *                    (payload carries the raw tool arguments).
 *
 * Notifications are fire-and-forget: the session append hot path is never
 * blocked, every channel failure is contained and logged. Webhook channels
 * (Feishu/DingTalk/WeCom custom bots plus generic JSON templates) and the
 * system channel (macOS osascript / Linux notify-send / Windows PowerShell
 * toast, optional system sound: macOS afplay / Windows SoundPlayer)
 * run here; the browser channel is driven by the client half.
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

// Optional DSH 0.1.1 settings integration. Out-of-tree plugins cannot rely on
// profile node_modules being resolvable from the plugin path, so the import is
// attempted lazily; when the packages are absent the plugin falls back to the
// classic config.json storage (same pattern as dsh-plugin-pet).
let settingsApi = null;
let schemastery = null;
try {
  settingsApi = await import("@deepseek-ai/dsh-settings");
  const schemasteryModule = await import("@deepseek-ai/schemastery");
  schemastery = schemasteryModule.default ?? schemasteryModule;
} catch {
  settingsApi = null;
  schemastery = null;
}

export const name = "dsh-plugin-notify";
// "settings" must be DECLARED: in cordis, reading an undeclared service from a
// sibling plugin's fiber throws (`cannot get property "settings" without
// inject`), and the reflect `ctx.get` accessor only resolves names in the own
// isolate — so without the declaration the settings document is simply
// unreachable. Declaring it makes the fiber wait for the settings service
// before applying; every standard profile mounts one (theme/locale preferences
// are settings namespaces themselves — same tradeoff as dsh-plugin-pet). The
// runtime fallbacks below still cover the packages-missing and write-failure
// cases with the classic config.json store.
export const inject = ["webServer", "settings"];

// ── constants ──────────────────────────────────────────────────────────────

export const TURN_END_KINDS = Object.freeze(["completed", "blocked", "aborted", "error"]);

export const TURN_END_KIND_LABELS = Object.freeze({
  completed: "已完成",
  blocked: "目标阻塞",
  aborted: "已中止",
  error: "出错",
});

/** Tool name the harness uses when the model asks the user a question. */
export const ASK_USER_QUESTION_TOOL = "ask_user_question";

const CONFIG_FILE = "config.json";
const MAX_CONFIG_BYTES = 256 * 1024;
const WEBHOOK_TIMEOUT_MS = 10_000;
const TEXT_LIMIT = 200;
const MAX_GENERIC_ITEMS = 32;
const MAX_HEADERS = 32;
const STR_LIMIT = 4096;

/** Settings-document namespace for the harness settings service. */
export const SETTINGS_NS = "dsh-plugin-notify";

export const DEFAULT_CONFIG = Object.freeze({
  triggers: Object.freeze({
    turnEnd: true,
    turnEndKinds: Object.freeze(["completed", "blocked", "aborted"]),
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

/**
 * The settings-document schema for the notify config. A real structured schema
 * (not a `transform(any(), …)` pass-through) is required so the framework's
 * `redactSecrets` walker can find the `role('secret')` positions and strip the
 * Feishu/DingTalk signing keys from every wire surface. Secret fields declare
 * NO default (the official pattern): a missing key resolves to an absent field,
 * which is what makes the wire sidecar's `set` flag mean "actually configured".
 * Defaults mirror `normalizeConfig`'s fallbacks, so a resolved section has the
 * exact `normalizeConfig` shape modulo absent secrets.
 */
export function createSettingsSchema(z) {
  const secretChannel = (withSecret) => {
    const fields = {
      enabled: z.boolean().default(false),
      url: z.string().default(""),
    };
    if (withSecret) fields.secret = z.string().role("secret");
    fields.bodyTemplate = z.string().default("");
    return z.object(fields);
  };
  return z.object({
    triggers: z.object({
      turnEnd: z.boolean().default(true),
      turnEndKinds: z.array(z.string()).default(["completed", "blocked", "aborted"]),
      approval: z.boolean().default(true),
    }),
    browser: z.object({
      enabled: z.boolean().default(true),
      toast: z.boolean().default(true),
      native: z.boolean().default(false),
    }),
    system: z.object({
      enabled: z.boolean().default(false),
      sound: z.boolean().default(true),
    }),
    webhooks: z.object({
      feishu: secretChannel(true),
      dingtalk: secretChannel(true),
      wecom: secretChannel(false),
      generic: z.array(z.object({
        id: z.string().default(""),
        name: z.string().default(""),
        enabled: z.boolean().default(false),
        url: z.string().default(""),
        headers: z.dict(z.string()).default({}),
        bodyTemplate: z.string().default(""),
      })).default([]),
    }),
  });
}

// ── paths ──────────────────────────────────────────────────────────────────

/** Resolve the DSH home directory (same rule as @deepseek-ai/dsh-home-paths). */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/** Default notify state directory. */
export function notifyDir() {
  return join(dshHome(), "storages", "dsh-plugin-notify");
}

// ── config normalization ───────────────────────────────────────────────────

function bool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function str(value) {
  return typeof value === "string" ? value.slice(0, STR_LIMIT) : "";
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
  const id = str(entry?.id).slice(0, 64) || `wh-${index + 1}`;
  return {
    id,
    name: str(entry?.name).slice(0, 64) || id,
    enabled: bool(entry?.enabled, false),
    url: str(entry?.url),
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
      feishu: { enabled: bool(feishu.enabled, false), url: str(feishu.url), secret: str(feishu.secret), bodyTemplate: str(feishu.bodyTemplate) },
      dingtalk: { enabled: bool(dingtalk.enabled, false), url: str(dingtalk.url), secret: str(dingtalk.secret), bodyTemplate: str(dingtalk.bodyTemplate) },
      wecom: { enabled: bool(wecom.enabled, false), url: str(wecom.url), bodyTemplate: str(wecom.bodyTemplate) },
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

/**
 * Persist view for the settings document: drop signing-key fields holding "".
 * `normalizeConfig` always materializes `secret: ""`, but in the settings
 * document an empty string would read as a configured key — absence is what
 * makes the framework's `set` sidecar (and the YAML document) mean "not
 * configured". Only the settings layer sees this view; dispatch and the legacy
 * config.json store keep the fully materialized shape.
 */
export function stripEmptySecrets(config) {
  const next = JSON.parse(JSON.stringify(config));
  for (const path of SECRET_PATHS) {
    let node = next;
    for (const key of path.slice(0, -1)) {
      node = node !== null && typeof node === "object" ? node[key] : undefined;
    }
    if (node !== null && typeof node === "object") {
      const leaf = path[path.length - 1];
      if (node[leaf] === "") delete node[leaf];
    }
  }
  return next;
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

// ── message building ───────────────────────────────────────────────────────

function truncate(value, limit = TEXT_LIMIT) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Read the latest title from the session log (leaf scalars only). */
export function sessionTitle(session) {
  const events = session?.events;
  const titleEvent = typeof events?.findLast === "function"
    ? events.findLast((event) => event?.type === "session/title")
    : undefined;
  return typeof titleEvent?.data?.title === "string" && titleEvent.data.title !== "" ? titleEvent.data.title : undefined;
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
export function buildTurnEndMessage(session, event) {
  const data = event?.data;
  const kind = typeof data?.reason?.kind === "string" ? data.reason.kind : "completed";
  const errorMessage = kind === "error" && typeof data?.reason?.error?.message === "string" ? data.reason.error.message : "";
  const title = sessionTitle(session);
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
export function buildApprovalMessage(session, event) {
  const data = event?.data;
  const toolName = typeof data?.toolName === "string" ? data.toolName : "工具调用";
  const reason = truncate(typeof data?.reason === "string" ? data.reason : "");
  const title = sessionTitle(session);
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
export function buildQuestionMessage(session, event) {
  const data = event?.data;
  const question = truncate(firstQuestionText(data));
  const title = sessionTitle(session);
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

/** Render a generic webhook body template with message placeholders. */
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
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (key in vars ? vars[key] : match));
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
    execFile(file, args, (error) => (error ? reject(error) : resolve()));
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
 */
export function handleSessionEvent(cfg, session, event, impls, logger) {
  let message;
  if (event?.type === "turn/end") {
    const kind = event?.data?.reason?.kind;
    if (!cfg.triggers.turnEnd || typeof kind !== "string" || !cfg.triggers.turnEndKinds.includes(kind)) return;
    message = buildTurnEndMessage(session, event);
  } else if (event?.type === "approval/asked") {
    if (!cfg.triggers.approval) return;
    message = buildApprovalMessage(session, event);
  } else if (event?.type === "tool/call" && event?.data?.name === ASK_USER_QUESTION_TOOL) {
    if (!cfg.triggers.approval) return;
    message = buildQuestionMessage(session, event);
  } else {
    return;
  }
  runJobs(planJobs(cfg, message, impls), logger);
}

// ── the plugin ─────────────────────────────────────────────────────────────

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, data);
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

export function apply(ctx, config = {}) {
  const directory = typeof config.directory === "string" ? config.directory : notifyDir();
  const configPath = join(directory, CONFIG_FILE);
  const mutex = createMutex();

  const sendJson = (res, status, payload) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify(payload));
  };

  const handleError = (res, error) => {
    const status = error?.statusCode ?? 500;
    const message = status === 500 ? "internal error" : String(error?.message ?? error);
    if (status === 500) ctx.logger?.warn?.(`dsh-plugin-notify: request failed: ${String(error?.stack ?? error)}`);
    sendJson(res, status, { ok: false, error: message });
  };

  // ── settings integration (0.1.1 migration A) ──────────────────────────────
  // The entry config is the composition base; a legacy config.json seeds it
  // once at startup (synchronously, before the namespace registers, so the
  // seed can never clobber a settings-backed value) so existing users keep
  // their channels. While a settings provider is mounted, the registered
  // namespace's user layer overrides the base and persists into the harness
  // settings document ($DSH_HOME/settings.yaml); without one, config.json
  // stays the store.
  let current = normalizeConfig(config);
  let currentSource = () => current;
  const NS = settingsApi !== null && typeof settingsApi.settingsNamespace === "function"
    ? settingsApi.settingsNamespace(SETTINGS_NS)
    : SETTINGS_NS;

  try {
    if (existsSync(configPath)) {
      current = normalizeConfig(JSON.parse(readFileSync(configPath, "utf8")));
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-plugin-notify: ignoring unreadable config at ${configPath}: ${String(error?.message ?? error)}`);
  }

  if (settingsApi !== null && schemastery !== null && typeof ctx.inject === "function") {
    const SCHEMA = createSettingsSchema(schemastery);
    try {
      // The base layer is the stripped view too: a seeded config.json always
      // carries `secret: ""`, and an empty string must not read as configured.
      settingsApi.installSettingsSection(ctx, NS, SCHEMA, stripEmptySecrets(current), {
        setSource: (next) => {
          currentSource = next;
          current = normalizeConfig(next());
        },
        onChange: () => {
          current = normalizeConfig(currentSource());
        },
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-plugin-notify: settings integration unavailable: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * Whether the settings document currently backs this namespace. Reads the
   * service through `ctx.get` — cordis's no-inject-requirement accessor —
   * because a bare `ctx.settings` property access THROWS when the service is
   * not in this plugin's declared inject list, which would turn every save
   * into a 500 instead of the intended config.json fallback.
   */
  const canUseSettings = () => {
    if (settingsApi === null) return false;
    const settings = typeof ctx.get === "function" ? ctx.get("settings") : undefined;
    return typeof settings?.replace === "function"
      && typeof settings?.get === "function"
      && settings.get(NS) !== undefined;
  };

  /** Persist config: settings document when available, else legacy config.json. */
  async function writeConfig(next) {
    const normalized = normalizeConfig(next);
    if (canUseSettings()) {
      try {
        await ctx.get("settings").replace(NS, stripEmptySecrets(normalized));
        current = normalized;
        return normalized;
      } catch (error) {
        ctx.logger?.warn?.(`dsh-plugin-notify: settings write failed, falling back to config.json: ${String(error?.message ?? error)}`);
      }
    }
    await mkdir(directory, { recursive: true });
    await writeAtomic(configPath, JSON.stringify(normalized, null, 2));
    current = normalized;
    return normalized;
  }

  /** Consume a request body with a hard size cap. */
  async function readBody(req, maxBytes) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error("body too large");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  const handlers = {
    // GET /dsh-plugin-notify/config — redacted current config + secretSet.
    async getConfig(req, res) {
      sendJson(res, 200, { ok: true, ...redactConfig(current) });
    },
    // POST /dsh-plugin-notify/config — replace the user-editable config; secret fields
    // keep stored values on "" and clear only listed paths.
    async postConfig(req, res) {
      try {
        const body = JSON.parse((await readBody(req, MAX_CONFIG_BYTES)).toString("utf8"));
        const merged = mergeSecrets(current, body?.config, body?.clearSecrets);
        const normalized = await mutex(() => writeConfig(merged));
        sendJson(res, 200, { ok: true, ...redactConfig(normalized) });
      } catch (error) {
        handleError(res, error);
      }
    },
    // POST /dsh-plugin-notify/test — send one test message through one channel.
    async postTest(req, res) {
      try {
        const body = JSON.parse((await readBody(req, MAX_CONFIG_BYTES)).toString("utf8"));
        const message = {
          kind: "test",
          title: "DSH · 通知测试",
          body: "这是一条来自 DeepSeek Harness 的测试消息，渠道工作正常。",
          sessionId: "",
          turn: 0,
          reason: "",
          toolName: "",
          time: localTime(),
        };
        const channel = typeof body.channel === "string" ? body.channel : "";
        const impls = {
          system: (systemCfg) => systemNotify(message.title, message.body),
          feishu: (cfg) => sendFeishu(cfg, renderChannelText(cfg, message)),
          dingtalk: (cfg) => sendDingTalk(cfg, renderChannelText(cfg, message)),
          wecom: (cfg) => sendWecom(cfg, renderChannelText(cfg, message)),
          generic: (cfg) => sendGeneric(cfg, message),
        };
        if (channel === "system") {
          if (!current.system.enabled) throw Object.assign(new Error("系统通知未启用"), { statusCode: 400 });
          await impls.system(current.system);
          // Test sound follows the explicit request, else the saved toggle; fire
          // it in the background so the success response is not delayed by the
          // ~1.5s audio playback (and never plays twice: impls.system above does
          // not play sound — that is the real notification path's job).
          const wantSound = typeof body.sound === "boolean" ? body.sound : current.system.sound;
          if (wantSound) playSystemSound().catch(() => {});
        } else if (channel === "feishu") {
          const testCfg = mergeTestConfig(current.webhooks.feishu, body.config);
          if (!testCfg.enabled || testCfg.url === "") throw Object.assign(new Error("飞书 webhook 未配置"), { statusCode: 400 });
          await impls.feishu(testCfg);
        } else if (channel === "dingtalk") {
          const testCfg = mergeTestConfig(current.webhooks.dingtalk, body.config);
          if (!testCfg.enabled || testCfg.url === "") throw Object.assign(new Error("钉钉 webhook 未配置"), { statusCode: 400 });
          await impls.dingtalk(testCfg);
        } else if (channel === "wecom") {
          const testCfg = mergeTestConfig(current.webhooks.wecom, body.config);
          if (!testCfg.enabled || testCfg.url === "") throw Object.assign(new Error("企业微信 webhook 未配置"), { statusCode: 400 });
          await impls.wecom(testCfg);
        } else if (channel === "generic") {
          const saved = current.webhooks.generic.find((entry) => entry.id === body.genericId);
          const testCfg = mergeTestConfig(saved ?? {}, body.config);
          if (saved === undefined || !testCfg.enabled || testCfg.url === "") throw Object.assign(new Error("通用 webhook 未配置"), { statusCode: 400 });
          await impls.generic(testCfg);
        } else {
          throw Object.assign(new Error("未知渠道（浏览器渠道请在设置页直接测试）"), { statusCode: 400 });
        }
        sendJson(res, 200, { ok: true, note: "测试消息已发送" });
      } catch (error) {
        handleError(res, error);
      }
    },
  };

  // One route per path, dispatching on method (webServer rejects duplicates).
  const routes = [
    { method: "GET", path: "/dsh-plugin-notify/config", handler: handlers.getConfig },
    { method: "POST", path: "/dsh-plugin-notify/config", handler: handlers.postConfig },
    { method: "POST", path: "/dsh-plugin-notify/test", handler: handlers.postTest },
  ];
  const byPath = new Map();
  for (const route of routes) {
    let entry = byPath.get(route.path);
    if (entry === undefined) {
      entry = { methods: new Map(), allowed: [] };
      byPath.set(route.path, entry);
    }
    entry.methods.set(route.method, route.handler);
    entry.allowed.push(route.method);
  }

  // `webServer` is a declared dependency: the fiber waits for the service
  // before applying, so the routes below are always registered. This is the
  // same contract dsh-plugin-pet relies on — applying without the inject can run
  // before the web server mounts and silently skip route registration.
  const webServer = ctx.webServer;
  for (const [path, entry] of byPath) {
    ctx.effect(() => webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        const handler = entry.methods.get(req.method);
        if (handler === undefined) {
          sendJson(res, 405, { ok: false, error: `method ${req.method ?? "?"} not allowed; use ${entry.allowed.join("/")}` });
          return;
        }
        await handler(req, res);
      },
    }), `dsh-plugin-notify: route ${path}`);
  }

  // The session/event firehose: every appended event, synchronously, with
  // per-listener containment upstream. This listener never blocks and never
  // throws: it reads leaf scalars, plans jobs, and fires them in background.
  ctx.on("session/event", (session, event) => {
    try {
      handleSessionEvent(current, session, event, {
        system: (systemCfg, message) => systemNotify(message.title, message.body).then(() => {
          if (systemCfg.sound) return playSystemSound().catch(() => {});
        }),
        feishu: (cfg, text) => sendFeishu(cfg, text),
        dingtalk: (cfg, text) => sendDingTalk(cfg, text),
        wecom: (cfg, text) => sendWecom(cfg, text),
        generic: (cfg, message) => sendGeneric(cfg, message),
      }, ctx.logger);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-plugin-notify: session/event listener failed: ${String(error?.message ?? error)}`);
    }
  });
}
