/**
 * dsh-plugin-notify client half: the browser bundle (factory-CJS, hand-written, no
 * build step). Registers two slot contributions:
 *
 *   - settings.section: the "消息提醒" page — trigger selection, per-channel
 *     toggles (browser banner + native OS notification/system/Feishu/DingTalk/
 *     WeCom/generic webhooks), secret inputs, and per-channel test buttons.
 *   - shell.overlay: the in-page toast banner stack (the browser channel's
 *     visible delivery surface; the native OS notification covers background
 *     tabs via the browser Notification API).
 *
 * It also runs a notification engine outside the settings page: it subscribes
 * to the current session's ConversationSnapshot through
 * `sessions.currentProvideInfo -> hooks.session` (the same channel dsh-plugin-pet
 * uses), and pushes a banner when `running` flips true→false (turn ended) or
 * a new pending interaction appears (approval/question). Config is read from
 * the host half via GET /dsh-plugin-notify/config (loaded once at boot and refreshed by
 * the settings page).
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var ReactDOM = require("react-dom");
    var IconPlusOutline = null;
    try {
      IconPlusOutline = require("@deepseek-ai/dsh-client-ui-primitives").IconPlusOutline16;
    } catch (error) {
      // icon is decorative; fall back to a text plus sign
    }

    var NS = "dsh-plugin-notify";

    // ── css ────────────────────────────────────────────────────────────────

    (function injectCss() {
      if (document.querySelector('style[data-plugin="dsh-plugin-notify"]')) return;
      var style = document.createElement("style");
      style.setAttribute("data-plugin", "dsh-plugin-notify");
      style.setAttribute("data-pluginCss", "dsh-plugin-notify");
      style.textContent = [
        ".dsh-plugin-notify{display:flex;flex-direction:column;gap:12px;width:100%;max-width:640px;height:calc(100% + 24px);margin-bottom:-24px;}",
        ".dsh-plugin-notify-header{flex:none;display:flex;flex-direction:column;gap:4px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-plugin-notify-headerRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-plugin-notify-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px;}",
        ".dsh-plugin-notify-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px;}",
        ".dsh-plugin-notify-tag{display:inline-block;font-size:11px;line-height:1.2;padding:3px 8px;border-radius:999px;font-weight:500;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14));max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        ".dsh-plugin-notify-tag-warn{color:var(--dsw-alias-state-warn-primary,#b7791f);}",
        ".dsh-plugin-notify-tag-success{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-plugin-notify-tag-error{color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-plugin-notify-tag-info{color:var(--dsw-alias-label-secondary,inherit);}",
        ".dsh-plugin-notify-content{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:0 8px 0 2px;margin-right:-8px;scrollbar-width:thin;}",
        ".dsh-plugin-notify-content::-webkit-scrollbar{width:8px;background:transparent;}",
        ".dsh-plugin-notify-content::-webkit-scrollbar-thumb{background:transparent;border-radius:4px;}",
        ".dsh-plugin-notify-content:hover::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.45));}",
        ".dsh-plugin-notify-footer{flex:none;padding:15px 2px;display:flex;flex-direction:column;align-items:stretch;gap:8px;background:var(--dsw-alias-bg-layer-2,#fff);border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));}",
        ".dsh-plugin-notify-footer .dsh-plugin-notify-button{width:100%;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#111417));color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:999px;padding:9px 12px;font-size:14px;font-weight:500;}",
        ".dsh-plugin-notify-footer .dsh-plugin-notify-button:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#111417));}",
        ".dsh-plugin-notify-toast-stack{position:fixed;top:20px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:1200;width:420px;max-width:calc(100vw - 40px);pointer-events:none;}",
        ".dsh-plugin-notify-toast{pointer-events:auto;position:relative;background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-left:4px solid var(--dsw-alias-brand-primary,#6d8dff);border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:16px 20px 16px 18px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary,inherit);animation:dsh-plugin-notify-toast-in .22s ease-out;}",
        "@keyframes dsh-plugin-notify-toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}",
        ".dsh-plugin-notify-toast-title{font-weight:600;font-size:15px;line-height:1.4;padding-right:22px;}",
        ".dsh-plugin-notify-toast-body{font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit);white-space:pre-wrap;}",
        ".dsh-plugin-notify-toast-close{position:absolute;top:10px;right:10px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font-size:16px;line-height:1;padding:4px 7px;border-radius:8px;}",
        ".dsh-plugin-notify-toast-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));}",
        ".dsh-plugin-notify-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:transparent;border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;position:relative;}",
        ".dsh-plugin-notify-card-header{display:flex;align-items:center;justify-content:space-between;gap:12px;}",
        ".dsh-plugin-notify-card-title{min-width:0;display:flex;flex-direction:column;gap:2px;}",
        ".dsh-plugin-notify-card-right{flex:none;display:flex;align-items:center;}",
        ".dsh-plugin-notify-switch{position:relative;flex:none;width:40px;height:22px;border-radius:999px;border:none;padding:0;background:var(--dsw-alias-border-l2,rgba(128,128,128,.42));cursor:pointer;transition:background .15s ease;}",
        ".dsh-plugin-notify-switch:hover:not(:disabled){background:var(--dsw-alias-border-l3,rgba(128,128,128,.6));}",
        ".dsh-plugin-notify-switch-on,.dsh-plugin-notify-switch-on:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#6d8dff);}",
        ".dsh-plugin-notify-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#6d8dff);outline-offset:2px;}",
        ".dsh-plugin-notify-switch:disabled{opacity:.5;cursor:default;}",
        ".dsh-plugin-notify-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(15,23,42,.25);transition:transform .15s ease;}",
        ".dsh-plugin-notify-switch-on .dsh-plugin-notify-switch-knob{transform:translateX(18px);}",
        ".dsh-plugin-notify-card h3{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);}",
        ".dsh-plugin-notify-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-plugin-notify-row > label{flex:1 1 220px;min-width:0;}",
        ".dsh-plugin-notify-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 16px;}",
        ".dsh-plugin-notify-field{display:flex;flex-direction:column;gap:4px;}",
        ".dsh-plugin-notify-field > span:first-child{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);}",
        ".dsh-plugin-notify-input{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit;transition:border-color .15s ease;}",
        ".dsh-plugin-notify-textarea{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;resize:vertical;}",
        ".dsh-plugin-notify-input:focus,.dsh-plugin-notify-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#6d8dff);}",
        ".dsh-plugin-notify-input::placeholder,.dsh-plugin-notify-textarea::placeholder{color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.6));}",
        ".dsh-plugin-notify-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-plugin-notify-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
        ".dsh-plugin-notify-button{padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer;transition:background .15s ease,border-color .15s ease;}",
        ".dsh-plugin-notify-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.8));}",
        ".dsh-plugin-notify-button:disabled{opacity:.4;cursor:not-allowed;}",
        ".dsh-plugin-notify-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;}",
        ".dsh-plugin-notify-ok{color:var(--dsw-alias-state-success-primary,#46a758);font-size:12px;}",
        ".dsh-plugin-notify-kind{display:inline-flex;align-items:center;gap:4px;margin-right:10px;}",
        ".dsh-plugin-notify-row input[type=checkbox],.dsh-plugin-notify-kind input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#6d8dff);}",
        ".dsh-plugin-notify-generic-item{border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;}",
        ".dsh-plugin-notify-generic-header{display:flex;align-items:center;justify-content:space-between;gap:12px;}",
        ".dsh-plugin-notify-generic-header-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}",
        ".dsh-plugin-notify-add-button{box-sizing:border-box;width:100%;height:44px;font:inherit;cursor:pointer;border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:12px;justify-content:center;align-items:center;gap:6px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;color:var(--dsw-alias-label-primary,inherit);background:transparent;}",
        ".dsh-plugin-notify-add-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}",
        ".dsh-plugin-notify-generic-item + .dsh-plugin-notify-generic-item{margin-top:8px;}",
      ].join("\n");
      document.head.appendChild(style);
    })();

    // ── i18n ───────────────────────────────────────────────────────────────

    var DICT = {
      zh: {
        nav: "消息提醒",
        headerDesc: "任务回合结束或等待用户确认时，通过所选渠道发送提醒",
        loading: "加载中…",
        loadError: "无法加载通知配置：{error}",
        retry: "重试",
        save: "保存",
        saving: "保存中…",
        saved: "已保存",
        unsaved: "有未保存的更改",
        saveError: "保存失败：{error}",
        triggers: "触发条件",
        triggerTurnEnd: "任务回合结束时提醒",
        triggerTurnEndHint: "按回合结束原因过滤（可多选）",
        triggerApproval: "等待用户确认时提醒",
        triggerApprovalHint: "工具调用需要审批、或等待用户输入时提醒",
        kind_completed: "正常完成",
        kind_blocked: "目标阻塞",
        kind_aborted: "已中止",
        kind_error: "出错",
        browser: "浏览器通知",
        browserHint: "页面可见时在右上角弹出文字横幅；标签页在后台时请开启原生通知；完全离开页面时请配合系统通知使用",
        browserEnabled: "启用浏览器通知",
        browserToast: "页面内横幅",
        browserToastHint: "任务结束或等待确认时在右上角弹出文字横幅（不依赖系统通知权限）",
        browserNative: "系统原生通知",
        browserNativeHint: "通过浏览器 Notification API 调用操作系统通知，标签页在后台或窗口最小化时也能弹出（需要浏览器通知权限）",
        nativeEnabled: "启用系统原生通知",
        nativePermissionDenied: "通知权限未授予。请在浏览器站点设置中允许本站通知后重试。",
        nativeUnsupported: "当前浏览器不支持系统原生通知",
        testBrowser: "测试横幅",
        testNative: "测试通知",
        system: "系统通知",
        systemHint: "通过宿主机发送，浏览器关闭也能收到（macOS / Linux / Windows）",
        systemEnabled: "启用系统通知",
        systemSound: "系统提示音（macOS / Windows）",
        feishu: "飞书群机器人",
        dingtalk: "钉钉群机器人",
        wecom: "企业微信群机器人",
        webhookUrl: "Webhook 地址",
        webhookUrlHint: "群机器人设置里复制完整的 webhook 地址",
        webhookSecret: "签名密钥（可选）",
        webhookSecretSet: "已配置（留空保持不变）",
        webhookSecretClear: "清除密钥",
        webhookEnabled: "启用该渠道",
        webhookTemplate: "消息模板（可选）",
        webhookTemplateHint: "支持占位符 {{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}；留空使用统一默认格式",
        test: "发送测试",
        testSending: "发送中…",
        testOk: "测试消息已发送",
        testFailed: "测试失败：{error}",
        generic: "通用 Webhook",
        genericHint: "自定义 URL 与 JSON/文本模板，可对接 Slack / Discord / ntfy / Bark / Server酱 等",
        genericAdd: "添加",
        genericRemove: "移除",
        genericName: "名称",
        genericTitle: "Webhook {index}",
        genericHeaders: "请求头（JSON，可选）",
        genericTemplate: "消息模板",
        genericTemplateHint: "支持占位符：{{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}；留空则发送纯文本消息",
        genericNone: "暂无通用 webhook，点击「添加」创建。",
      },
      en: {
        nav: "Notifications",
        headerDesc: "Notify across your selected channels when a task turn ends or execution waits for your confirmation",
        loading: "Loading…",
        loadError: "Failed to load notification config: {error}",
        retry: "Retry",
        save: "Save",
        saving: "Saving…",
        saved: "Saved",
        unsaved: "Unsaved changes",
        saveError: "Save failed: {error}",
        triggers: "Triggers",
        triggerTurnEnd: "Notify when a task turn ends",
        triggerTurnEndHint: "Filter by end reason (multi-select)",
        triggerApproval: "Notify when waiting for user confirmation",
        triggerApprovalHint: "Tool approvals and interactive questions",
        kind_completed: "Completed",
        kind_blocked: "Goal blocked",
        kind_aborted: "Aborted",
        kind_error: "Error",
        browser: "Browser notifications",
        browserHint: "In-page banner while the page is visible; enable native notifications for background tabs; use system notifications when away from the browser",
        browserEnabled: "Enable browser notifications",
        browserToast: "In-page banner",
        browserToastHint: "Show a text banner in the top-right corner on turn end or pending confirmation (no OS permission needed)",
        browserNative: "Native OS notification",
        browserNativeHint: "Uses the browser Notification API to show an OS notification, even while the tab is in the background (requires browser notification permission)",
        nativeEnabled: "Enable native notifications",
        nativePermissionDenied: "Notification permission not granted. Allow notifications for this site in your browser settings, then try again.",
        nativeUnsupported: "Native OS notifications are not supported in this browser",
        testBrowser: "Test banner",
        testNative: "Test notification",
        system: "System notifications",
        systemHint: "Sent by the host process; works even with the browser closed (macOS / Linux / Windows)",
        systemEnabled: "Enable system notifications",
        systemSound: "System sound (macOS / Windows)",
        feishu: "Feishu group bot",
        dingtalk: "DingTalk group bot",
        wecom: "WeCom group bot",
        webhookUrl: "Webhook URL",
        webhookUrlHint: "Copy the full webhook URL from the bot settings",
        webhookSecret: "Sign secret (optional)",
        webhookSecretSet: "Configured (leave empty to keep)",
        webhookSecretClear: "Clear secret",
        webhookEnabled: "Enable this channel",
        webhookTemplate: "Message template (optional)",
        webhookTemplateHint: "Placeholders: {{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}; empty uses the unified default format",
        test: "Send test",
        testSending: "Sending…",
        testOk: "Test message sent",
        testFailed: "Test failed: {error}",
        generic: "Generic webhooks",
        genericHint: "Custom URL and JSON/text template for Slack / Discord / ntfy / Bark / ServerChan etc.",
        genericAdd: "Add",
        genericRemove: "Remove",
        genericName: "Name",
        genericTitle: "Webhook {index}",
        genericHeaders: "Headers (JSON, optional)",
        genericTemplate: "Message template",
        genericTemplateHint: "Placeholders: {{title}} {{body}} {{kind}} {{sessionId}} {{turn}} {{toolName}} {{reason}} {{time}}; empty sends a plain-text message",
        genericNone: "No generic webhooks yet. Click \"Add\" to create one.",
      },
    };

    // ── helpers ────────────────────────────────────────────────────────────

    function deepClone(value) {
      return value === undefined ? value : JSON.parse(JSON.stringify(value));
    }

    function el(type, props) {
      var args = [type, props];
      for (var i = 2; i < arguments.length; i += 1) args.push(arguments[i]);
      return React.createElement.apply(null, args);
    }

    function format(t, key, params) {
      var text = String(t(key));
      if (!params) return text;
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return name in params ? String(params[name]) : match;
      });
    }

    var TURN_END_KINDS = ["completed", "blocked", "aborted", "error"];

    // Unified text for every channel's test notification; matches the host
    // half's postTest message so browser / native / system / webhooks tests
    // all read identically.
    var TEST_TITLE = "DSH · 通知测试";
    var TEST_BODY = "这是一条来自 DeepSeek Harness 的测试消息，渠道工作正常。";

    // ── config store ───────────────────────────────────────────────────────

    function createStore() {
      var listeners = new Set();
      var state = { status: "loading", config: null, secretSet: {}, error: null, rev: 0 };
      var loading = null;

      function setState(patch) {
        state = Object.assign({}, state, patch, { rev: state.rev + 1 });
        for (var listener of listeners) listener();
      }

      function subscribe(listener) {
        listeners.add(listener);
        return function () { listeners.delete(listener); };
      }

      function getSnapshot() {
        return state;
      }

      async function load() {
        if (loading) return loading;
        loading = (async () => {
          try {
            var res = await fetch("/dsh-plugin-notify/config", { headers: { accept: "application/json" } });
            var data = await res.json();
            if (!data.ok) throw new Error(data.error || "HTTP " + res.status);
            setState({ status: "ready", config: data.config, secretSet: data.secretSet, error: null });
          } catch (error) {
            setState({ status: "error", config: null, secretSet: {}, error: String(error?.message ?? error) });
          } finally {
            loading = null;
          }
        })();
        return loading;
      }

      async function save(draft, clearSecrets) {
        var res = await fetch("/dsh-plugin-notify/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: draft, clearSecrets: clearSecrets ?? [] }),
        });
        var data = await res.json();
        if (!data.ok) throw new Error(data.error || "HTTP " + res.status);
        setState({ status: "ready", config: data.config, secretSet: data.secretSet, error: null });
        return data.config;
      }

      async function test(channel, genericId, options) {
        var body = Object.assign({ channel }, genericId === undefined ? {} : { genericId: genericId }, options ?? {});
        var res = await fetch("/dsh-plugin-notify/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        var data = await res.json();
        if (!data.ok) throw new Error(data.error || "HTTP " + res.status);
        return data;
      }

      return { subscribe, getSnapshot, load, save, test };
    }

    // ── browser notification (in-page banner + native OS notification) ─────

    /**
     * The browser channel has two delivery surfaces: the in-page toast banner
     * (visible while the page is open) and the native OS notification via the
     * browser Notification API (`window.Notification`), which shows even while
     * the tab is in the background or the window is minimized. The host system
     * channel covers the browser-closed case.
     */

    function nativeSupported() {
      return typeof Notification !== "undefined";
    }

    function nativePermissionGranted() {
      return nativeSupported() && Notification.permission === "granted";
    }

    /** Resolve true only when the OS may show notifications from this site. */
    function requestNativePermission() {
      if (!nativeSupported()) return Promise.resolve(false);
      if (Notification.permission === "granted") return Promise.resolve(true);
      if (Notification.permission === "denied") return Promise.resolve(false);
      try {
        var result = Notification.requestPermission();
        if (result && typeof result.then === "function") {
          return Promise.resolve(result).then(function (permission) { return permission === "granted"; });
        }
        return Promise.resolve(result === "granted");
      } catch (error) {
        return Promise.resolve(false);
      }
    }

    /** Fire one OS-level notification; silent no-op when permission is missing.
     * A shared `tag` makes the browser replace the previous notification
     * instead of stacking, so distinct notifications must use distinct tags. */
    function fireNativeNotification(title, body, tag) {
      if (!nativePermissionGranted()) return;
      try {
        var notice = new Notification(String(title), {
          body: String(body ?? ""),
          tag: typeof tag === "string" && tag !== "" ? tag : "dsh-plugin-notify",
        });
        notice.onclick = function () {
          try { window.focus(); } catch (error) { /* ignore */ }
          notice.close();
        };
      } catch (error) {
        // permission may have been revoked mid-flight; ignore
      }
    }

    function fireBrowserNotification(message, toastStore, options) {
      if (options && options.native === true) fireNativeNotification(message.title, message.body, options.tag);
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (toastStore === undefined) return;
      toastStore.push(message.title, message.body);
    }

    // ── in-page toast banner ───────────────────────────────────────────────

    function createToastStore() {
      var listeners = new Set();
      var items = [];

      function emit() {
        for (var listener of listeners) listener();
      }

      return {
        subscribe(listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        getSnapshot() {
          return items;
        },
        push(title, body) {
          var id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          items = items.concat([{ id: id, title: title, body: body }]).slice(-4);
          emit();
          window.setTimeout(function () {
            items = items.filter(function (entry) { return entry.id !== id; });
            emit();
          }, 6000);
        },
        dismiss(id) {
          items = items.filter(function (entry) { return entry.id !== id; });
          emit();
        },
      };
    }

    function ToastHost(props) {
      var store = props.toastStore;
      var items = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      if (items.length === 0) return null;
      // Portal to <body>: the shell.overlay layer sits in a z-index:20 stacking
      // context, below the settings modal (z-index 1000) — the banner must
      // escape it to stay on top of every panel and dialog.
      return ReactDOM.createPortal(el("div", { className: "dsh-plugin-notify-toast-stack" },
        items.map(function (item) {
          return el("div", { className: "dsh-plugin-notify-toast", key: item.id },
            el("div", { className: "dsh-plugin-notify-toast-title" }, item.title),
            el("div", { className: "dsh-plugin-notify-toast-body" }, item.body),
            el("button", {
              className: "dsh-plugin-notify-toast-close",
              "aria-label": "close",
              onClick: function () { store.dismiss(item.id); },
            }, "×"));
        })), document.body);
    }

    function pendingText(pending) {
      var payload = pending && pending.payload;
      if (!payload || typeof payload !== "object") return "";
      if (typeof payload.toolName === "string" && payload.toolName !== "") return payload.toolName;
      if (typeof payload.reason === "string" && payload.reason !== "") return payload.reason;
      var questions = payload.questions;
      if (Array.isArray(questions) && questions.length > 0 && typeof questions[0]?.header === "string") return questions[0].header;
      if (Array.isArray(questions) && questions.length > 0 && typeof questions[0]?.question === "string") return questions[0].question;
      return "";
    }

    /**
     * Subscribe to the current session snapshot and notify on two transitions:
     * running true→false (turn ended) and a new pending interaction (waiting
     * for the user). Returns a disposer.
     */
    function startEngine(ctx, store, toastStore, t) {
      var sessions = ctx.get("sessions");
      if (sessions === undefined || typeof sessions.currentProvideInfo?.subscribe !== "function") return undefined;

      var offInner = null;
      var prev = { initialized: false, running: false, pendingKeys: new Set() };

      function ensureConfig() {
        var snapshot = store.getSnapshot();
        if (snapshot.status === "loading" && snapshot.config === null) {
          store.load().catch(function () {});
        }
      }

      function handle(snapshot) {
        if (!snapshot || typeof snapshot !== "object") return;
        var cfg = store.getSnapshot().config;
        if (!cfg || typeof cfg !== "object") return ensureConfig();
        // The two browser-channel settings are independent: the in-page banner
        // needs the 浏览器通知 master switch, the native OS notification only
        // needs its own 系统原生通知 switch.
        var showToast = cfg.browser?.enabled !== false && cfg.browser?.toast !== false;
        var showNative = cfg.browser?.native === true;
        if (!showToast && !showNative) return;
        var running = snapshot.running === true;
        var pending = Array.isArray(snapshot.pending) ? snapshot.pending : [];
        var keys = new Set();
        for (var item of pending) if (item && typeof item.key === "string") keys.add(item.key);

        if (prev.initialized) {
          if (prev.running && !running && cfg.triggers && cfg.triggers.turnEnd !== false) {
            fireBrowserNotification({ title: format(t, "nav"), body: "任务回合已结束。" }, toastStore, { native: showNative, tag: "dsh-plugin-notify-turn" });
          }
          for (var pendingItem of pending) {
            if (!pendingItem || typeof pendingItem.key !== "string" || prev.pendingKeys.has(pendingItem.key)) continue;
            if (!cfg.triggers || cfg.triggers.approval === false) break;
            var text = pendingText(pendingItem);
            fireBrowserNotification({
              title: format(t, "nav"),
              body: (text === "" ? "" : text + " — ") + "等待你的确认。",
            }, toastStore, { native: showNative, tag: "dsh-plugin-notify-pending" });
          }
        }
        prev = { initialized: true, running: running, pendingKeys: keys };
      }

      function wire(info) {
        if (offInner !== null) { offInner(); offInner = null; }
        prev = { initialized: false, running: false, pendingKeys: new Set() };
        var hook = info && info.hooks && info.hooks.session;
        if (!hook || typeof hook.subscribe !== "function") return;
        offInner = hook.subscribe(function () {
          handle(hook.getSnapshot && hook.getSnapshot());
        });
        handle(hook.getSnapshot && hook.getSnapshot());
      }

      var offInfo = sessions.currentProvideInfo.subscribe(function () {
        wire(sessions.currentProvideInfo.getSnapshot());
      });
      wire(sessions.currentProvideInfo.getSnapshot());

      return function () {
        if (typeof offInfo === "function") offInfo();
        if (offInner !== null) offInner();
      };
    }

    // ── settings UI ────────────────────────────────────────────────────────

    function Toggle(props) {
      return el("div", { className: "dsh-plugin-notify-row" },
        el("label", null, props.label, props.hint ? el("div", { className: "dsh-plugin-notify-hint" }, props.hint) : null),
        el("input", {
          type: "checkbox",
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: function (event) { props.onChange(event.target.checked); },
        }));
    }

    function Switch(props) {
      return el("button", {
        type: "button",
        role: "switch",
        "aria-checked": props.checked === true,
        "aria-label": props.label,
        title: props.label,
        className: "dsh-plugin-notify-switch" + (props.checked === true ? " dsh-plugin-notify-switch-on" : ""),
        disabled: props.disabled === true,
        onClick: function () { if (props.disabled !== true) props.onChange(props.checked !== true); },
      }, el("span", { className: "dsh-plugin-notify-switch-knob" }));
    }

    function Field(props) {
      return el("div", { className: "dsh-plugin-notify-field" },
        el("span", null, props.label),
        props.children,
        props.hint ? el("span", { className: "dsh-plugin-notify-hint" }, props.hint) : null);
    }

    function Card(props) {
      return el("div", { className: "dsh-plugin-notify-card" },
        el("div", { className: "dsh-plugin-notify-card-header" },
          el("div", { className: "dsh-plugin-notify-card-title" },
            el("h3", null, props.title),
            props.hint ? el("div", { className: "dsh-plugin-notify-hint" }, props.hint) : null),
          props.right ? el("div", { className: "dsh-plugin-notify-card-right" }, props.right) : null),
        props.children);
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    }

    function headersTextsOf(config) {
      var out = {};
      var generic = config && Array.isArray(config.webhooks?.generic) ? config.webhooks.generic : [];
      for (var i = 0; i < generic.length; i += 1) {
        out[i] = generic[i].headers && Object.keys(generic[i].headers).length > 0
          ? JSON.stringify(generic[i].headers, null, 2)
          : "";
      }
      return out;
    }

    function WebhookCard(props) {
      var t = props.t;
      var draft = props.draft;
      var update = props.update;
      var webhook = props.webhook;
      var test = props.test;
      var testResults = props.testResults;
      var secretClear = props.secretClear;
      var setSecretClear = props.setSecretClear;
      var secretPath = "webhooks." + props.id + ".secret";
      var secretSet = Boolean(props.secretSet && props.secretSet[secretPath]);
      var result = testResults[props.id];
      var hasSecret = webhook.secret !== undefined;

      return el(Card, {
        title: props.title,
        hint: props.hint,
        right: el(Switch, {
          label: t("webhookEnabled"),
          checked: webhook.enabled,
          onChange: function (value) { update(function (next) { next.webhooks[props.id].enabled = value; }); },
        }),
      },
        el(Field, { label: t("webhookUrl"), hint: t("webhookUrlHint") },
          el("input", {
            className: "dsh-plugin-notify-input",
            type: "url",
            value: webhook.url,
            placeholder: "https://…",
            onChange: function (event) { update(function (next) { next.webhooks[props.id].url = event.target.value; }); },
          })),
        hasSecret ? el(Field, { label: t("webhookSecret") },
          el("input", {
            className: "dsh-plugin-notify-input",
            type: "password",
            value: webhook.secret,
            placeholder: secretSet ? t("webhookSecretSet") : "",
            autoComplete: "new-password",
            onChange: function (event) { update(function (next) { next.webhooks[props.id].secret = event.target.value; }); },
          }),
          secretSet ? el("div", { className: "dsh-plugin-notify-kind" },
            el("input", {
              type: "checkbox",
              checked: secretClear.has(secretPath),
              onChange: function (event) {
                setSecretClear(function (prev) {
                  var next = new Set(prev);
                  if (event.target.checked) next.add(secretPath); else next.delete(secretPath);
                  return next;
                });
              },
            }),
            el("span", { className: "dsh-plugin-notify-hint" }, t("webhookSecretClear"))) : null) : null,
        el(Field, { label: t("webhookTemplate"), hint: t("webhookTemplateHint") },
          el("textarea", {
            className: "dsh-plugin-notify-textarea",
            rows: 4,
            value: webhook.bodyTemplate || "",
            placeholder: "{{title}}\n{{body}}\n\n会话：{{sessionId}}\n时间：{{time}}",
            onChange: function (event) { update(function (next) { next.webhooks[props.id].bodyTemplate = event.target.value; }); },
          })),
        el("div", { className: "dsh-plugin-notify-actions" },
          el("button", {
            className: "dsh-plugin-notify-button",
            disabled: result && result.status === "sending",
            onClick: function () { test(props.id, undefined, { config: webhook }); },
          }, result && result.status === "sending" ? t("testSending") : t("test")),
          result && result.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testOk")) : null,
          result && result.status === "error" ? el("span", { className: "dsh-plugin-notify-error" }, format(t, "testFailed", { error: result.error })) : null));
    }

    function GenericWebhookCard(props) {
      var t = props.t;
      var draft = props.draft;
      var update = props.update;
      var test = props.test;
      var testResults = props.testResults;
      var headersTexts = props.headersTexts;
      var setHeadersTexts = props.setHeadersTexts;
      var generic = draft.webhooks.generic;

      return el(Card, { title: t("generic"), hint: t("genericHint") },
        generic.length === 0 ? el("div", { className: "dsh-plugin-notify-hint" }, t("genericNone")) : null,
        generic.map(function (item, index) {
          var result = testResults["generic:" + item.id];
          return el("div", { className: "dsh-plugin-notify-generic-item", key: item.id },
            el("div", { className: "dsh-plugin-notify-generic-header" },
              el("span", { className: "dsh-plugin-notify-generic-header-title" }, format(t, "genericTitle", { index: index + 1 })),
              el(Switch, {
                label: t("webhookEnabled"),
                checked: item.enabled,
                onChange: function (value) { update(function (next) { next.webhooks.generic[index].enabled = value; }); },
              })),
            el("div", { className: "dsh-plugin-notify-grid" },
              el(Field, { label: t("genericName") },
                el("input", {
                  className: "dsh-plugin-notify-input",
                  value: item.name,
                  onChange: function (event) { update(function (next) { next.webhooks.generic[index].name = event.target.value; }); },
                })),
              el(Field, { label: t("webhookUrl") },
                el("input", {
                  className: "dsh-plugin-notify-input",
                  type: "url",
                  value: item.url,
                  placeholder: "https://…",
                  onChange: function (event) { update(function (next) { next.webhooks.generic[index].url = event.target.value; }); },
                }))),
            el(Field, { label: t("genericHeaders") },
              el("textarea", {
                className: "dsh-plugin-notify-textarea",
                rows: 3,
                value: headersTexts[index] ?? "",
                placeholder: '{"Authorization": "Bearer …"}',
                onChange: function (event) {
                  var value = event.target.value;
                  setHeadersTexts(function (prev) {
                    var next = Object.assign({}, prev);
                    next[index] = value;
                    return next;
                  });
                },
              })),
            el(Field, { label: t("genericTemplate"), hint: t("genericTemplateHint") },
              el("textarea", {
                className: "dsh-plugin-notify-textarea",
                rows: 4,
                value: item.bodyTemplate,
                placeholder: '{"text":"{{title}}\\n{{body}}"}',
                onChange: function (event) { update(function (next) { next.webhooks.generic[index].bodyTemplate = event.target.value; }); },
              })),
            el("div", { className: "dsh-plugin-notify-actions" },
              el("button", {
                className: "dsh-plugin-notify-button",
                disabled: result && result.status === "sending",
                onClick: function () {
                  var cfg = Object.assign({}, item);
                  var raw = (headersTexts[index] ?? "").trim();
                  if (raw !== "") {
                    try {
                      var parsed = JSON.parse(raw);
                      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) cfg.headers = parsed;
                    } catch (error) {
                      // keep the stored headers when the draft JSON is invalid
                    }
                  }
                  test("generic", item.id, { config: cfg });
                },
              }, result && result.status === "sending" ? t("testSending") : t("test")),
              result && result.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testOk")) : null,
              result && result.status === "error" ? el("span", { className: "dsh-plugin-notify-error" }, format(t, "testFailed", { error: result.error })) : null,
              el("button", {
                className: "dsh-plugin-notify-button",
                onClick: function () { update(function (next) { next.webhooks.generic.splice(index, 1); }); },
              }, t("genericRemove"))));
        }),
        el("div", { className: "dsh-plugin-notify-actions" },
          el("button", {
            className: "dsh-plugin-notify-add-button",
            onClick: function () {
              update(function (next) {
                next.webhooks.generic.push({
                  id: "wh-" + Date.now().toString(36),
                  name: "",
                  enabled: false,
                  url: "",
                  headers: {},
                  bodyTemplate: "",
                });
              });
            },
          }, IconPlusOutline !== null ? el(IconPlusOutline, { size: 14 }) : "+", t("genericAdd"))));
    }

    function NotifySection(props) {
      var t = props.t;
      var store = props.store;
      var toastStore = props.toastStore;
      var snap = useStore(store);
      var dirtyRef = React.useRef(false);
      var savingRef = React.useRef(false);
      var [draft, setDraft] = React.useState(null);
      var [dirty, setDirtyState] = React.useState(false);
      var [headersTexts, setHeadersTexts] = React.useState({});
      var [secretClear, setSecretClear] = React.useState(new Set());
      var [saving, setSaving] = React.useState(false);
      var [saveError, setSaveError] = React.useState(null);
      var [saved, setSaved] = React.useState(false);
      var [testResults, setTestResults] = React.useState({});
      var [nativeError, setNativeError] = React.useState(null);

      function setDirty(value) {
        dirtyRef.current = value;
        setDirtyState(value);
        if (value) setSaved(false);
      }

      function update(mutator) {
        setDraft(function (prev) {
          var next = deepClone(prev);
          mutator(next);
          return next;
        });
        setDirty(true);
      }

      // Sync the draft from the store whenever the config changes externally
      // (initial load, save response, another tab writing) and nothing is dirty.
      React.useEffect(function () {
        if (snap.status === "ready" && snap.config && !dirtyRef.current) {
          setDraft(deepClone(snap.config));
          setHeadersTexts(headersTextsOf(snap.config));
          setSecretClear(new Set());
        }
      }, [snap.rev, snap.status, snap.config]);

      React.useEffect(function () {
        if (snap.status === "loading") store.load().catch(function () {});
      }, []);

      function runTest(channel, genericId, options) {
        var key = genericId === undefined ? channel : "generic:" + genericId;
        setTestResults(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = { status: "sending" };
          return next;
        });
        store.test(channel, genericId, options).then(function () {
          setTestResults(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { status: "ok" };
            return next;
          });
        }, function (error) {
          setTestResults(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { status: "error", error: String(error?.message ?? error) };
            return next;
          });
        });
      }

      /** Enable/disable the native OS notification toggle, requesting browser
       * permission from the click gesture when turning it on. */
      function toggleNative(value) {
        setNativeError(null);
        if (!value) {
          update(function (next) { next.browser.native = false; });
          return;
        }
        requestNativePermission().then(function (granted) {
          if (granted) {
            update(function (next) { next.browser.native = true; });
          } else {
            setNativeError(nativeSupported() ? t("nativePermissionDenied") : t("nativeUnsupported"));
          }
        });
      }

      function testBrowser() {
        var key = "browser";
        setTestResults(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = { status: "sending" };
          return next;
        });
        if (draft?.browser?.toast !== false && toastStore) {
          fireBrowserNotification({ title: TEST_TITLE, body: TEST_BODY }, toastStore);
        }
        // Keep the "sending" state visible for a moment (React batches state
        // updates, so an immediate ok would never render) — the indicator
        // disappearing and reappearing is the click feedback.
        window.setTimeout(function () {
          setTestResults(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { status: "ok" };
            return next;
          });
        }, 400);
      }

      /** Send one native OS notification as the 系统原生通知 channel test. */
      function testNative() {
        var key = "native";
        setTestResults(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = { status: "sending" };
          return next;
        });
        requestNativePermission().then(function (granted) {
          var error = granted ? null : (nativeSupported() ? t("nativePermissionDenied") : t("nativeUnsupported"));
          if (granted) {
            fireNativeNotification(TEST_TITLE, TEST_BODY, "dsh-plugin-notify-test-" + Date.now().toString(36));
          } else {
            setNativeError(error);
          }
          window.setTimeout(function () {
            setTestResults(function (prev) {
              var next = Object.assign({}, prev);
              next[key] = granted ? { status: "ok" } : { status: "error", error: error };
              return next;
            });
          }, 350);
        });
      }

      function onSave() {
        if (draft === null || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setSaveError(null);
        var next = deepClone(draft);
        var invalid = null;
        for (var i = 0; i < next.webhooks.generic.length; i += 1) {
          var text = (headersTexts[i] ?? "").trim();
          if (text === "") { next.webhooks.generic[i].headers = {}; continue; }
          try {
            var parsed = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("headers 必须是 JSON 对象");
            next.webhooks.generic[i].headers = parsed;
          } catch (error) {
            invalid = "通用 webhook #" + (i + 1) + "：" + String(error?.message ?? error);
            break;
          }
        }
        if (invalid !== null) {
          savingRef.current = false;
          setSaving(false);
          setSaveError(invalid);
          return;
        }
        store.save(next, Array.from(secretClear)).then(function (config) {
          savingRef.current = false;
          setSaving(false);
          setDirty(false);
          setSaved(true);
        }, function (error) {
          savingRef.current = false;
          setSaving(false);
          setSaveError(String(error?.message ?? error));
        });
      }

      if (snap.status === "loading") return el("div", { className: "dsh-plugin-notify" }, t("loading"));
      if (snap.status === "error") {
        return el("div", { className: "dsh-plugin-notify" },
          el("div", { className: "dsh-plugin-notify-error" }, format(t, "loadError", { error: snap.error })),
          el("button", { className: "dsh-plugin-notify-button", onClick: function () { store.load(); } }, t("retry")));
      }
      if (draft === null) return el("div", { className: "dsh-plugin-notify" }, t("loading"));

      var triggers = draft.triggers;
      var browser = draft.browser;
      var system = draft.system;
      var webhooks = draft.webhooks;

      return el("div", { className: "dsh-plugin-notify" },
        el("div", { className: "dsh-plugin-notify-header" },
          el("div", { className: "dsh-plugin-notify-headerRow" },
            el("h2", { className: "dsh-plugin-notify-title" }, t("nav")),
            saving ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-info" }, t("saving")) : null,
            saveError ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-error" }, format(t, "saveError", { error: saveError })) : null,
            saved ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-success" }, t("saved")) : null,
            dirty ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-warn" }, t("unsaved")) : null),
          el("p", { className: "dsh-plugin-notify-intro" }, t("headerDesc"))),
        el("div", { className: "dsh-plugin-notify-content" },
        el(Card, { title: t("triggers") },
          el(Toggle, {
            label: t("triggerTurnEnd"),
            hint: t("triggerTurnEndHint"),
            checked: triggers.turnEnd,
            onChange: function (value) { update(function (next) { next.triggers.turnEnd = value; }); },
          }),
          triggers.turnEnd ? el("div", { className: "dsh-plugin-notify-row" },
            TURN_END_KINDS.map(function (kind) {
              var checked = triggers.turnEndKinds.includes(kind);
              var lastOne = checked && triggers.turnEndKinds.length === 1;
              return el("span", { className: "dsh-plugin-notify-kind", key: kind },
                el("input", {
                  type: "checkbox",
                  checked: checked,
                  disabled: lastOne,
                  onChange: function (event) {
                    update(function (next) {
                      var kinds = next.triggers.turnEndKinds;
                      if (event.target.checked && !kinds.includes(kind)) kinds.push(kind);
                      if (!event.target.checked) {
                        next.triggers.turnEndKinds = kinds.filter(function (entry) { return entry !== kind; });
                      }
                    });
                  },
                }),
                el("span", null, t("kind_" + kind)));
            })) : null,
          el(Toggle, {
            label: t("triggerApproval"),
            hint: t("triggerApprovalHint"),
            checked: triggers.approval,
            onChange: function (value) { update(function (next) { next.triggers.approval = value; }); },
          })),
        el(Card, {
          title: t("browser"),
          hint: t("browserHint"),
          right: el(Switch, {
            label: t("browserEnabled"),
            checked: browser.enabled,
            onChange: function (value) { update(function (next) { next.browser.enabled = value; }); },
          }),
        },
          el(Toggle, {
            label: t("browserToast"),
            hint: t("browserToastHint"),
            checked: browser.toast !== false,
            onChange: function (value) { update(function (next) { next.browser.toast = value; }); },
          }),
          el("div", { className: "dsh-plugin-notify-actions" },
            el("button", {
              className: "dsh-plugin-notify-button",
              disabled: testResults.browser && testResults.browser.status === "sending",
              onClick: testBrowser,
            }, testResults.browser && testResults.browser.status === "sending" ? t("testSending") : t("testBrowser")),
            testResults.browser && testResults.browser.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testOk")) : null)),
        el(Card, {
          title: t("browserNative"),
          hint: t("browserNativeHint"),
          right: el(Switch, {
            label: t("nativeEnabled"),
            checked: browser.native === true,
            onChange: toggleNative,
          }),
        },
          nativeError ? el("div", { className: "dsh-plugin-notify-error" }, nativeError) : null,
          browser.native === true && !nativePermissionGranted() ? el("div", { className: "dsh-plugin-notify-hint" }, t("nativePermissionDenied")) : null,
          el("div", { className: "dsh-plugin-notify-actions" },
            el("button", {
              className: "dsh-plugin-notify-button",
              disabled: testResults.native && testResults.native.status === "sending",
              onClick: testNative,
            }, testResults.native && testResults.native.status === "sending" ? t("testSending") : t("testNative")),
            testResults.native && testResults.native.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testOk")) : null,
            testResults.native && testResults.native.status === "error" ? el("span", { className: "dsh-plugin-notify-error" }, format(t, "testFailed", { error: testResults.native.error })) : null)),
        el(Card, {
          title: t("system"),
          hint: t("systemHint"),
          right: el(Switch, {
            label: t("systemEnabled"),
            checked: system.enabled,
            onChange: function (value) { update(function (next) { next.system.enabled = value; }); },
          }),
        },
          el(Toggle, {
            label: t("systemSound"),
            checked: system.sound,
            onChange: function (value) { update(function (next) { next.system.sound = value; }); },
          }),
          el("div", { className: "dsh-plugin-notify-actions" },
            el("button", {
              className: "dsh-plugin-notify-button",
              disabled: testResults.system && testResults.system.status === "sending",
              onClick: function () { runTest("system", undefined, { sound: system.sound }); },
            }, testResults.system && testResults.system.status === "sending" ? t("testSending") : t("test")),
            testResults.system && testResults.system.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testOk")) : null,
            testResults.system && testResults.system.status === "error" ? el("span", { className: "dsh-plugin-notify-error" }, format(t, "testFailed", { error: testResults.system.error })) : null)),
        el(WebhookCard, {
          id: "feishu",
          title: t("feishu"),
          hint: t("webhookUrlHint"),
          t: t,
          draft: draft,
          update: update,
          webhook: webhooks.feishu,
          test: runTest,
          testResults: testResults,
          secretSet: snap.secretSet,
          secretClear: secretClear,
          setSecretClear: setSecretClear,
        }),
        el(WebhookCard, {
          id: "dingtalk",
          title: t("dingtalk"),
          hint: t("webhookUrlHint"),
          t: t,
          draft: draft,
          update: update,
          webhook: webhooks.dingtalk,
          test: runTest,
          testResults: testResults,
          secretSet: snap.secretSet,
          secretClear: secretClear,
          setSecretClear: setSecretClear,
        }),
        el(WebhookCard, {
          id: "wecom",
          title: t("wecom"),
          hint: t("webhookUrlHint"),
          t: t,
          draft: draft,
          update: update,
          webhook: webhooks.wecom,
          test: runTest,
          testResults: testResults,
          secretSet: snap.secretSet,
          secretClear: secretClear,
          setSecretClear: setSecretClear,
        }),
        el(GenericWebhookCard, {
          t: t,
          draft: draft,
          update: update,
          test: runTest,
          testResults: testResults,
          headersTexts: headersTexts,
          setHeadersTexts: setHeadersTexts,
        })),
        el("div", { className: "dsh-plugin-notify-footer" },
          el("button", { className: "dsh-plugin-notify-button", onClick: onSave }, saving ? t("saving") : t("save"))));
    }

    // ── plugin ─────────────────────────────────────────────────────────────

    var inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, DICT);
      }, "dsh-plugin-notify: locale");

      var store = createStore();
      var toastStore = createToastStore();
      var t = ctx.locale.bind(NS);

      ctx.effect(function () {
        return startEngine(ctx, store, toastStore, t);
      }, "dsh-plugin-notify: notification engine");

      var slots = ctx.get("slots");
      if (slots !== undefined) {
        slots.inject("shell.overlay", function () {
          return slots.register({
            name: "shell.overlay",
            id: "dsh-plugin-notify-toast",
            order: 500,
            inject: function () { return { toastStore: toastStore }; },
          }, ToastHost);
        });
        slots.inject("settings.section", function () {
          return slots.register({
            name: "settings.section",
            id: "dsh-plugin-notify",
            order: 70,
            locale: NS,
            label: function () { return t("nav"); },
            inject: function () { return { store: store, toastStore: toastStore }; },
          }, NotifySection);
        });
      }
    }

    exports.apply = apply;
    exports.name = "dsh-plugin-notify";
    exports.inject = inject;
    return module.exports;
  },
});
