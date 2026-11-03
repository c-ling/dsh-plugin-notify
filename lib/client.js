/**
 * dsh-plugin-notify client half: the browser bundle (factory-CJS, hand-written,
 * no build step). Target: DeepSeek Harness 0.2.1+ (Web and Desktop).
 *
 * Registers two slot contributions:
 *
 *   - settings.section: the "消息提醒" page — triggers, browser/desktop
 *     notifications, host system notifications, Feishu/DingTalk/WeCom/generic
 *     webhooks, per-channel tests and save.
 *   - shell.overlay: the in-page toast banner stack.
 *
 * The notification engine runs outside the settings page. It subscribes to
 * `sessions.list` (titles, running, current) and
 * `uiSession.sessionStatus` (running + pendingInteraction), then notifies on
 * running true→false and on a new pending approval/question. Turn-end
 * transitions fetch the host's bounded notification journal
 * (`GET /api/dsh-plugin-notify/last`) so the exact end kind is available and
 * the host's `turnEndKinds` filter is honored.
 *
 * Config comes from the host via authenticated exact Fetch routes under
 * `/api/dsh-plugin-notify/...`. Desktop detection uses the preload's
 * `html[data-platform]` marker; Electron grants Notification permission for
 * the app window, so desktop notifications need no browser prompt.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-notify",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var ReactDOM = require("react-dom");

    var NS = "dsh-plugin-notify";
    var API_PREFIX = "/api/dsh-plugin-notify";

    // ── css ────────────────────────────────────────────────────────────────

    (function injectCss() {
      if (document.querySelector('style[data-plugin="dsh-plugin-notify"]')) return;
      var style = document.createElement("style");
      style.setAttribute("data-plugin", "dsh-plugin-notify");
      style.setAttribute("data-pluginCss", "dsh-plugin-notify");
      style.textContent = [
        ".dsh-plugin-notify{display:flex;flex-direction:column;gap:12px;width:100%;max-width:640px;min-height:240px;height:calc(100% + 24px);margin-bottom:-24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}",
        ".dsh-plugin-notify-header{flex:none;display:flex;flex-direction:column;gap:6px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1);}",
        ".dsh-plugin-notify-headerRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-plugin-notify-title{color:var(--dsw-alias-label-primary);margin:0;font-size:20px;font-weight:500;line-height:28px;}",
        ".dsh-plugin-notify-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px;}",
        ".dsh-plugin-notify-tag{display:inline-block;font-size:11px;line-height:1.2;padding:3px 8px;border-radius:999px;font-weight:500;background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14));max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        ".dsh-plugin-notify-tag-warn{color:var(--dsw-alias-state-warn-primary,#b7791f);}",
        ".dsh-plugin-notify-tag-success{color:var(--dsw-alias-state-success-primary,#3c9a5f);}",
        ".dsh-plugin-notify-tag-error{color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-plugin-notify-tag-info{color:var(--dsw-alias-label-secondary,inherit);}",
        ".dsh-plugin-notify-platform{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;line-height:1.2;padding:3px 8px;border-radius:999px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.14));}",
        ".dsh-plugin-notify-summary{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
        ".dsh-plugin-notify-summaryLabel{font-size:12px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-plugin-notify-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;line-height:1.2;padding:3px 8px;border-radius:999px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}",
        ".dsh-plugin-notify-chip-on{color:var(--dsw-alias-state-business-primary,#4176e6);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.16));}",
        ".dsh-plugin-notify-content{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:0 8px 0 2px;margin-right:-8px;scrollbar-width:thin;}",
        ".dsh-plugin-notify-content::-webkit-scrollbar{width:8px;background:transparent;}",
        ".dsh-plugin-notify-content::-webkit-scrollbar-thumb{background:transparent;border-radius:4px;}",
        ".dsh-plugin-notify-content:hover::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.45));}",
        ".dsh-plugin-notify-footer{flex:none;padding:15px 2px;display:flex;flex-direction:column;align-items:stretch;gap:8px;background:var(--dsw-alias-bg-layer-2,#fff);border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.22));}",
        ".dsh-plugin-notify-footer .dsh-plugin-notify-button{box-sizing:border-box;width:100%;height:36px;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#111417));color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:var(--dsw-radius-md,8px);padding:0 14px;font-size:14px;line-height:22px;font-weight:500;display:inline-flex;align-items:center;justify-content:center;}",
        ".dsh-plugin-notify-footer .dsh-plugin-notify-button:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#111417));}",
        ".dsh-plugin-notify-footer .dsh-plugin-notify-button:disabled{opacity:.4;cursor:not-allowed;}",
        ".dsh-plugin-notify-toast-stack{position:fixed;top:var(--dsh-frame-overlay-top,20px);right:max(20px,env(safe-area-inset-right));display:flex;flex-direction:column;gap:10px;z-index:1200;width:min(420px,calc(100vw - 40px));pointer-events:none;}",
        ".dsh-plugin-notify-toast{pointer-events:auto;position:relative;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#fff));border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.25));border-left:4px solid var(--dsw-alias-state-business-primary,#4176e6);border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:14px 18px 14px 16px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;animation:dsh-plugin-notify-toast-in .22s ease-out;}",
        ".dsh-plugin-notify-toast[data-kind=\"completed\"]{border-left-color:var(--dsw-alias-state-success-primary,#46a758);}",
        ".dsh-plugin-notify-toast[data-kind=\"error\"]{border-left-color:var(--dsw-alias-state-error-primary,#e5484d);}",
        ".dsh-plugin-notify-toast[data-kind=\"aborted\"],.dsh-plugin-notify-toast[data-kind=\"max-tokens\"],.dsh-plugin-notify-toast[data-kind=\"interrupted\"]{border-left-color:var(--dsw-alias-state-warn-primary,#b7791f);}",
        ".dsh-plugin-notify-toast[data-kind=\"approval\"],.dsh-plugin-notify-toast[data-kind=\"question\"]{border-left-color:var(--dsw-alias-state-warn-primary,#b7791f);}",
        "@keyframes dsh-plugin-notify-toast-in{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:none}}",
        ".dsh-plugin-notify-toast-head{display:flex;align-items:center;gap:8px;padding-right:24px;}",
        ".dsh-plugin-notify-toast-title{font-weight:600;font-size:15px;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
        ".dsh-plugin-notify-toast-kind{flex:none;font-size:10px;line-height:1.2;padding:2px 7px;border-radius:999px;font-weight:500;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.16));}",
        ".dsh-plugin-notify-toast-body{font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit);white-space:pre-wrap;overflow-wrap:anywhere;}",
        ".dsh-plugin-notify-toast-meta{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-plugin-notify-toast-close{position:absolute;top:8px;right:8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font-size:16px;line-height:1;padding:4px 7px;border-radius:8px;}",
        ".dsh-plugin-notify-toast-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));}",
        ".dsh-plugin-notify-card{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:transparent;border-radius:var(--dsw-radius-lg,12px);padding:16px;display:flex;flex-direction:column;gap:12px;position:relative;}",
        ".dsh-plugin-notify-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}",
        ".dsh-plugin-notify-card-title{min-width:0;display:flex;flex-direction:column;gap:2px;}",
        ".dsh-plugin-notify-card-right{flex:none;display:flex;align-items:center;gap:8px;}",
        ".dsh-plugin-notify-switch{position:relative;flex:none;width:40px;height:22px;border-radius:999px;border:none;padding:0;background:var(--dsw-alias-border-l2,rgba(128,128,128,.42));cursor:pointer;transition:background .15s ease;}",
        ".dsh-plugin-notify-switch:hover:not(:disabled){background:var(--dsw-alias-border-l3,rgba(128,128,128,.6));}",
        ".dsh-plugin-notify-switch-on,.dsh-plugin-notify-switch-on:hover:not(:disabled){background:var(--dsw-alias-state-business-primary,#4176e6);}",
        ".dsh-plugin-notify-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px;}",
        ".dsh-plugin-notify-switch:disabled{opacity:.5;cursor:default;}",
        ".dsh-plugin-notify-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(15,23,42,.25);transition:transform .15s ease;}",
        ".dsh-plugin-notify-switch-on .dsh-plugin-notify-switch-knob{transform:translateX(18px);}",
        ".dsh-plugin-notify-card h3{margin:0;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary);}",
        ".dsh-plugin-notify-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
        ".dsh-plugin-notify-row > label{flex:1 1 220px;min-width:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}",
        ".dsh-plugin-notify-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 16px;}",
        ".dsh-plugin-notify-field{display:flex;flex-direction:column;gap:4px;}",
        ".dsh-plugin-notify-field > span:first-child{font-size:12px;color:var(--dsw-alias-label-secondary,inherit);}",
        ".dsh-plugin-notify-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2,rgba(128,128,128,.35)));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px;transition:border-color .15s ease;}",
        ".dsh-plugin-notify-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2,rgba(128,128,128,.35)));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;resize:vertical;}",
        ".dsh-plugin-notify-input:focus,.dsh-plugin-notify-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6);}",
        ".dsh-plugin-notify-input::placeholder,.dsh-plugin-notify-textarea::placeholder{color:var(--dsw-alias-label-dimmed,rgba(128,128,128,.6));}",
        ".dsh-plugin-notify-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.6));}",
        ".dsh-plugin-notify-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}",
        ".dsh-plugin-notify-button{box-sizing:border-box;height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary,inherit);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s ease,border-color .15s ease;}",
        ".dsh-plugin-notify-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));border-color:var(--dsw-alias-border-l3,rgba(128,128,128,.8));}",
        ".dsh-plugin-notify-button:disabled{opacity:.4;cursor:not-allowed;}",
        ".dsh-plugin-notify-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;}",
        ".dsh-plugin-notify-ok{color:var(--dsw-alias-state-success-primary,#46a758);font-size:12px;}",
        ".dsh-plugin-notify-kind{display:inline-flex;align-items:center;gap:6px;margin-right:12px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}",
        ".dsh-plugin-notify-row input[type=checkbox],.dsh-plugin-notify-kind input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary,#4176e6);}",
        ".dsh-plugin-notify-generic-item{border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.35));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:8px;}",
        ".dsh-plugin-notify-generic-header{display:flex;align-items:center;justify-content:space-between;gap:12px;}",
        ".dsh-plugin-notify-generic-header-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);}",
        ".dsh-plugin-notify-add-button{box-sizing:border-box;width:100%;height:36px;font-family:inherit;cursor:pointer;border:1px dashed var(--dsw-alias-border-l3,rgba(128,128,128,.4));border-radius:var(--dsw-radius-md,8px);justify-content:center;align-items:center;gap:6px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;color:var(--dsw-alias-label-primary,inherit);background:transparent;}",
        ".dsh-plugin-notify-add-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1));}",
        ".dsh-plugin-notify-plus{font-size:14px;line-height:1;font-weight:500;margin-right:2px;}",
        ".dsh-plugin-notify-generic-item + .dsh-plugin-notify-generic-item{margin-top:8px;}",
        ".dsh-plugin-notify-recommended{font-size:10px;line-height:1.2;padding:2px 6px;border-radius:999px;font-weight:500;color:var(--dsw-alias-state-business-primary,#4176e6);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(128,128,128,.16));}",
        ".dsh-plugin-notify-permission{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary);}",
        ".dsh-plugin-notify-permission-hint{color:var(--dsw-alias-state-warn-primary,#b7791f);}",
        "@media (prefers-reduced-motion:reduce){.dsh-plugin-notify-toast{animation:none;}}",
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
        renderError: "消息提醒页面渲染失败",
        renderErrorHint: "请查看控制台错误详情",
        storeUnavailable: "通知配置存储不可用（插件注入失败）",
        retry: "重试",
        save: "保存",
        saving: "保存中…",
        saved: "已保存",
        unsaved: "有未保存的更改",
        saveError: "保存失败：{error}",
        staleConfig: "配置已在其他窗口更新，请重新加载后再保存。",
        reload: "重新加载",
        platformWeb: "Web",
        platformDesktop: "桌面端",
        summaryTitle: "当前渠道",
        summaryToasts: "页面横幅",
        summaryNative: "原生通知",
        summarySystem: "系统通知",
        summaryWebhooks: "群机器人 {count}",
        summaryNone: "未启用任何渠道",
        triggers: "触发条件",
        triggerTurnEnd: "任务回合结束时提醒",
        triggerTurnEndHint: "按回合结束原因过滤（可多选）",
        triggerApproval: "等待用户确认时提醒",
        triggerApprovalHint: "工具调用需要审批、或等待用户输入时提醒",
        kind_completed: "正常完成",
        kind_blocked: "目标阻塞",
        kind_aborted: "已中止",
        kind_error: "出错",
        kind_maxTokens: "输出达到上限",
        kind_interrupted: "已中断",
        browser: "页面内提醒",
        browserHint: "页面可见时在右上角弹出文字横幅；与桌面/浏览器系统通知相互独立",
        browserEnabled: "启用页面内提醒",
        browserToast: "页面内横幅",
        browserToastHint: "任务结束或等待确认时在右上角弹出文字横幅（不依赖系统通知权限）",
        nativeDesktop: "桌面通知",
        nativeDesktopHint: "通过 Electron 通知中心发送；窗口隐藏到后台或最小化时仍会提醒，桌面端无需浏览器授权",
        nativeWeb: "浏览器系统通知",
        nativeWebHint: "通过浏览器 Notification API 调用操作系统通知，标签页在后台时也能弹出（需要浏览器通知权限）",
        nativeEnabled: "启用桌面通知",
        nativeEnabledWeb: "启用浏览器系统通知",
        nativeRecommended: "推荐开启",
        nativePermissionDenied: "通知权限未授予。请在浏览器站点设置中允许本站通知后重试。",
        nativePermissionDeniedDesktop: "桌面通知权限未授予。请在 系统设置 → 通知 → DeepSeek Harness 中允许通知后重试。",
        desktopPermissionHint: "若「测试通知」无法弹出，请检查系统设置是否允许 DeepSeek Harness 发送通知。",
        openSystemSettings: "打开系统通知设置",
        nativeUnsupported: "当前环境不支持系统原生通知",
        permissionGranted: "已授权",
        permissionDefault: "未授权",
        permissionDenied: "已拒绝",
        requestPermission: "请求权限",
        testBrowser: "测试横幅",
        testNative: "测试通知",
        system: "宿主系统通知",
        systemHint: "通过宿主机发送，浏览器关闭也能收到（macOS / Linux / Windows）",
        systemDesktopHint: "桌面端建议优先使用桌面通知；宿主系统通知通过系统命令发送，两者同时开启可能重复",
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
        testNativeOk: "测试通知已提交；若未弹出，请检查系统通知设置。",
        testFailed: "测试失败：{error}",
        testTitle: "DSH · 通知测试",
        testBody: "这是一条来自 DeepSeek Harness 的测试消息，渠道工作正常。",
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
        close: "关闭",
        openSession: "打开会话",
        toastAria: "通知",
        nativeTitleTurnEnd: "DSH · 任务结束",
        nativeTitleApproval: "DSH · 等待确认",
        nativeTitleQuestion: "DSH · 等待回答",
        turnEndBody: "「{title}」回合已结束。",
        turnEndBodyKind: "「{title}」{kind}。",
        turnEndFallback: "会话 {id} 回合已结束。",
        approvalBody: "「{title}」需要确认：{toolName}",
        approvalFallback: "会话 {id} 需要确认：{toolName}",
        questionBody: "「{title}」等待你的回答：{text}",
        questionFallback: "会话 {id} 等待你的回答：{text}",
        labelApproval: "等待确认",
        labelQuestion: "等待回答",
        toolFallback: "工具调用",
        questionFallbackText: "问题",
        "errors.body-too-large": "请求体过大",
        "errors.invalid-json": "请求内容不是合法 JSON",
        "errors.invalid-config": "配置格式无效",
        "errors.stale-config": "配置已在其他窗口更新",
        "errors.internal": "内部错误",
        "errors.storage-failed": "配置保存失败",
        "errors.system-unsupported": "当前平台不支持系统通知",
        "errors.channel-not-configured": "该渠道尚未配置",
        "errors.channel-failed": "渠道发送失败",
        "errors.unknown-channel": "未知渠道",
        "errors.invalid-url": "Webhook 地址必须是 http(s) URL",
        "errors.network": "网络请求失败",
        "errors.system-settings-failed": "无法打开系统通知设置",
        "errors.unauthorized": "未连接或登录已失效，请刷新页面",
        refreshError: "刷新失败：{error}",
      },
      en: {
        nav: "Notifications",
        headerDesc: "Notify across your selected channels when a task turn ends or execution waits for your confirmation",
        loading: "Loading…",
        loadError: "Failed to load notification config: {error}",
        renderError: "Notifications page failed to render",
        renderErrorHint: "See the console for error details",
        storeUnavailable: "Notification config store unavailable (plugin injection failed)",
        retry: "Retry",
        save: "Save",
        saving: "Saving…",
        saved: "Saved",
        unsaved: "Unsaved changes",
        saveError: "Save failed: {error}",
        staleConfig: "The config changed in another window. Reload before saving again.",
        reload: "Reload",
        platformWeb: "Web",
        platformDesktop: "Desktop",
        summaryTitle: "Channels",
        summaryToasts: "Banner",
        summaryNative: "Native",
        summarySystem: "System",
        summaryWebhooks: "Bots {count}",
        summaryNone: "No channel enabled",
        triggers: "Triggers",
        triggerTurnEnd: "Notify when a task turn ends",
        triggerTurnEndHint: "Filter by end reason (multi-select)",
        triggerApproval: "Notify when waiting for user confirmation",
        triggerApprovalHint: "Tool approvals and interactive questions",
        kind_completed: "Completed",
        kind_blocked: "Goal blocked",
        kind_aborted: "Aborted",
        kind_error: "Error",
        kind_maxTokens: "Output limit reached",
        kind_interrupted: "Interrupted",
        browser: "In-page reminders",
        browserHint: "Show a text banner in the top-right while the page is visible; independent of desktop/system notifications",
        browserEnabled: "Enable in-page reminders",
        browserToast: "In-page banner",
        browserToastHint: "Show a text banner in the top-right corner on turn end or pending confirmation (no OS permission needed)",
        nativeDesktop: "Desktop notifications",
        nativeDesktopHint: "Sent by the Electron notification center; works while the window is hidden or minimized, with no browser permission prompt",
        nativeWeb: "Browser system notifications",
        nativeWebHint: "Uses the browser Notification API to show an OS notification, even while the tab is in the background (requires browser notification permission)",
        nativeEnabled: "Enable desktop notifications",
        nativeEnabledWeb: "Enable browser system notifications",
        nativeRecommended: "Recommended",
        nativePermissionDenied: "Notification permission not granted. Allow notifications for this site in your browser settings, then try again.",
        nativePermissionDeniedDesktop: "Desktop notification permission is not granted. Allow notifications for DeepSeek Harness in System Settings → Notifications, then try again.",
        desktopPermissionHint: "If the test notification does not appear, check that system settings allow DeepSeek Harness to send notifications.",
        openSystemSettings: "Open system notification settings",
        nativeUnsupported: "Native OS notifications are not supported in this environment",
        permissionGranted: "Granted",
        permissionDefault: "Not granted",
        permissionDenied: "Denied",
        requestPermission: "Request permission",
        testBrowser: "Test banner",
        testNative: "Test notification",
        system: "Host system notifications",
        systemHint: "Sent by the host process; works even with the browser closed (macOS / Linux / Windows)",
        systemDesktopHint: "Prefer desktop notifications on Desktop; host system notifications use OS commands and may duplicate them",
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
        testNativeOk: "Test notification submitted; if it does not appear, check system notification settings.",
        testFailed: "Test failed: {error}",
        testTitle: "DSH · Notification test",
        testBody: "This is a test message from DeepSeek Harness; the channel is working.",
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
        close: "Close",
        openSession: "Open session",
        toastAria: "Notification",
        nativeTitleTurnEnd: "DSH · Task finished",
        nativeTitleApproval: "DSH · Waiting for confirmation",
        nativeTitleQuestion: "DSH · Waiting for an answer",
        turnEndBody: "「{title}」turn finished.",
        turnEndBodyKind: "「{title}」{kind}.",
        turnEndFallback: "Session {id} turn finished.",
        approvalBody: "「{title}」needs confirmation: {toolName}",
        approvalFallback: "Session {id} needs confirmation: {toolName}",
        questionBody: "「{title}」is waiting for your answer: {text}",
        questionFallback: "Session {id} is waiting for your answer: {text}",
        labelApproval: "Confirmation",
        labelQuestion: "Answer needed",
        toolFallback: "a tool",
        questionFallbackText: "a question",
        "errors.body-too-large": "Request body is too large",
        "errors.invalid-json": "Request content is not valid JSON",
        "errors.invalid-config": "Invalid config shape",
        "errors.stale-config": "Config changed in another window",
        "errors.internal": "Internal error",
        "errors.storage-failed": "Could not save config",
        "errors.system-unsupported": "System notifications are not supported on this platform",
        "errors.channel-not-configured": "This channel is not configured",
        "errors.channel-failed": "Channel delivery failed",
        "errors.unknown-channel": "Unknown channel",
        "errors.invalid-url": "Webhook URL must be http(s)",
        "errors.network": "Network request failed",
        "errors.system-settings-failed": "Could not open system notification settings",
        "errors.unauthorized": "Not connected or session expired; refresh the page",
        refreshError: "Refresh failed: {error}",
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

    function errorText(t, error) {
      var code = error && error.code;
      if (typeof code === "string") {
        var text = t("errors." + code);
        if (text !== "errors." + code) {
          return error.detail ? text + "：" + error.detail : text;
        }
      }
      return String(error?.detail ?? error?.message ?? error);
    }

    function makeError(code, message, detail) {
      var error = new Error(message || code);
      error.code = code;
      if (detail !== undefined) error.detail = detail;
      return error;
    }

    function shortId(value) {
      var id = typeof value === "string" ? value : "?";
      var suffix = id.split("-").pop();
      return suffix !== undefined && suffix !== "" ? suffix.slice(0, 8) : id.slice(0, 8);
    }

    function clockTime() {
      var now = new Date();
      var pad = function (value) { return String(value).padStart(2, "0"); };
      return pad(now.getHours()) + ":" + pad(now.getMinutes());
    }

    var TURN_END_KINDS = ["completed", "blocked", "aborted", "error", "max-tokens", "interrupted"];

    function kindKey(kind) {
      if (kind === "max-tokens") return "kind_maxTokens";
      if (kind === "interrupted") return "kind_interrupted";
      return "kind_" + kind;
    }

    function platformKind() {
      try {
        var value = document.documentElement?.dataset?.platform;
        if (typeof value === "string" && value !== "") return value;
      } catch (error) {
        // ignore
      }
      if (typeof location !== "undefined" && location.protocol === "dsh-app:") return "desktop";
      if (typeof window !== "undefined" && window.dshDesktop && window.dshDesktop.protocolVersion === 1) return "desktop";
      return "web";
    }

    function isDesktop() {
      return platformKind() !== "web";
    }

    // ── config store ───────────────────────────────────────────────────────

    function createStore() {
      var listeners = new Set();
      var state = { status: "loading", config: null, secretSet: {}, revision: 0, meta: {}, error: null, rev: 0 };
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

      async function requestJson(path, options) {
        var res;
        try {
          res = await fetch(path, Object.assign({
            headers: { accept: "application/json" },
            cache: "no-store",
            signal: AbortSignal.timeout(8000),
          }, options));
        } catch (error) {
          throw makeError("network", String(error?.message ?? error));
        }
        var data = null;
        try {
          data = await res.json();
        } catch (error) {
          data = null;
        }
        if (!data || data.ok !== true) {
          var failure = makeError(
            data?.code ?? (res.status === 401 || res.status === 403 ? "unauthorized" : "internal"),
            data?.error || ("HTTP " + res.status),
            data?.detail,
          );
          failure.data = data;
          throw failure;
        }
        return data;
      }

      async function load() {
        if (loading) return loading;
        loading = (async () => {
          try {
            var data = await requestJson(API_PREFIX + "/config");
            setState({
              status: "ready",
              config: data.config,
              secretSet: data.secretSet ?? {},
              revision: Number.isInteger(data.revision) ? data.revision : 0,
              meta: data.meta ?? {},
              error: null,
            });
          } catch (error) {
            var message = String(error?.message ?? error);
            if (state.config !== null) {
              // A background refresh failure must not replace a usable form.
              setState({ error: message });
            } else {
              setState({ status: "error", error: message });
            }
          } finally {
            loading = null;
          }
        })();
        return loading;
      }

      async function save(draft, clearSecrets) {
        try {
          var data = await requestJson(API_PREFIX + "/config", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              config: draft,
              clearSecrets: clearSecrets ?? [],
              expectedRevision: state.revision,
            }),
          });
          setState({
            status: "ready",
            config: data.config,
            secretSet: data.secretSet ?? {},
            revision: Number.isInteger(data.revision) ? data.revision : state.revision,
            meta: data.meta ?? state.meta,
            error: null,
          });
          return data.config;
        } catch (error) {
          if (error && error.code === "stale-config" && error.data) {
            setState({
              status: "ready",
              config: error.data.config,
              secretSet: error.data.secretSet ?? state.secretSet,
              revision: Number.isInteger(error.data.revision) ? error.data.revision : state.revision,
              meta: error.data.meta ?? state.meta,
              error: null,
            });
          }
          throw error;
        }
      }

      async function test(channel, genericId, options) {
        var body = Object.assign({ channel }, genericId === undefined ? {} : { genericId: genericId }, options ?? {});
        return requestJson(API_PREFIX + "/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      async function lastMessage(sessionId, kinds) {
        var query = "?sessionId=" + encodeURIComponent(sessionId)
          + "&kinds=" + encodeURIComponent((kinds ?? []).join(","))
          + "&t=" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        return requestJson(API_PREFIX + "/last" + query, { signal: AbortSignal.timeout(1500) });
      }

      async function openSystemSettings() {
        return requestJson(API_PREFIX + "/system-settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      }

      return { subscribe, getSnapshot, load, save, test, lastMessage, openSystemSettings };
    }

    // ── native + browser notification ─────────────────────────────────────

    function nativeSupported() {
      return typeof Notification !== "undefined";
    }

    function nativePermission() {
      if (!nativeSupported()) return "unsupported";
      return Notification.permission;
    }

    function nativePermissionGranted() {
      return nativeSupported() && Notification.permission === "granted";
    }

    /** Resolve true only when the OS may show notifications from this window. */
    function requestNativePermission() {
      if (!nativeSupported()) return Promise.resolve(false);
      if (Notification.permission === "granted") return Promise.resolve(true);
      if (Notification.permission === "denied") return Promise.resolve(false);
      var request;
      try {
        var result = Notification.requestPermission();
        request = result && typeof result.then === "function"
          ? Promise.resolve(result).then(function (permission) { return permission === "granted"; }, function () { return false; })
          : Promise.resolve(result === "granted");
      } catch (error) {
        return Promise.resolve(false);
      }
      // Electron normally resolves immediately; never leave the test button
      // stuck on "sending" if the platform request never settles.
      return Promise.race([
        request,
        new Promise(function (resolve) {
          window.setTimeout(function () { resolve(false); }, 2000);
        }),
      ]);
    }

    // Keep live Notification objects referenced until they close; otherwise
    // Electron may collect the wrapper before the platform presents it.
    var activeNativeNotices = new Set();

    /** Fire one OS-level notification; silent no-op when permission is missing. */
    function fireNativeNotification(title, body, tag, onClick) {
      if (!nativePermissionGranted()) return false;
      try {
        // Deliberately no `tag`: every alert is a separate notification. A
        // shared tag replaces the previous alert on macOS/Windows.
        var notice = new Notification(String(title), { body: String(body ?? "") });
        activeNativeNotices.add(notice);
        if (activeNativeNotices.size > 20) {
          var oldest = activeNativeNotices.values().next().value;
          if (oldest !== undefined) activeNativeNotices.delete(oldest);
        }
        var release = function () { activeNativeNotices.delete(notice); };
        try {
          notice.onclose = release;
          notice.onerror = release;
        } catch (error) {
          // older Notification implementations may not expose these events
        }
        notice.onclick = function () {
          try { window.focus(); } catch (error) { /* ignore */ }
          if (typeof onClick === "function") {
            try { onClick(); } catch (error) { /* ignore */ }
          }
          release();
          try { notice.close(); } catch (error) { /* ignore */ }
        };
        if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
          window.setTimeout(release, 300000);
        }
        return true;
      } catch (error) {
        return false;
      }
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
        push(item) {
          var dedupeKey = (item.kind ?? "") + "|" + item.title + "|" + item.body;
          items = items.filter(function (entry) {
            return !(entry.dedupeKey === dedupeKey && Date.now() - entry.createdAt < 2000);
          });
          var id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          items = items.concat([Object.assign({}, item, {
            id: id,
            dedupeKey: dedupeKey,
            createdAt: Date.now(),
          })]).slice(-3);
          emit();
          window.setTimeout(function () {
            items = items.filter(function (entry) { return entry.id !== id; });
            emit();
          }, 8000);
        },
        dismiss(id) {
          items = items.filter(function (entry) { return entry.id !== id; });
          emit();
        },
      };
    }

    var EMPTY_STORE_SNAPSHOT = { status: "error", config: null, secretSet: {}, revision: 0, meta: {}, error: "store-unavailable", rev: 0 };
    var EMPTY_STORE = {
      subscribe: function () { return function () {}; },
      getSnapshot: function () { return EMPTY_STORE_SNAPSHOT; },
      load: function () { return Promise.resolve(); },
      save: function () { return Promise.reject(new Error("store-unavailable")); },
      test: function () { return Promise.reject(new Error("store-unavailable")); },
      lastMessage: function () { return Promise.resolve({ seq: 0, message: null, dispatched: false }); },
      openSystemSettings: function () { return Promise.reject(new Error("store-unavailable")); },
    };
    var EMPTY_TOAST_ITEMS = [];
    var EMPTY_TOAST_STORE = {
      subscribe: function () { return function () {}; },
      getSnapshot: function () { return EMPTY_TOAST_ITEMS; },
      push: function () {},
      dismiss: function () {},
    };

    function ToastHost(props) {
      var rawStore = props.toastStore;
      var store = rawStore && typeof rawStore.subscribe === "function" && typeof rawStore.getSnapshot === "function"
        ? rawStore
        : EMPTY_TOAST_STORE;
      var items = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
      var t = typeof props.t === "function"
        ? props.t
        : (typeof props.fallbackT === "function" ? props.fallbackT : function (key) { return key; });
      if (items.length === 0) return null;
      // Portal to <body>: the shell.overlay layer sits in a lower stacking
      // context than the settings modal; the banner must escape it.
      return ReactDOM.createPortal(el("div", {
        className: "dsh-plugin-notify-toast-stack",
        role: "region",
        "aria-label": t("toastAria"),
      },
        items.map(function (item) {
          var kind = item.kind ?? "turnEnd";
          var label = item.label ?? "";
          return el("div", {
            className: "dsh-plugin-notify-toast",
            key: item.id,
            "data-kind": kind,
            role: "status",
            "aria-live": "polite",
            title: item.sessionId === "" ? undefined : t("openSession"),
            onClick: function () { if (typeof item.onOpen === "function") item.onOpen(); store.dismiss(item.id); },
          },
            el("div", { className: "dsh-plugin-notify-toast-head" },
              label ? el("span", { className: "dsh-plugin-notify-toast-kind" }, label) : null,
              el("span", { className: "dsh-plugin-notify-toast-title" }, item.title)),
            el("div", { className: "dsh-plugin-notify-toast-body" }, item.body),
            el("div", { className: "dsh-plugin-notify-toast-meta" },
              (item.time ? item.time + " · " : "") + (item.sessionId === "" ? "" : t("openSession"))),
            el("button", {
              className: "dsh-plugin-notify-toast-close",
              type: "button",
              "aria-label": t("close"),
              onClick: function (event) {
                event.stopPropagation();
                store.dismiss(item.id);
              },
            }, "×"));
        })), document.body);
    }

    // ── session monitor + notification engine ──────────────────────────────

    function createSessionMonitor(ctx) {
      var listeners = new Set();
      var sessions = ctx.get("sessions");
      var uiSession = ctx.get("uiSession");
      var offs = [];
      var state = { sessions: new Map(), currentId: undefined };

      function build() {
        var list = sessions?.list?.getSnapshot?.();
        var status = uiSession?.sessionStatus?.getSnapshot?.();
        var pending = uiSession?.pendingInteractions?.getSnapshot?.();
        var byId = list?.byId ?? {};
        var statusMap = status instanceof Map ? status : new Map();
        var pendingMap = pending instanceof Map ? pending : new Map();
        var next = new Map();
        var ids = new Set(Object.keys(byId));
        for (var statusId of statusMap.keys()) ids.add(statusId);
        for (var pendingId of pendingMap.keys()) ids.add(pendingId);
        for (var id of ids) {
          var row = byId[id];
          var entry = statusMap.get(id);
          next.set(id, {
            running: entry ? entry.running === true : row?.running === true,
            pendingInteraction: entry?.pendingInteraction ?? pendingMap.get(id) ?? null,
            title: typeof row?.displayTitle === "string" && row.displayTitle !== "" ? row.displayTitle : shortId(id),
            current: list?.current === id,
          });
        }
        return { sessions: next, currentId: list?.current };
      }

      function refresh() {
        state = build();
        for (var listener of listeners) listener();
      }

      if (typeof sessions?.list?.subscribe === "function") offs.push(sessions.list.subscribe(refresh));
      if (typeof uiSession?.sessionStatus?.subscribe === "function") offs.push(uiSession.sessionStatus.subscribe(refresh));
      else if (typeof uiSession?.pendingInteractions?.subscribe === "function") offs.push(uiSession.pendingInteractions.subscribe(refresh));
      refresh();

      return {
        subscribe(listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        getSnapshot() {
          return state;
        },
        dispose() {
          for (var off of offs) {
            try { off(); } catch (error) { /* ignore */ }
          }
        },
      };
    }

    function questionTextOf(interaction) {
      var questions = interaction?.questions ?? interaction?.payload?.questions;
      if (!Array.isArray(questions)) return "";
      for (var entry of questions) {
        if (!entry || typeof entry !== "object") continue;
        var header = typeof entry.header === "string" ? entry.header.replace(/\s+/g, " ").trim() : "";
        var question = typeof entry.question === "string" ? entry.question.replace(/\s+/g, " ").trim() : "";
        if (header !== "" && question !== "") return header + "：" + question;
        if (header !== "") return header;
        if (question !== "") return question;
      }
      return "";
    }

    function startEngine(ctx, store, toastStore, t) {
      var monitor = createSessionMonitor(ctx);
      var prev = new Map();
      var seenSeq = new Map();
      var seenJournal = null;
      var retryAt = 0;

      function config() {
        return store.getSnapshot().config;
      }

      function ensureConfig() {
        var snapshot = store.getSnapshot();
        if (snapshot.config !== null) return;
        if (snapshot.status !== "loading" && snapshot.status !== "error") return;
        if (Date.now() < retryAt) return;
        retryAt = Date.now() + 5000;
        store.load().catch(function () {});
      }

      function openSession(sessionId) {
        if (typeof sessionId !== "string" || sessionId === "") return;
        try {
          resolveSessionOpener(ctx)?.(sessionId);
        } catch (error) {
          // session may have been removed
        }
      }

      function deliver(message) {
        var cfg = config();
        if (!cfg || !cfg.browser) return;
        var showToast = cfg.browser.enabled !== false && cfg.browser.toast !== false;
        var showNative = cfg.browser.native === true;
        if (!showToast && !showNative) return;
        var onOpen = function () { openSession(message.sessionId); };
        if (showNative) fireNativeNotification(message.title, message.body, message.tag, onOpen);
        if (!showToast) return;
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        toastStore.push({
          title: message.title,
          body: message.body,
          kind: message.kind,
          label: message.label,
          sessionId: message.sessionId,
          time: message.time,
          onOpen: onOpen,
        });
      }

      function sessionDisplayTitle(sessionId) {
        var entry = monitor.getSnapshot().sessions.get(sessionId);
        if (entry !== undefined && typeof entry.title === "string" && entry.title !== "") return entry.title;
        return shortId(sessionId);
      }

      function genericTurnEnd(sessionId) {
        return {
          title: t("nativeTitleTurnEnd"),
          body: format(t, "turnEndFallback", { id: sessionDisplayTitle(sessionId) }),
          kind: "turnEnd",
          label: "",
          sessionId: sessionId,
          time: clockTime(),
          tag: "dsh-plugin-notify-turn-" + sessionId + "-" + Date.now().toString(36),
        };
      }

      function notifyTurnEnd(sessionId) {
        var cfg = config();
        if (!cfg?.triggers || cfg.triggers.turnEnd === false) return;
        var settled = false;
        var send = function (message) {
          if (settled) return;
          settled = true;
          deliver(message);
        };
        store.lastMessage(sessionId, ["turnEnd"]).then(function (result) {
          if (settled) return;
          if (!result || !result.message) {
            send(genericTurnEnd(sessionId));
            return;
          }
          if (typeof result.journalId === "string" && result.journalId !== seenJournal) {
            seenJournal = result.journalId;
            seenSeq.clear();
          }
          var seq = Number(result.seq) || 0;
          if ((seenSeq.get(sessionId) ?? 0) >= seq) {
            send(genericTurnEnd(sessionId));
            return;
          }
          seenSeq.set(sessionId, seq);
          if (result.dispatched === false) {
            settled = true;
            return;
          }
          var message = result.message;
          var kind = typeof message.turnEndKind === "string" ? message.turnEndKind : "completed";
          var title = sessionDisplayTitle(sessionId);
          var label = t(kindKey(kind));
          var body = format(t, "turnEndBodyKind", { title: title, kind: label });
          if (typeof message.reason === "string" && message.reason !== "") body += "\n" + message.reason;
          send({
            title: t("nativeTitleTurnEnd"),
            body: body,
            kind: kind,
            label: label,
            sessionId: sessionId,
            time: message.time || clockTime(),
            tag: "dsh-plugin-notify-turn-" + sessionId + "-" + seq,
          });
        }, function () {
          send(genericTurnEnd(sessionId));
        });
      }

      function notifyPending(sessionId, interaction) {
        var cfg = config();
        if (!cfg?.triggers || cfg.triggers.approval === false) return;
        var kind = typeof interaction?.kind === "string" ? interaction.kind : "approval";
        var title = sessionDisplayTitle(sessionId);
        if (kind === "approval") {
          var toolName = typeof interaction?.toolName === "string" && interaction.toolName !== ""
            ? interaction.toolName
            : typeof interaction?.payload?.toolName === "string" ? interaction.payload.toolName : "";
          var reason = typeof interaction?.displayReason === "string" && interaction.displayReason !== ""
            ? interaction.displayReason
            : typeof interaction?.reason === "string" ? interaction.reason : "";
          deliver({
            title: t("nativeTitleApproval"),
            body: toolName === ""
              ? format(t, "approvalFallback", { id: title, toolName: t("toolFallback") })
              : format(t, "approvalBody", { title: title, toolName: toolName }) + (reason === "" ? "" : "\n" + reason),
            kind: "approval",
            label: t("labelApproval"),
            sessionId: sessionId,
            time: clockTime(),
            tag: "dsh-plugin-notify-approval-" + sessionId + "-" + Date.now().toString(36),
          });
          return;
        }
        var text = questionTextOf(interaction);
        deliver({
          title: t("nativeTitleQuestion"),
          body: text === ""
            ? format(t, "questionFallback", { id: title, text: t("questionFallbackText") })
            : format(t, "questionBody", { title: title, text: text }),
          kind: kind,
          label: t("labelQuestion"),
          sessionId: sessionId,
          time: clockTime(),
          tag: "dsh-plugin-notify-question-" + sessionId + "-" + Date.now().toString(36),
        });
      }

      function handle(snapshot) {
        var cfg = config();
        if (!cfg) {
          ensureConfig();
          return;
        }
        var sessions = snapshot.sessions;
        for (var entry of sessions) {
          var sessionId = entry[0];
          var value = entry[1];
          var previous = prev.get(sessionId);
          if (previous !== undefined) {
            if (previous.running && !value.running) notifyTurnEnd(sessionId);
            var pending = value.pendingInteraction;
            var pendingKey = pending && typeof pending.key === "string" ? pending.key : "";
            if (pendingKey !== "" && pendingKey !== previous.pendingKey) notifyPending(sessionId, pending);
          }
          prev.set(sessionId, { running: value.running, pendingKey: value.pendingInteraction?.key ?? "" });
        }
        for (var id of prev.keys()) if (!sessions.has(id)) prev.delete(id);
      }

      var off = monitor.subscribe(function () { handle(monitor.getSnapshot()); });
      handle(monitor.getSnapshot());

      return function () {
        off();
        monitor.dispose();
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
        out[generic[i].id] = generic[i].headers && Object.keys(generic[i].headers).length > 0
          ? JSON.stringify(generic[i].headers, null, 2)
          : "";
      }
      return out;
    }

    function WebhookCard(props) {
      var t = props.t;
      var webhook = props.webhook;
      var update = props.update;
      var test = props.test;
      var testResults = props.testResults;
      var secretClear = props.secretClear;
      var setSecretClear = props.setSecretClear;
      var secretPath = "webhooks." + props.id + ".secret";
      var secretSet = Boolean(props.secretSet && props.secretSet[secretPath]);
      var result = testResults[props.id];
      var hasSecret = webhook.secret !== undefined;
      var canTest = typeof webhook.url === "string" && webhook.url.trim() !== "";

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
            disabled: !canTest || Boolean(result && result.status === "sending"),
            onClick: function () { test(props.id, undefined, { config: webhook }); },
          }, result && result.status === "sending" ? t("testSending") : t("test")),
          result && result.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testOk")) : null,
          result && result.status === "error" ? el("span", { className: "dsh-plugin-notify-error" }, format(t, "testFailed", { error: errorText(t, result.error) })) : null));
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
          var canTest = typeof item.url === "string" && item.url.trim() !== "";
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
                value: headersTexts[item.id] ?? "",
                placeholder: '{"Authorization": "Bearer …"}',
                onChange: function (event) {
                  var value = event.target.value;
                  setHeadersTexts(function (prev) {
                    var next = Object.assign({}, prev);
                    next[item.id] = value;
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
                disabled: !canTest || Boolean(result && result.status === "sending"),
                onClick: function () {
                  var cfg = Object.assign({}, item);
                  var raw = (headersTexts[item.id] ?? "").trim();
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
              result && result.status === "error" ? el("span", { className: "dsh-plugin-notify-error" }, format(t, "testFailed", { error: errorText(t, result.error) })) : null,
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
          }, el("span", { className: "dsh-plugin-notify-plus", "aria-hidden": "true" }, "+"), t("genericAdd"))));
    }

    function NotifySection(props) {
      var t = typeof props.t === "function"
        ? props.t
        : (typeof props.fallbackT === "function" ? props.fallbackT : function (key) { return key; });
      var store = props.store;
      var toastStore = props.toastStore;
      var snap = useStore(store);
      var desktop = isDesktop() || snap.meta?.desktop === true;
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
      var [stale, setStale] = React.useState(false);

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
        setSaved(false);
      }

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
            next[key] = { status: "error", error: error };
            return next;
          });
        });
      }

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
            setNativeError(nativeSupported() ? (desktop ? t("nativePermissionDeniedDesktop") : t("nativePermissionDenied")) : t("nativeUnsupported"));
          }
        }, function () {
          setNativeError(nativeSupported() ? (desktop ? t("nativePermissionDeniedDesktop") : t("nativePermissionDenied")) : t("nativeUnsupported"));
        });
      }

      function openNativeSettings() {
        setNativeError(null);
        store.openSystemSettings().catch(function (error) {
          setNativeError(errorText(t, error));
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
          toastStore.push({ title: t("testTitle"), body: t("testBody"), kind: "completed", label: "", sessionId: "", time: clockTime() });
        }
        window.setTimeout(function () {
          setTestResults(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { status: "ok" };
            return next;
          });
        }, 400);
      }

      function testNative() {
        var key = "native";
        setTestResults(function (prev) {
          var next = Object.assign({}, prev);
          next[key] = { status: "sending" };
          return next;
        });
        var finish = function (fired) {
          var detail = nativeSupported() ? (desktop ? t("nativePermissionDeniedDesktop") : t("nativePermissionDenied")) : t("nativeUnsupported");
          var error = fired ? null : makeError("channel-failed", detail, detail);
          if (!fired) {
            setNativeError(detail);
          }
          window.setTimeout(function () {
            setTestResults(function (prev) {
              var next = Object.assign({}, prev);
              next[key] = fired ? { status: "ok" } : { status: "error", error: error };
              return next;
            });
          }, 350);
        };
        requestNativePermission().then(function (granted) {
          var fired = false;
          try {
            fired = granted && fireNativeNotification(t("testTitle"), t("testBody"), "dsh-plugin-notify-test-" + Date.now().toString(36));
          } catch (error) {
            fired = false;
          }
          finish(fired);
        }, function () {
          finish(false);
        });
      }

      function reloadDraft() {
        setDirty(false);
        setSaveError(null);
        setStale(false);
        store.load().catch(function () {});
      }

      function onSave() {
        if (draft === null || savingRef.current) return;
        savingRef.current = true;
        setSaving(true);
        setSaveError(null);
        setStale(false);
        var next = deepClone(draft);
        var invalid = null;
        for (var i = 0; i < next.webhooks.generic.length; i += 1) {
          var text = (headersTexts[next.webhooks.generic[i].id] ?? "").trim();
          if (text === "") { next.webhooks.generic[i].headers = {}; continue; }
          try {
            var parsed = JSON.parse(text);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("headers must be a JSON object");
            next.webhooks.generic[i].headers = parsed;
          } catch (error) {
            invalid = "Webhook #" + (i + 1) + ": " + String(error?.message ?? error);
            break;
          }
        }
        if (invalid !== null) {
          savingRef.current = false;
          setSaving(false);
          setSaveError(invalid);
          return;
        }
        store.save(next, Array.from(secretClear)).then(function () {
          savingRef.current = false;
          setSaving(false);
          setDirty(false);
          setSaved(true);
        }, function (error) {
          savingRef.current = false;
          setSaving(false);
          if (error && error.code === "stale-config") {
            setStale(true);
            setSaveError(errorText(t, error));
          } else {
            setSaveError(errorText(t, error));
          }
        });
      }

      if (snap.status === "loading") return el("div", { className: "dsh-plugin-notify" }, t("loading"));
      if (snap.status === "error") {
        return el("div", { className: "dsh-plugin-notify" },
          el("div", { className: "dsh-plugin-notify-error" }, format(t, "loadError", { error: snap.error === "store-unavailable" ? t("storeUnavailable") : snap.error })),
          el("button", { className: "dsh-plugin-notify-button", onClick: function () { store.load(); } }, t("retry")));
      }
      if (draft === null) return el("div", { className: "dsh-plugin-notify" }, t("loading"));

      var triggers = draft.triggers;
      var browser = draft.browser;
      var system = draft.system;
      var webhooks = draft.webhooks;
      var nativePermissionState = nativePermission();
      var enabledWebhooks = ["feishu", "dingtalk", "wecom"].filter(function (id) { return webhooks[id].enabled; }).length
        + webhooks.generic.filter(function (item) { return item.enabled; }).length;
      var summary = [];
      if (browser.enabled !== false && browser.toast !== false) summary.push(t("summaryToasts"));
      if (browser.native === true) summary.push(t("summaryNative"));
      if (system.enabled) summary.push(t("summarySystem"));
      if (enabledWebhooks > 0) summary.push(format(t, "summaryWebhooks", { count: enabledWebhooks }));

      return el("div", { className: "dsh-plugin-notify" },
        el("div", { className: "dsh-plugin-notify-header" },
          el("div", { className: "dsh-plugin-notify-headerRow" },
            el("h2", { className: "dsh-plugin-notify-title" }, t("nav")),
            el("span", { className: "dsh-plugin-notify-platform" }, desktop ? "🖥 " + t("platformDesktop") : "🌐 " + t("platformWeb")),
            saving ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-info" }, t("saving")) : null,
            saveError ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-error" }, format(t, "saveError", { error: saveError })) : null,
            snap.error && snap.status === "ready" ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-warn" }, format(t, "refreshError", { error: snap.error })) : null,
            saved ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-success" }, t("saved")) : null,
            dirty ? el("span", { className: "dsh-plugin-notify-tag dsh-plugin-notify-tag-warn" }, t("unsaved")) : null),
          el("p", { className: "dsh-plugin-notify-intro" }, t("headerDesc")),
          el("div", { className: "dsh-plugin-notify-summary" },
            el("span", { className: "dsh-plugin-notify-summaryLabel" }, t("summaryTitle") + ":"),
            summary.length === 0
              ? el("span", { className: "dsh-plugin-notify-chip" }, t("summaryNone"))
              : summary.map(function (label) { return el("span", { className: "dsh-plugin-notify-chip dsh-plugin-notify-chip-on", key: label }, label); })),
          stale ? el("div", { className: "dsh-plugin-notify-actions" },
            el("span", { className: "dsh-plugin-notify-error" }, t("staleConfig")),
            el("button", { className: "dsh-plugin-notify-button", onClick: reloadDraft }, t("reload"))) : null),
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
                el("span", null, t(kindKey(kind))));
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
            disabled: browser.enabled === false,
            onChange: function (value) { update(function (next) { next.browser.toast = value; }); },
          }),
          el("div", { className: "dsh-plugin-notify-actions" },
            el("button", {
              className: "dsh-plugin-notify-button",
              disabled: browser.enabled === false || browser.toast === false || Boolean(testResults.browser && testResults.browser.status === "sending"),
              onClick: testBrowser,
            }, testResults.browser && testResults.browser.status === "sending" ? t("testSending") : t("testBrowser")),
            testResults.browser && testResults.browser.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testOk")) : null)),
        el(Card, {
          title: desktop ? t("nativeDesktop") : t("nativeWeb"),
          hint: desktop ? t("nativeDesktopHint") : t("nativeWebHint"),
          right: el("div", { className: "dsh-plugin-notify-card-right" },
            !browser.native ? el("span", { className: "dsh-plugin-notify-recommended" }, t("nativeRecommended")) : null,
            el(Switch, {
              label: desktop ? t("nativeEnabled") : t("nativeEnabledWeb"),
              checked: browser.native === true,
              onChange: toggleNative,
            })),
        },
          el("div", { className: "dsh-plugin-notify-permission" },
            desktop
              ? el("span", { className: "dsh-plugin-notify-permission-hint" }, t("desktopPermissionHint"))
              : el("span", null, t("nativeWeb") + " · " + (nativePermissionState === "granted" ? t("permissionGranted") : nativePermissionState === "denied" ? t("permissionDenied") : t("permissionDefault"))),
            !desktop && nativePermissionState !== "granted" ? el("button", {
              className: "dsh-plugin-notify-button",
              onClick: function () {
                requestNativePermission().then(function (granted) {
                  if (!granted) setNativeError(t("nativePermissionDenied"));
                });
              },
            }, t("requestPermission")) : null),
          nativeError ? el("div", { className: "dsh-plugin-notify-error" }, nativeError) : null,
          el("div", { className: "dsh-plugin-notify-actions" },
            desktop ? el("button", {
              className: "dsh-plugin-notify-button",
              onClick: openNativeSettings,
            }, t("openSystemSettings")) : null,
            el("button", {
              className: "dsh-plugin-notify-button",
              disabled: Boolean(testResults.native && testResults.native.status === "sending"),
              onClick: testNative,
            }, testResults.native && testResults.native.status === "sending" ? t("testSending") : t("testNative")),
            testResults.native && testResults.native.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testNativeOk")) : null,
            testResults.native && testResults.native.status === "error" ? el("span", { className: "dsh-plugin-notify-error" }, format(t, "testFailed", { error: errorText(t, testResults.native.error) })) : null)),
        el(Card, {
          title: t("system"),
          hint: desktop ? t("systemDesktopHint") : t("systemHint"),
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
              disabled: Boolean(testResults.system && testResults.system.status === "sending"),
              onClick: function () { runTest("system", undefined, { sound: system.sound }); },
            }, testResults.system && testResults.system.status === "sending" ? t("testSending") : t("test")),
            testResults.system && testResults.system.status === "ok" ? el("span", { className: "dsh-plugin-notify-ok" }, t("testOk")) : null,
            testResults.system && testResults.system.status === "error" ? el("span", { className: "dsh-plugin-notify-error" }, format(t, "testFailed", { error: errorText(t, testResults.system.error) })) : null)),
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
          el("button", { className: "dsh-plugin-notify-button", onClick: onSave, disabled: !dirty || saving }, saving ? t("saving") : t("save"))));
    }

    // ── settings error boundary ───────────────────────────────────────────

    class SectionErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error, info) {
        try {
          console.error("dsh-plugin-notify: settings section render failed", error, info);
        } catch (ignored) {
          // console may be unavailable
        }
      }

      render() {
        var t = typeof this.props.t === "function"
          ? this.props.t
          : (typeof this.props.fallbackT === "function" ? this.props.fallbackT : function (key) { return key; });
        if (this.state.error !== null) {
          return el("div", { className: "dsh-plugin-notify" },
            el("div", { className: "dsh-plugin-notify-header" },
              el("h2", { className: "dsh-plugin-notify-title" }, t("nav")),
              el("p", { className: "dsh-plugin-notify-intro" }, t("renderError"))),
            el("div", { className: "dsh-plugin-notify-hint" }, t("renderErrorHint")),
            el("pre", {
              className: "dsh-plugin-notify-hint",
              style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 },
            }, String(this.state.error?.stack ?? this.state.error?.message ?? this.state.error)));
        }
        return this.props.children;
      }
    }

    function NotifySectionEntry(props) {
      return el(SectionErrorBoundary, { t: props.t, fallbackT: props.fallbackT }, el(NotifySection, props));
    }

    // ── plugin ─────────────────────────────────────────────────────────────

    var inject = ["slots", "locale", "sessions", "uiSession"];

    /**
     * Resolve the client-side session navigation helper.
     *
     * DSH 0.2.1 no longer publishes `sessions.open` on the client tree, so the
     * notification click used to be a silent no-op. The sidebar's `uiWorkspace`
     * service owns navigation there; keep `sessions.open` as the fallback for
     * older releases. Both are optional lookups (not part of `inject`) so the
     * plugin keeps loading wherever neither service exists.
     *
     * @param ctx - Client plugin context.
     * @returns A function that opens a session, or undefined when unavailable.
     */
    function resolveSessionOpener(ctx) {
      var workspace;
      var sessions;
      try {
        workspace = ctx.get("uiWorkspace");
        sessions = ctx.get("sessions");
      } catch (error) {
        return undefined;
      }
      if (workspace !== undefined && typeof workspace.openSession === "function") {
        return function (sessionId) { workspace.openSession(sessionId); };
      }
      if (sessions !== undefined && typeof sessions.open === "function") {
        return function (sessionId) { sessions.open(sessionId); };
      }
      return undefined;
    }

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, DICT);
      }, "dsh-plugin-notify: locale");

      var store = createStore();
      var toastStore = createToastStore();
      var t = ctx.locale.bind(NS);

      store.load().catch(function () {});

      ctx.effect(function () {
        return startEngine(ctx, store, toastStore, t);
      }, "dsh-plugin-notify: notification engine");

      var refresh = function () { store.load().catch(function () {}); };
      var onVisibility = function () {
        if (typeof document !== "undefined" && document.visibilityState === "visible") refresh();
      };
      if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("focus", refresh);
      }
      if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
        document.addEventListener("visibilitychange", onVisibility);
      }
      ctx.effect(function () {
        return function () {
          if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
            window.removeEventListener("focus", refresh);
          }
          if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("visibilitychange", onVisibility);
          }
        };
      }, "dsh-plugin-notify: config refresh listeners");

      var slots = ctx.get("slots");
      if (slots !== undefined) {
        slots.inject("shell.overlay", function () {
          return slots.register({
            name: "shell.overlay",
            id: "dsh-plugin-notify-toast",
            order: 500,
            locale: NS,
            inject: function () { return { toastStore: toastStore, fallbackT: t }; },
          }, ToastHost);
        });
        slots.inject("settings.section", function () {
          return slots.register({
            name: "settings.section",
            id: "dsh-plugin-notify",
            order: 70,
            locale: NS,
            label: function () { return t("nav"); },
            inject: function () { return { store: store, toastStore: toastStore, fallbackT: t }; },
          }, NotifySectionEntry);
        });
      }
    }

    exports.apply = apply;
    exports.name = "dsh-plugin-notify";
    exports.inject = inject;
    exports.resolveSessionOpener = resolveSessionOpener;
    return module.exports;
  },
});
