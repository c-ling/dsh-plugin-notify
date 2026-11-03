// Client bundle smoke test: the hand-written factory-CJS bundle must register
// the locale dictionary, the two slot contributions, and pass the 0.2.1
// service inject list. It also asserts bilingual dictionary parity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const CLIENT_SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

const ReactComponentStub = class {
  constructor(props) { this.props = props; this.state = {}; }
  setState(next) { this.state = Object.assign({}, this.state, next); }
};

function createHarness() {
  const registrations = [];
  let cssInjections = 0;
  const dictionary = { zh: null, en: null };
  let activeLocale = "zh";

  function translate(key, params) {
    const dict = dictionary[activeLocale] ?? dictionary.zh ?? {};
    let text = dict[key] ?? key;
    if (params && typeof text === "string") {
      text = text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }
    return text;
  }

  const style = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    textContent: "",
  };
  const documentStub = {
    documentElement: { dataset: {} },
    visibilityState: "visible",
    querySelector() { return null; },
    createElement() { return style; },
    head: { appendChild() { cssInjections += 1; } },
    body: {},
    addEventListener() {},
    removeEventListener() {},
  };

  const windowStub = {
    __ModuleLoader__: { load(config) { windowStub.registered = config; } },
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
  };

  const listListeners = new Set();
  const listState = {
    ids: ["s1"],
    byId: {
      s1: { id: "s1", displayTitle: "Session 1", running: false },
    },
    current: "s1",
    phase: "ready",
  };
  const sessions = {
    list: {
      getSnapshot: () => listState,
      subscribe(listener) {
        listListeners.add(listener);
        return () => listListeners.delete(listener);
      },
    },
    open() {},
  };
  const statusListeners = new Set();
  const statusMap = new Map([["s1", { running: false, pendingInteraction: undefined }]]);
  const uiSession = {
    sessionStatus: {
      getSnapshot: () => statusMap,
      subscribe(listener) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
    },
  };

  const slots = {
    inject(name, fn) { fn(); },
    register(options, Component) {
      registrations.push({ name: options.name, id: options.id, options, Component });
      return () => {};
    },
  };

  const effects = [];
  const ctx = {
    locale: {
      register(ns, dict) {
        dictionary.zh = dict.zh;
        dictionary.en = dict.en;
        return () => {};
      },
      bind() { return translate; },
    },
    get(name) {
      if (name === "slots") return slots;
      if (name === "sessions") return sessions;
      if (name === "uiSession") return uiSession;
      return undefined;
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === "function") effects.push(disposer);
    },
  };

  const React = {
    createElement(type, props) {
      return { type, props: props ?? {}, children: Array.prototype.slice.call(arguments, 2) };
    },
    useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
    useEffect() {},
    useRef(value) { return { current: value }; },
    useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); },
    Component: ReactComponentStub,
  };
  const ReactDOM = { createPortal(node) { return node; } };

  function requireStub(id) {
    if (id === "react") return React;
    if (id === "react-dom") return ReactDOM;
    if (id.includes("dsh-client-ui-primitives")) return { IconPlusOutline16: () => null };
    throw new Error("unexpected require: " + id);
  }

  const configPayload = {
    ok: true,
    config: {
      triggers: { turnEnd: true, turnEndKinds: ["completed", "max-tokens"], approval: true },
      browser: { enabled: true, toast: true, native: false },
      system: { enabled: false, sound: true },
      webhooks: {
        feishu: { enabled: false, url: "", secret: "", bodyTemplate: "" },
        dingtalk: { enabled: false, url: "", secret: "", bodyTemplate: "" },
        wecom: { enabled: false, url: "", bodyTemplate: "" },
        generic: [],
      },
    },
    secretSet: {},
    revision: 0,
    meta: { platform: "darwin", desktop: true },
  };

  const context = {
    window: windowStub,
    document: documentStub,
    location: { protocol: "http:", hostname: "127.0.0.1" },
    Notification: undefined,
    console,
    setTimeout,
    clearTimeout,
    AbortSignal,
    Response,
    URL,
    fetch: async () => new Response(JSON.stringify(configPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    encodeURIComponent,
    Promise,
    Map,
    Set,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
    Error,
    RegExp,
  };
  vm.createContext(context);
  vm.runInContext(CLIENT_SOURCE, context, { filename: "dsh-plugin-notify/client.js" });

  return {
    registration: windowStub.registered,
    registrations,
    dictionary,
    ctx,
    translate,
    get cssInjections() { return cssInjections; },
    effects,
    documentStub,
  };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test("client bundle registers the factory, inject list, locale, and both slots", async () => {
  const harness = createHarness();
  assert.ok(harness.registration, "window.__ModuleLoader__.load was called");
  assert.equal(harness.registration.id, "dsh-plugin-notify");
  assert.equal(typeof harness.registration.factory, "function");

  const exports = harness.registration.factory((id) => {
    if (id === "react") {
      return {
        createElement: (type, props) => ({ type, props }),
        useState: (initial) => [initial, () => {}],
        useEffect() {},
        useRef: (value) => ({ current: value }),
        useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); },
        Component: ReactComponentStub,
      };
    }
    if (id === "react-dom") return { createPortal: (node) => node };
    if (id.includes("dsh-client-ui-primitives")) return { IconPlusOutline16: () => null };
    throw new Error("unexpected require: " + id);
  });

  assert.deepEqual(Array.from(exports.inject), ["slots", "locale", "sessions", "uiSession"]);
  exports.apply(harness.ctx);
  await tick();

  assert.equal(harness.cssInjections, 1, "CSS injected exactly once");
  const names = harness.registrations.map((entry) => entry.name);
  assert.ok(names.includes("shell.overlay"));
  assert.ok(names.includes("settings.section"));
  const settings = harness.registrations.find((entry) => entry.name === "settings.section");
  assert.equal(settings.options.locale, "dsh-plugin-notify");
  assert.equal(settings.options.label(), "消息提醒");
});

