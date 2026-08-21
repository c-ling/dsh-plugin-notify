// Settings-integration tests (0.1.1 migration A). These cover the structured
// schema/redaction contract and the settings-backed persistence path; the
// classic config.json fallback stays covered by host.test.mjs (whose stub ctx
// has no `inject`, so the integration never wires there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import z from "@deepseek-ai/schemastery";
import { redactSecrets } from "@deepseek-ai/dsh-settings";

import {
  SETTINGS_NS,
  createSettingsSchema,
  mergeTestConfig,
  normalizeConfig,
  stripEmptySecrets,
} from "../lib/index.js";

const SCHEMA = createSettingsSchema(z);

// ── schema & redaction ───────────────────────────────────────────────────────

test("createSettingsSchema passes a normalized config through unchanged", () => {
  const sample = normalizeConfig({
    triggers: { turnEndKinds: ["completed", "error"] },
    browser: { native: true },
    webhooks: {
      feishu: { enabled: true, url: "https://f", secret: "s1" },
      generic: [{ id: "g1", name: "n", enabled: true, url: "https://g", headers: { A: "1" }, bodyTemplate: "T" }],
    },
  });
  assert.deepEqual(SCHEMA(sample), sample);
});

test("createSettingsSchema fills defaults over a partial section", () => {
  const resolved = SCHEMA({ system: { enabled: true } });
  assert.equal(resolved.triggers.turnEnd, true);
  assert.deepEqual(resolved.triggers.turnEndKinds, ["completed", "blocked", "aborted"]);
  assert.equal(resolved.browser.native, false);
  assert.equal(resolved.system.sound, true);
  assert.equal(resolved.webhooks.feishu.enabled, false);
  // Secret fields declare no default: an unconfigured key stays ABSENT, which
  // is what makes the wire sidecar's `set` flag mean "actually configured".
  assert.equal(resolved.webhooks.feishu.secret, undefined);
  assert.deepEqual(resolved.webhooks.generic, []);
});

test("stripEmptySecrets drops only empty signing keys from a normalized config", () => {
  const cfg = normalizeConfig({
    webhooks: {
      feishu: { url: "https://f" },
      dingtalk: { secret: "kept" },
    },
  });
  const stripped = stripEmptySecrets(cfg);
  assert.equal(stripped.webhooks.feishu.secret, undefined);
  assert.equal(stripped.webhooks.dingtalk.secret, "kept");
  // The input is untouched (dispatch keeps the materialized "" shape).
  assert.equal(cfg.webhooks.feishu.secret, "");
});

test("redactSecrets strips only the declared signing-key positions", () => {
  const cfg = normalizeConfig({
    webhooks: {
      feishu: { enabled: true, url: "https://f", secret: "top-secret" },
      dingtalk: {},
      wecom: { url: "https://w" },
    },
  });
  // The settings pipeline resolves stripped layers, so redaction sees the
  // stripped view; an unstripped "" would falsely report set:true.
  const view = redactSecrets(SCHEMA, stripEmptySecrets(cfg));
  assert.equal(view.value.webhooks.feishu.secret, undefined);
  assert.equal(view.value.webhooks.dingtalk.secret, undefined);
  assert.equal(view.value.webhooks.feishu.url, "https://f");
  assert.equal(view.value.webhooks.wecom.bodyTemplate, "");
  assert.deepEqual(
    Object.fromEntries(view.secrets.map((entry) => [entry.path.join("."), entry.set])),
    { "webhooks.feishu.secret": true, "webhooks.dingtalk.secret": false },
  );
});

// ── settings-backed persistence ──────────────────────────────────────────────

/** Faithful-enough stand-in for the cordis settings service: register/resolve
 * like SettingsProvider (defaults+base+user through the live schema), plus a
 * controllable failure switch on replace(). */
