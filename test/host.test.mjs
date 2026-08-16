import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

import {
  DEFAULT_CONFIG,
  TURN_END_KINDS,
  normalizeConfig,
  redactConfig,
  mergeSecrets,
  mergeTestConfig,
  feishuSign,
  dingtalkSign,
  renderTemplate,
  renderChannelText,
  DEFAULT_MESSAGE_TEMPLATE,
  buildTurnEndMessage,
  buildApprovalMessage,
  buildQuestionMessage,
  ASK_USER_QUESTION_TOOL,
  sendFeishu,
  sendDingTalk,
  sendWecom,
  sendGeneric,
  planJobs,
  handleSessionEvent,
  systemNotify,
  playSystemSound,
  apply,
} from "../lib/index.js";

// ── system channel ─────────────────────────────────────────────────────────

test("systemNotify uses osascript on darwin and rejects on unknown platforms", async () => {
  const calls = [];
  await systemNotify("标题", "正文", async (file, args) => { calls.push({ file, args }); }, () => "darwin");
  assert.equal(calls[0].file, "osascript");
  assert.match(calls[0].args.join(" "), /display notification/);
  await assert.rejects(() => systemNotify("t", "b", async () => {}, () => "freebsd"), /不支持系统通知/);
});

test("systemNotify builds a PowerShell WinRT toast on win32 with escaped text", async () => {
  const calls = [];
  await systemNotify('任务 "完成" $now', "正文 `x 与 $5", async (file, args) => { calls.push({ file, args }); }, () => "win32");
  assert.equal(calls[0].file, "powershell.exe");
  const script = calls[0].args.join(" ");
  assert.match(script, /ToastNotificationManager/);
  assert.match(script, /CreateToastNotifier/);
  assert.match(script, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.ok(script.includes('`"完成`"'), "double quotes backtick-escaped");
  assert.ok(script.includes("`$now"), "dollar sign backtick-escaped");
  assert.ok(script.includes("``x"), "backtick doubled");
  assert.ok(script.includes("`$5"));
});

test("playSystemSound plays afplay on darwin and a wav via SoundPlayer on win32", async () => {
  const darwinCalls = [];
  await playSystemSound(async (file, args) => { darwinCalls.push({ file, args }); }, () => "darwin");
  assert.equal(darwinCalls[0].file, "afplay");
  const winCalls = [];
  await playSystemSound(async (file, args) => { winCalls.push({ file, args }); }, () => "win32");
  assert.equal(winCalls[0].file, "powershell.exe");
  assert.match(winCalls[0].args.join(" "), /SoundPlayer/);
  await assert.rejects(() => playSystemSound(async () => {}, () => "linux"), /仅 macOS \/ Windows/);
});

// ── signatures ─────────────────────────────────────────────────────────────

test("feishuSign matches raw HMAC-SHA256 base64", () => {
  const secret = "test-secret";
  const ts = "1700000000";
  assert.equal(feishuSign(secret, ts), createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64"));
});

test("dingtalkSign url-encodes base64 HMAC", () => {
  const secret = "SECabc";
  const ts = "1700000000123";
  const raw = createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64");
  assert.equal(dingtalkSign(secret, ts), encodeURIComponent(raw));
  assert.ok(!dingtalkSign(secret, ts).includes("="));
});

// ── templates ──────────────────────────────────────────────────────────────

test("renderTemplate replaces placeholders and keeps unknown ones", () => {
  const message = {
    title: "T", body: "B", kind: "turnEnd", sessionId: "s1", turn: 7,
    toolName: "", reason: "", time: "2025-01-01T00:00:00.000Z",
  };
  assert.equal(renderTemplate('{"text":"{{title}} #{{turn}}"}', message), '{"text":"T #7"}');
  assert.equal(renderTemplate("{{unknown}}", message), "{{unknown}}");
  assert.equal(renderTemplate("", message), "B");
  assert.equal(renderTemplate("   ", message), "B");
});

test("renderChannelText uses the unified default template", () => {
  const message = { title: "T", body: "B", sessionId: "s1", turn: 7, time: "2025-01-01 00:00:00", kind: "turnEnd" };
  assert.equal(renderChannelText({}, message), DEFAULT_MESSAGE_TEMPLATE.replace("{{title}}", "T").replace("{{body}}", "B").replace("{{sessionId}}", "s1").replace("{{time}}", "2025-01-01 00:00:00"));
  assert.match(renderChannelText({}, message), /会话：s1/);
});

test("renderChannelText prefers the channel bodyTemplate", () => {
  const message = { title: "T", body: "B", sessionId: "s1", turn: 7, time: "t", kind: "turnEnd" };
  assert.equal(renderChannelText({ bodyTemplate: "{{kind}}/{{title}}" }, message), "turnEnd/T");
});

test("normalizeConfig keeps per-channel bodyTemplate", () => {
  const cfg = normalizeConfig({ webhooks: { wecom: { bodyTemplate: "{{title}}!" } } });
  assert.equal(cfg.webhooks.feishu.bodyTemplate, "");
  assert.equal(cfg.webhooks.wecom.bodyTemplate, "{{title}}!");
});

// ── config normalization ───────────────────────────────────────────────────

test("normalizeConfig merges defaults for empty input", () => {
  const cfg = normalizeConfig(null);
  assert.deepEqual(cfg.triggers.turnEndKinds, ["completed", "blocked", "aborted"]);
  assert.equal(cfg.triggers.turnEnd, true);
  assert.equal(cfg.browser.toast, true);
  assert.equal(cfg.browser.native, false);
  assert.equal("sound" in cfg.browser, false);
  assert.equal("onlyWhenHidden" in cfg.browser, false);
  assert.deepEqual(cfg.webhooks.generic, []);
});

test("normalizeConfig keeps the browser.native flag and rejects non-booleans", () => {
  assert.equal(normalizeConfig({ browser: { native: true } }).browser.native, true);
  assert.equal(normalizeConfig({ browser: { native: "yes" } }).browser.native, false);
  assert.equal(normalizeConfig({ browser: { native: false } }).browser.native, false);
});

test("normalizeConfig sanitizes bad values and dedupes kinds", () => {
  const cfg = normalizeConfig({
    triggers: { turnEnd: "yes", turnEndKinds: ["completed", "completed", "nonsense"] },
    webhooks: { generic: [{ id: "", enabled: 1, url: 42, headers: { A: 1, B: "v" } }, ...Array.from({ length: 40 }, () => ({}))] },
  });
  assert.equal(cfg.triggers.turnEnd, true); // fallback
  assert.deepEqual(cfg.triggers.turnEndKinds, ["completed"]);
  assert.equal(cfg.webhooks.generic.length, 32);
  assert.equal(cfg.webhooks.generic[0].id, "wh-1");
  assert.deepEqual(cfg.webhooks.generic[0].headers, { B: "v" });
});

test("redactConfig blanks secrets and reports secretSet", () => {
  const cfg = normalizeConfig({ webhooks: { feishu: { secret: "s1" }, dingtalk: {} } });
  const view = redactConfig(cfg);
  assert.equal(view.config.webhooks.feishu.secret, "");
  assert.equal(view.secretSet["webhooks.feishu.secret"], true);
  assert.equal(view.secretSet["webhooks.dingtalk.secret"], false);
});

test("mergeSecrets keeps on empty, replaces on value, honors clearSecrets", () => {
  const stored = normalizeConfig({ webhooks: { feishu: { secret: "old" }, dingtalk: { secret: "old2" } } });
  const merged = mergeSecrets(
    stored,
    { webhooks: { feishu: { secret: "" }, dingtalk: { secret: "new" } } },
    ["webhooks.feishu.secret"],
  );
  assert.equal(merged.webhooks.feishu.secret, "");
  assert.equal(merged.webhooks.dingtalk.secret, "new");
});

test("mergeTestConfig overlays draft over saved and preserves stored secrets", () => {
  const saved = { enabled: true, url: "https://x", secret: "stored", bodyTemplate: "" };
  const merged = mergeTestConfig(saved, { bodyTemplate: "T" });
  assert.equal(merged.bodyTemplate, "T");
  assert.equal(merged.url, "https://x");
  assert.equal(merged.secret, "stored");
  assert.equal(mergeTestConfig(saved, { secret: "new" }).secret, "new");
  assert.equal(mergeTestConfig(saved, null).url, "https://x");
  const genericSaved = { id: "g", headers: { A: "1" } };
  assert.deepEqual(mergeTestConfig(genericSaved, { headers: { B: "2" } }).headers, { A: "1", B: "2" });
});

// ── message building ───────────────────────────────────────────────────────

function fakeSession({ id = "session-12345678", title } = {}) {
  const events = [];
  if (title !== undefined) events.push({ type: "session/title", data: { title } });
  return { id, events };
}

test("buildTurnEndMessage uses session title and kind labels", () => {
  const message = buildTurnEndMessage(fakeSession({ title: "写周报" }), {
    type: "turn/end",
    data: { turn: 3, reason: { kind: "completed" } },
  });
  assert.equal(message.kind, "turnEnd");
  assert.equal(message.turnEndKind, "completed");
  assert.match(message.body, /「写周报」回合 #3/);
});

test("buildTurnEndMessage falls back to short id and truncates error text", () => {
  const message = buildTurnEndMessage(fakeSession(), {
    type: "turn/end",
    data: { turn: 1, reason: { kind: "error", error: { message: "x".repeat(500) } } },
  });
  assert.match(message.body, /12345678/);
  assert.ok(message.reason.length <= 201);
});

test("buildApprovalMessage carries toolName and truncated reason", () => {
  const message = buildApprovalMessage(fakeSession({ title: "迁移" }), {
    type: "approval/asked",
    data: { id: "a1", toolName: "bash", reason: "sandbox escalation" },
  });
  assert.equal(message.kind, "approval");
  assert.match(message.body, /「迁移」需要确认：bash/);
  assert.match(message.body, /sandbox escalation/);
});

test("buildQuestionMessage parses ask_user_question arguments", () => {
  const message = buildQuestionMessage(fakeSession({ title: "写周报" }), {
    type: "tool/call",
    data: {
      turn: 4,
      name: "ask_user_question",
      arguments: JSON.stringify({
        questions: [{ id: "q1", header: "选择方案", question: "A 还是 B？" }],
      }),
    },
  });
  assert.equal(message.kind, "question");
  assert.equal(message.title, "DSH · 等待回答");
  assert.equal(message.toolName, ASK_USER_QUESTION_TOOL);
  assert.equal(message.turn, 4);
  assert.match(message.body, /「写周报」等待你的回答：选择方案：A 还是 B？/);
  assert.equal(message.reason, "选择方案：A 还是 B？");
});

test("buildQuestionMessage falls back for unparsable arguments", () => {
  const message = buildQuestionMessage(fakeSession(), {
    type: "tool/call",
    data: { name: "ask_user_question", arguments: "not-json" },
  });
  assert.equal(message.kind, "question");
  assert.match(message.body, /等待你的回答：ask_user_question/);
  assert.equal(message.reason, "");
});

// ── webhook senders ────────────────────────────────────────────────────────

function stubFetch(respond) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return respond({ url, opts }, calls.length - 1);
  };
  impl.calls = calls;
  return impl;
}

test("sendFeishu posts signed text payload and checks code", async () => {
  const fetchImpl = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) }));
  await sendFeishu({ url: "https://feishu/hook", secret: "s" }, "hello", fetchImpl);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, "https://feishu/hook");
  const body = JSON.parse(opts.body);
  assert.equal(body.msg_type, "text");
  assert.equal(body.content.text, "hello");
  assert.ok(body.timestamp);
  assert.ok(body.sign);
  assert.ok(opts.signal);
});