test("client dictionary zh/en keys are identical and every value is a string", () => {
  const harness = createHarness();
  const exports = harness.registration.factory((id) => {
    if (id === "react") return { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }), useSyncExternalStore: (s, g) => g(), Component: ReactComponentStub };
    if (id === "react-dom") return { createPortal: (node) => node };
    return { IconPlusOutline16: () => null };
  });
  exports.apply(harness.ctx);
  const zh = harness.dictionary.zh;
  const en = harness.dictionary.en;
  assert.ok(zh && en, "both dictionaries registered");
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(zh)) {
    assert.equal(typeof zh[key], "string", "zh " + key);
    assert.equal(typeof en[key], "string", "en " + key);
  }
  assert.equal(zh["kind_maxTokens"], "输出达到上限");
  assert.equal(zh["errors.stale-config"], "配置已在其他窗口更新");
});

test("client bundle exports the expected shape and applies twice without throwing", async () => {
  const harness = createHarness();
  const exports = harness.registration.factory((id) => {
    if (id === "react") return { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }), useSyncExternalStore: (s, g) => g(), Component: ReactComponentStub };
    if (id === "react-dom") return { createPortal: (node) => node };
    return { IconPlusOutline16: () => null };
  });
  assert.equal(exports.name, "dsh-plugin-notify");
  assert.equal(typeof exports.apply, "function");
  assert.doesNotThrow(() => exports.apply(harness.ctx));
  assert.doesNotThrow(() => exports.apply(harness.ctx));
  await tick();
});

test("resolveSessionOpener prefers uiWorkspace.openSession and falls back to sessions.open", () => {
  const harness = createHarness();
  const exports = harness.registration.factory((id) => {
    if (id === "react") return { createElement: () => null, useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }), useSyncExternalStore: (s, g) => g(), Component: ReactComponentStub };
    if (id === "react-dom") return { createPortal: (node) => node };
    return { IconPlusOutline16: () => null };
  });

  const calls = [];
  const modern = {
    get(name) {
      if (name === "uiWorkspace") return { openSession: (id) => calls.push(["workspace", id]) };
      if (name === "sessions") return { open: (id) => calls.push(["sessions", id]) };
      return undefined;
    },
  };
  exports.resolveSessionOpener(modern)("s1");
  assert.deepEqual(calls, [["workspace", "s1"]], "uiWorkspace wins when both exist");

  calls.length = 0;
  const legacy = { get: (name) => (name === "sessions" ? { open: (id) => calls.push(["sessions", id]) } : undefined) };
  exports.resolveSessionOpener(legacy)("s2");
  assert.deepEqual(calls, [["sessions", "s2"]], "older releases fall back to sessions.open");

  assert.equal(exports.resolveSessionOpener({ get: () => undefined }), undefined, "no navigation service");
  assert.equal(exports.resolveSessionOpener({ get: () => { throw new Error("service gone"); } }), undefined, "throwing lookup is tolerated");
});