function makeSettingsService() {
  const service = {
    registrations: new Map(),
    userSections: new Map(),
    failReplace: false,
    replaced: [],
    register(ns, schema, options) {
      const reg = { ns: String(ns), schema, base: options.base, watchers: [] };
      service.registrations.set(reg.ns, reg);
      return {
        get: () => service.resolve(reg),
        watch: (cb) => { reg.watchers.push(cb); return () => {}; },
      };
    },
    resolve(reg) {
      return reg.schema({ ...(reg.base ?? {}), ...(service.userSections.get(reg.ns) ?? {}) });
    },
    get(ns) {
      const reg = service.registrations.get(String(ns));
      return reg === undefined ? undefined : service.resolve(reg);
    },
    async replace(ns, section) {
      const reg = service.registrations.get(String(ns));
      if (service.failReplace || reg === undefined) throw new Error("storage broken");
      service.userSections.set(String(ns), section);
      service.replaced.push(String(ns));
      const next = service.resolve(reg);
      for (const cb of reg.watchers) cb(next, undefined);
    },
  };
  return service;
}

/** Plugin ctx whose inject() mounts the fake settings service immediately. */
function settingsCtx(directory) {
  const routes = new Map();
  const listeners = new Map();
  const disposers = [];
  const settings = makeSettingsService();
  const ctx = {
    logger: { warn() {} },
    fiber: { state: 0 }, // isUnloading reads ctx.fiber.state
    get(name) {
      if (name === "webServer") return ctx.webServer;
      if (name === "settings") return settings;
      return undefined;
    },
    webServer: { register(entry) { routes.set(entry.path, entry.handler); } },
    effect(fn) { disposers.push(fn()); },
    // installSettingsSection injects ["settings"] and mounts synchronously on
    // the resolved context (which carries `.settings` and its own `effect`).
    inject(_deps, cb) {
      cb({
        settings,
        effect(fn) { disposers.push(fn()); },
      });
    },
    on(name, fn) { listeners.set(name, fn); },
    settings,
    routes,
    listeners,
  };
  return ctx;
}

test("apply registers the namespace and persists writes to the settings document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-set-"));
  const ctx = settingsCtx(directory);
  const { apply } = await import("../lib/index.js");
  apply(ctx, { directory });

  const reg = ctx.settings.registrations.get(SETTINGS_NS);
  assert.ok(reg, "namespace registered");
  assert.equal(typeof ctx.routes.get("/dsh-plugin-notify/config"), "function");

  const postConfig = ctx.routes.get("/dsh-plugin-notify/config");
  const res = await call(postConfig, "POST", {
    config: { webhooks: { feishu: { enabled: true, url: "https://f/new" } } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(ctx.settings.replaced, [SETTINGS_NS]);
  // Only the host holds stored secrets: the section reaching the settings
  // document must still carry the merged signing key even though the browser
  // never sent one. No secret was stored yet, so it stays ABSENT (empty
  // strings never reach the document — absence means "not configured").
  const section = ctx.settings.userSections.get(SETTINGS_NS);
  assert.equal(section.webhooks.feishu.secret, undefined);
  assert.equal(section.webhooks.feishu.url, "https://f/new");

  // The commit flows back through watch -> onChange -> current.
  const getConfig = ctx.routes.get("/dsh-plugin-notify/config");
  const view = await call(getConfig, "GET");
  assert.equal(view.body.config.webhooks.feishu.url, "https://f/new");
});

test("stored secrets survive a settings-backed save that omits them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-set-"));
  // Seed a legacy config.json holding a signing key.
  const legacy = JSON.stringify({
    webhooks: { feishu: { enabled: true, url: "https://f/old", secret: "legacy-key" } },
  });
  await writeFile(join(directory, "config.json"), legacy, "utf8");

  const ctx = settingsCtx(directory);
  const { apply } = await import("../lib/index.js");
  apply(ctx, { directory });

  // The seed reached the registration as the composition base, stripped of its
  // empty signing keys but carrying the configured one.
  const base = ctx.settings.registrations.get(SETTINGS_NS).base;
  assert.equal(base.webhooks.feishu.secret, "legacy-key");
  assert.equal(base.webhooks.dingtalk.secret, undefined);

  const postConfig = ctx.routes.get("/dsh-plugin-notify/config");
  const saved = await call(postConfig, "POST", {
    config: { webhooks: { feishu: { enabled: true, url: "https://f/new" } } },
  });
  assert.equal(saved.status, 200);
  const section = ctx.settings.userSections.get(SETTINGS_NS);
  assert.equal(section.webhooks.feishu.secret, "legacy-key");
  assert.equal(saved.body.secretSet["webhooks.feishu.secret"], true);

  // clearSecrets still clears through the settings document (the empty string
  // is stripped, leaving the field absent).
  const cleared = await call(postConfig, "POST", {
    config: { webhooks: { feishu: { secret: "" } } },
    clearSecrets: ["webhooks.feishu.secret"],
  });
  assert.equal(cleared.status, 200);
  assert.equal(ctx.settings.userSections.get(SETTINGS_NS).webhooks.feishu.secret, undefined);
  assert.equal(cleared.body.secretSet["webhooks.feishu.secret"], false);

  // No config.json write happened while settings backed the namespace: the
  // seeded legacy file stays byte-identical.
  assert.equal(await readFile(join(directory, "config.json"), "utf8"), legacy);
});