test("sendFeishu rejects on non-zero code", async () => {
  const fetchImpl = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ code: 19001, msg: "bad token" }) }));
  await assert.rejects(() => sendFeishu({ url: "https://feishu/hook" }, "x", fetchImpl), /bad token/);
});

test("sendDingTalk appends sign query and checks errcode", async () => {
  const fetchImpl = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ errcode: 0 }) }));
  await sendDingTalk({ url: "https://dingtalk/robot?access_token=t", secret: "s" }, "hello", fetchImpl);
  const url = fetchImpl.calls[0].url;
  assert.match(url, /timestamp=\d+&sign=[A-Za-z0-9%_-]+/);
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(body.msgtype, "text");
});

test("sendWecom posts text payload", async () => {
  const fetchImpl = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ errcode: 0 }) }));
  await sendWecom({ url: "https://wecom/hook" }, "hi", fetchImpl);
  const body = JSON.parse(fetchImpl.calls[0].opts.body);
  assert.equal(body.text.content, "hi");
});

test("sendGeneric picks JSON content type for object templates, plain for text", async () => {
  const jsonFetch = stubFetch(async () => ({ ok: true, status: 200 }));
  const message = { title: "T", body: "B", kind: "test", sessionId: "", turn: 0, time: "" };
  await sendGeneric({ url: "https://x", bodyTemplate: '{"text":"{{title}}"}', headers: { "x-custom": "1" } }, message, jsonFetch);
  assert.equal(jsonFetch.calls[0].opts.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(jsonFetch.calls[0].opts.headers["x-custom"], "1");

  const textFetch = stubFetch(async () => ({ ok: true, status: 200 }));
  await sendGeneric({ url: "https://x" }, message, textFetch);
  assert.equal(textFetch.calls[0].opts.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(textFetch.calls[0].opts.body, "B");
});

// ── dispatch planning ──────────────────────────────────────────────────────

test("planJobs selects only enabled configured channels", () => {
  const cfg = normalizeConfig({
    system: { enabled: true },
    webhooks: {
      feishu: { enabled: true, url: "https://f" },
      dingtalk: { enabled: true },
      wecom: { enabled: false, url: "https://w" },
      generic: [{ id: "g1", enabled: true, url: "https://g" }, { id: "g2", enabled: false, url: "https://g2" }],
    },
  });
  const jobs = planJobs(cfg, { title: "T", body: "B" }, {
    system: () => {},
    feishu: () => {},
    dingtalk: () => {},
    wecom: () => {},
    generic: () => {},
  });
  assert.deepEqual(jobs.map((job) => job.label), ["system", "feishu", "generic:g1"]);
});

test("handleSessionEvent filters kinds and dispatches fire-and-forget", async () => {
  const sent = [];
  const cfg = normalizeConfig({ triggers: { turnEndKinds: ["completed", "error"] }, webhooks: { wecom: { enabled: true, url: "https://w" } } });
  const impls = { wecom: (hookCfg, text) => { sent.push(text); return Promise.resolve(); } };
  const logger = { warn() { throw new Error("should not warn"); } };

  handleSessionEvent(cfg, fakeSession({ title: "T" }), { type: "turn/end", data: { turn: 1, reason: { kind: "blocked" } } }, impls, logger);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 0); // blocked filtered out

  handleSessionEvent(cfg, fakeSession({ title: "T" }), { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } }, impls, logger);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /任务结束/);

  handleSessionEvent(cfg, fakeSession(), { type: "approval/asked", data: { toolName: "bash" } }, impls, logger);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 2);
  assert.match(sent[1], /等待确认/);
});

