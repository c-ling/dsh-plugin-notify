// Config-store tests for the 0.2.1 host half: entry config seed, config.json
// precedence, corrupt-file fallback, and the authenticated Fetch routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply, normalizeConfig } from "../lib/index.js";

function stubCtx() {
  const routes = new Map();
  const ctx = {
    logger: { warn() {} },
    get() { return undefined; },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => { routes.delete(route.path); };
        },
      },
    },
    effect(fn) { fn(); },
    on() {},
    routes,
  };
  return ctx;
}

async function getConfig(route) {
  const res = await route.fetch(new Request("http://dsh.test/api/dsh-plugin-notify/config", { method: "GET" }));
  return { status: res.status, body: await res.json() };
}

test("entry config seeds the store and config.json overrides it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-config-"));

  const entryCtx = stubCtx();
  apply(entryCtx, {
    directory,
    triggers: { turnEnd: false },
    webhooks: { wecom: { enabled: true, url: "https://entry.example/hook" } },
  });
  const entryView = await getConfig(entryCtx.routes.get("/api/dsh-plugin-notify/config"));
  assert.equal(entryView.status, 200);
  assert.equal(entryView.body.config.triggers.turnEnd, false);
  assert.equal(entryView.body.config.webhooks.wecom.url, "https://entry.example/hook");

  const stored = normalizeConfig({ system: { enabled: true }, triggers: { turnEndKinds: ["error"] } });
  await writeFile(join(directory, "config.json"), JSON.stringify(stored), "utf8");

  const storedCtx = stubCtx();
  apply(storedCtx, { directory, triggers: { turnEnd: false } });
  const storedView = await getConfig(storedCtx.routes.get("/api/dsh-plugin-notify/config"));
  assert.equal(storedView.body.config.system.enabled, true);
  assert.deepEqual(storedView.body.config.triggers.turnEndKinds, ["error"]);
  assert.equal(storedView.body.config.triggers.turnEnd, true, "stored config wins over entry config");
});

test("a corrupt config.json warns and falls back to entry config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-config-"));
  await writeFile(join(directory, "config.json"), "{broken", "utf8");
  const ctx = stubCtx();
  const warnings = [];
  ctx.logger.warn = (line) => warnings.push(String(line));
  apply(ctx, { directory, browser: { native: true } });
  const view = await getConfig(ctx.routes.get("/api/dsh-plugin-notify/config"));
  assert.equal(view.status, 200);
  assert.equal(view.body.config.browser.native, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unreadable config/);
});

test("GET does not create config.json; a save does", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-plugin-notify-config-"));
  const ctx = stubCtx();
  apply(ctx, { directory });
  const route = ctx.routes.get("/api/dsh-plugin-notify/config");
  await getConfig(route);
  await assert.rejects(() => readFile(join(directory, "config.json"), "utf8"));

  const res = await route.fetch(new Request("http://dsh.test/api/dsh-plugin-notify/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { system: { enabled: true } } }),
  }));
  assert.equal(res.status, 200);
  const onDisk = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
  assert.equal(onDisk.system.enabled, true);
});

test("the host half does not require a settings service", () => {
  const directory = "/nonexistent";
  const ctx = stubCtx();
  assert.doesNotThrow(() => apply(ctx, { directory }));
  assert.ok(ctx.routes.get("/api/dsh-plugin-notify/config"));
});
