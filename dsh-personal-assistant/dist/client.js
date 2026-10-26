window.__ModuleLoader__.load({
  id: "dsh-personal-assistant",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var PANEL_ID = "personal-assistant";
var inject = ["slots", "uiSession", "remote", "remote.commands"];
function AssistantGlyph({ size = 18, active = false }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: active ? 2 : 1.7,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M8.2 8.4V6.2a1.8 1.8 0 0 1 3.6 0v2.2M12.2 8.4V6.2a1.8 1.8 0 0 1 3.6 0v2.2" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M4.6 12.6c0-2.4 1.6-4.2 3.6-4.2h7.6c2 0 3.6 1.8 3.6 4.2 0 3.6-3.3 6-7.4 6s-7.4-2.4-7.4-6Z" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "9.3", cy: "12.2", r: "0.9", fill: "currentColor", stroke: "none" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("circle", { cx: "14.7", cy: "12.2", r: "0.9", fill: "currentColor", stroke: "none" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M10.6 15.4c.9.6 1.9.6 2.8 0" })
      ]
    }
  );
}
var primaryButton = {
  border: "none",
  borderRadius: 8,
  padding: "9px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  background: "#4a7dff",
  color: "#fff"
};
var secondaryButton = {
  border: "1px solid rgba(128,128,140,.35)",
  borderRadius: 8,
  padding: "9px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  background: "transparent",
  color: "inherit"
};
var dockButton = {
  border: "1px solid rgba(128,128,140,.32)",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 12,
  lineHeight: "18px",
  cursor: "pointer",
  background: "transparent",
  color: "inherit",
  whiteSpace: "nowrap"
};
function BindSessionButton({ ctx }) {
  const [state, setState] = (0, import_react.useState)("idle");
  const [hint, setHint] = (0, import_react.useState)("");
  const bind = async () => {
    setState("busy");
    setHint("");
    const id = (() => {
      try {
        return ctx.uiSession?.current?.getSnapshot()?.key;
      } catch {
        return void 0;
      }
    })();
    if (!id) {
      setState("error");
      setHint("\u5148\u5728\u5DE6\u4FA7\u6253\u5F00\u4E00\u4E2A\u4F1A\u8BDD");
      return;
    }
    try {
      const response = await ctx.remote?.commands?.execute(id, "/bind-pet", []);
      if (!response) {
        setState("error");
        setHint("\u547D\u4EE4\u901A\u9053\u8FD8\u6CA1\u5C31\u7EEA");
        return;
      }
      if (!response.ok) {
        setState("error");
        setHint(response.error?.message ?? "\u7ED1\u5B9A\u5931\u8D25");
        return;
      }
      const result = response.value?.result;
      if (result?.kind === "error") {
        setState("error");
        setHint(result.text ?? "\u7ED1\u5B9A\u5931\u8D25");
        return;
      }
      setState("done");
      setHint(result?.text ?? "\u5DF2\u7ED1\u5B9A\u5230\u5F53\u524D\u4F1A\u8BDD");
    } catch (error) {
      setState("error");
      setHint(error instanceof Error ? error.message : String(error));
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      disabled: state === "busy",
      title: hint || "\u628A\u684C\u9762\u5BA0\u7269\u7ED1\u5B9A\u5230\u5F53\u524D\u4F1A\u8BDD",
      onClick: () => void bind(),
      style: dockButton,
      children: state === "busy" ? "\u7ED1\u5B9A\u4E2D\u2026" : state === "done" ? "\u5DF2\u7ED1\u5B9A" : state === "error" ? "\u7ED1\u5B9A\u5931\u8D25" : "\u7ED1\u5B9A\u4F1A\u8BDD"
    }
  );
}
function AssistantPanel({ ctx }) {
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [message, setMessage] = (0, import_react.useState)("");
  const sessionId = () => {
    try {
      return ctx.uiSession?.current?.getSnapshot()?.key;
    } catch {
      return void 0;
    }
  };
  const execute = async (line) => {
    const id = sessionId();
    if (!id) return { ok: false, text: "\u5148\u5728\u5DE6\u4FA7\u6253\u5F00\u6216\u65B0\u5EFA\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u518D\u70B9\u8FD9\u91CC" };
    try {
      const response = await ctx.remote?.commands?.execute(id, line, []);
      if (!response) return { ok: false, text: "\u547D\u4EE4\u901A\u9053\u8FD8\u6CA1\u5C31\u7EEA\uFF0C\u7A0D\u540E\u518D\u8BD5" };
      if (!response.ok) return { ok: false, text: response.error?.message ?? "\u547D\u4EE4\u6CA1\u80FD\u6267\u884C" };
      const result = response.value?.result;
      return { ok: result?.kind !== "error", text: result?.text ?? "\u5DF2\u6267\u884C" };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    }
  };
  const act = async (line) => {
    setBusy(true);
    try {
      const result = await execute(line);
      setMessage(result.text);
    } finally {
      setBusy(false);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { maxWidth: 620, margin: "56px auto", padding: "0 28px", color: "inherit" }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: { fontSize: 20, fontWeight: 600, margin: "0 0 6px" }, children: "\u4E2A\u4EBA\u52A9\u7406" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { fontSize: 13, opacity: 0.65, margin: "0 0 28px", lineHeight: 1.6 }, children: "\u53EC\u5524\u684C\u9762\u5BA0\u7269\uFF0C\u6216\u5F00\u542F\u5F53\u5929\u7684\u7535\u8111\u6D3B\u52A8\u8BB0\u5F55\u3002" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 12, flexWrap: "wrap" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => void act("/summon-pet"), style: primaryButton, children: "\u53EC\u5524\u5BA0\u7269" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => void act("/assistant-on"), style: secondaryButton, children: "\u5F00\u542F\u4E2A\u4EBA\u52A9\u7406" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 18, fontSize: 12, opacity: 0.6, minHeight: 18 }, children: message })
  ] });
}
function apply(ctx) {
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 30,
    label: "\u4E2A\u4EBA\u52A9\u7406"
  }, AssistantGlyph));
  ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID
  }, () => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AssistantPanel, { ctx })));
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions",
    id: "bind-session",
    order: 20
  }, () => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(BindSessionButton, { ctx })));
}

    return module.exports;
  },
});