test("handleSessionEvent notifies on ask_user_question tool calls", async () => {
  const sent = [];
  const cfg = normalizeConfig({ webhooks: { wecom: { enabled: true, url: "https://w" } } });
  const impls = { wecom: (hookCfg, text) => { sent.push(text); return Promise.resolve(); } };
  handleSessionEvent(cfg, fakeSession({ title: "T" }), {
    type: "tool/call",
    data: { turn: 2, name: "ask_user_question", arguments: JSON.stringify({ questions: [{ question: "继续吗？" }] }) },
  }, impls, {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /等待回答/);
  assert.match(sent[0], /继续吗？/);
});

test("handleSessionEvent ignores unknown events and disabled triggers", () => {
  const sent = [];
  const cfg = normalizeConfig({ triggers: { approval: false } });
  handleSessionEvent(cfg, fakeSession(), { type: "approval/asked", data: { toolName: "bash" } }, { wecom: () => sent.push(1) }, {});
  handleSessionEvent(cfg, fakeSession(), { type: "tool/call", data: { name: "ask_user_question", arguments: "{}" } }, { wecom: () => sent.push(1) }, {});
  handleSessionEvent(cfg, fakeSession(), { type: "tool/call", data: { name: "bash", arguments: "{}" } }, { wecom: () => sent.push(1) }, {});
  handleSessionEvent(cfg, fakeSession(), { type: "assistant/chunk", data: {} }, { wecom: () => sent.push(1) }, {});
  assert.equal(sent.length, 0);
});

// ── apply + routes ─────────────────────────────────────────────────────────

function stubCtx(directory) {
  const routes = new Map();
  const listeners = new Map();
  const ctx = {
    logger: { warn() {} },
    get(name) {
      if (name === "webServer") return ctx.webServer;
      return undefined;
    },
    webServer: {
      register(entry) { routes.set(entry.path, entry.handler); },
    },
    effect(fn) { fn(); },
    on(name, fn) { listeners.set(name, fn); },
    routes,
    listeners,
  };
  return ctx;
}

async function call(handler, method, bodyObject) {
  const req = {
    method,
    [Symbol.asyncIterator]: async function* () {
      if (bodyObject !== undefined) yield Buffer.from(JSON.stringify(bodyObject));
    },
  };
  let status;
  const chunks = [];
  const res = {
    writeHead(code) { status = code; },
    end(buf) { chunks.push(typeof buf === "string" ? Buffer.from(buf) : buf); },
  };
  await handler(req, res);
  return { status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
}

test("routes serve config, persist writes, and enforce method dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-"));
  const ctx = stubCtx(directory);
  apply(ctx, { directory });

  const getConfig = ctx.routes.get("/dsh-plugin-notify/config");
  const getTest = ctx.routes.get("/dsh-plugin-notify/test");
  assert.ok(getConfig);
  assert.ok(getTest);

  const initial = await call(getConfig, "GET");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.ok, true);
  assert.equal(initial.body.config.triggers.turnEnd, true);
  assert.equal(initial.body.config.webhooks.feishu.secret, "");

  const saved = await call(getConfig, "POST", {
    config: { triggers: { turnEnd: false }, webhooks: { feishu: { enabled: true, url: "https://f", secret: "top" } } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.triggers.turnEnd, false);
  assert.equal(saved.body.secretSet["webhooks.feishu.secret"], true);
  assert.equal(saved.body.config.webhooks.feishu.secret, "");

  // secret persists on disk, still redacted on read, kept on empty write
  const onDisk = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.equal(onDisk.webhooks.feishu.secret, "top");

  const kept = await call(getConfig, "POST", { config: { webhooks: { feishu: { secret: "" } } } });
  assert.equal(kept.body.secretSet["webhooks.feishu.secret"], true);

  const cleared = await call(getConfig, "POST", { config: { webhooks: { feishu: { secret: "" } } }, clearSecrets: ["webhooks.feishu.secret"] });
  assert.equal(cleared.body.secretSet["webhooks.feishu.secret"], false);

  // method dispatch: GET on test route → 405; unknown channel → 400
  const methodCheck = await call(getTest, "GET");
  assert.equal(methodCheck.status, 405);

  const badChannel = await call(getTest, "POST", { channel: "carrier-pigeon" });
  assert.equal(badChannel.status, 400);
});

test("postTest sends with the draft bodyTemplate without saving", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-"));
  const ctx = stubCtx(directory);
  apply(ctx, { directory });
  const configHandler = ctx.routes.get("/dsh-plugin-notify/config");
  const testHandler = ctx.routes.get("/dsh-plugin-notify/test");

  const saved = await call(configHandler, "POST", {
    config: { webhooks: { wecom: { enabled: true, url: "https://wecom/hook", bodyTemplate: "" } } },
  });
  assert.equal(saved.status, 200);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ errcode: 0 }) };
  };
  try {
    const res = await call(testHandler, "POST", { channel: "wecom", config: { bodyTemplate: "{{kind}}/{{title}}" } });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].opts.body).text.content, "test/DSH · 通知测试");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session/event listener is registered", () => {
  const ctx = stubCtx();
  apply(ctx, { directory: "/nonexistent" });
  assert.equal(typeof ctx.listeners.get("session/event"), "function");
});

test("TURN_END_KINDS and defaults are frozen constants", () => {
  assert.deepEqual(TURN_END_KINDS, ["completed", "blocked", "aborted", "error"]);
  assert.equal(DEFAULT_CONFIG.triggers.turnEnd, true);
});