test("canUseSettings reads the service via ctx.get, not a bare property access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-set-"));
  const ctx = settingsCtx(directory);
  const service = ctx.settings;
  // Simulate the real cordis proxy: reading an undeclared service property
  // THROWS (`cannot get property "settings" without inject`). The plugin must
  // reach the service through ctx.get instead of ctx.settings.
  Object.defineProperty(ctx, "settings", {
    get() { throw new Error('cannot get property "settings" without inject'); },
  });
  const { apply } = await import("../lib/index.js");
  apply(ctx, { directory });

  const res = await call(ctx.routes.get("/dsh-plugin-notify/config"), "POST", {
    config: { system: { enabled: true } },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(service.replaced, [SETTINGS_NS]);
  assert.equal(service.userSections.get(SETTINGS_NS).system.enabled, true);
});

test("a failing settings write falls back to the legacy config.json store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-set-"));
  const ctx = settingsCtx(directory);
  ctx.settings.failReplace = true;
  const { apply } = await import("../lib/index.js");
  apply(ctx, { directory });

  const postConfig = ctx.routes.get("/dsh-plugin-notify/config");
  const res = await call(postConfig, "POST", {
    config: { webhooks: { dingtalk: { enabled: true, url: "https://d", secret: "dk" } } },
  });
  assert.equal(res.status, 200);
  assert.equal(ctx.settings.replaced.length, 0);
  const onDisk = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.equal(onDisk.webhooks.dingtalk.secret, "dk");
  assert.equal(res.body.secretSet["webhooks.dingtalk.secret"], true);
});

test("without an injectable settings service the plugin stays on config.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-set-"));
  const routes = new Map();
  const ctx = {
    logger: { warn() {} },
    get(name) { return name === "webServer" ? ctx.webServer : undefined; },
    webServer: { register(entry) { routes.set(entry.path, entry.handler); } },
    effect(fn) { fn(); },
    on() {},
  };
  const { apply } = await import("../lib/index.js");
  apply(ctx, { directory });

  const postConfig = ctx.routes?.get?.("/x") ?? routes.get("/dsh-plugin-notify/config");
  const res = await call(routes.get("/dsh-plugin-notify/config"), "POST", {
    config: { system: { enabled: true } },
  });
  assert.equal(res.status, 200);
  const onDisk = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.equal(onDisk.system.enabled, true);
});

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

// mergeTestConfig is re-exported coverage for the draft-test path used with
// settings-backed configs (kept adjacent to the persistence tests).
test("mergeTestConfig still overlays drafts without touching stored secrets", () => {
  const saved = { enabled: true, url: "https://x", secret: "stored", bodyTemplate: "" };
  assert.equal(mergeTestConfig(saved, { url: "https://y" }).url, "https://y");
  assert.equal(mergeTestConfig(saved, { url: "https://y" }).secret, "stored");
});
