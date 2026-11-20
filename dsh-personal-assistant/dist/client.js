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
  KNOWN_COMMANDS: () => KNOWN_COMMANDS,
  apply: () => apply,
  inject: () => inject,
  parsePort: () => parsePort
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// src/client/styles.ts
var TOKENS = {
  /** 内容上限：再宽一行字就太长，但也不能窄成一个小框。 */
  maxWidth: "min(1200px, 100%)",
  ink: "#1f2329",
  muted: "rgba(31,35,41,.6)",
  faint: "rgba(31,35,41,.42)",
  line: "#eceef2",
  soft: "#f7f8fa",
  primary: "#4a7dff",
  green: "#22c55e",
  grey: "#c9ccd3",
  amber: "#f59e0b",
  ok: "#15803d",
  bad: "#dc2626"
};
var page = {
  maxWidth: TOKENS.maxWidth,
  margin: "0 auto",
  padding: "28px 32px 40px",
  color: TOKENS.ink,
  font: '400 14px/1.6 ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  boxSizing: "border-box"
};
var header = { margin: "0 0 14px" };
var titleRow = { display: "flex", alignItems: "baseline", gap: 10, margin: "0 0 4px", flexWrap: "wrap" };
var title = { fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: ".2px" };
var badge = {
  fontSize: 12,
  lineHeight: "20px",
  padding: "0 8px",
  borderRadius: 6,
  background: "#f2f3f5",
  color: TOKENS.muted,
  whiteSpace: "nowrap"
};
var subtitle = { fontSize: 13, margin: 0, color: TOKENS.muted };
var statusBar = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  minHeight: 44,
  padding: "0 14px",
  border: `1px solid ${TOKENS.line}`,
  borderRadius: 12,
  background: "#fff",
  flexWrap: "wrap"
};
var statGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 10,
  marginTop: 12
};
var statTile = {
  background: TOKENS.soft,
  borderRadius: 10,
  padding: "10px 12px"
};
var statValue = { fontSize: 18, fontWeight: 600, lineHeight: "24px" };
var statValueSmall = { fontSize: 12.5, fontWeight: 500, lineHeight: "24px", color: TOKENS.muted };
var statLabel = { fontSize: 11.5, color: TOKENS.muted, marginTop: 1 };
var statNote = { fontSize: 11, color: TOKENS.faint, marginTop: 4, lineHeight: "15px" };
var tabBar = {
  display: "flex",
  alignItems: "center",
  gap: 24,
  margin: "18px 0 0",
  borderBottom: `1px solid ${TOKENS.line}`,
  overflowX: "auto"
};
var tabButton = (active) => ({
  appearance: "none",
  border: 0,
  borderBottom: active ? `2px solid ${TOKENS.primary}` : "2px solid transparent",
  background: "transparent",
  color: active ? TOKENS.primary : TOKENS.muted,
  font: "inherit",
  fontSize: 13.5,
  fontWeight: active ? 600 : 500,
  padding: "10px 0",
  marginBottom: -1,
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "color .16s ease, border-color .16s ease"
});
var tabPanel = { padding: "16px 0 0" };
var tableWrap = {
  border: `1px solid ${TOKENS.line}`,
  borderRadius: 12,
  background: "#fff",
  // 列表行多时在卡片内部上下滚（表头吸顶），不依赖外层页面是否可滚；
  // 横向也允许滚，窄屏隐藏列之外仍能看到被截的列。
  overflow: "auto",
  maxHeight: "min(56vh, 520px)"
};
var tableHeadRow = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  borderBottom: `1px solid ${TOKENS.line}`,
  background: TOKENS.soft,
  color: TOKENS.faint,
  fontSize: 11.5,
  fontWeight: 600,
  // 吸顶：卡片内滚动时表头不跟着滚走，否则滚到下面不知道每列是什么。
  position: "sticky",
  top: 0,
  zIndex: 1
};
var tableRow = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  minHeight: 44,
  padding: "10px 14px",
  borderBottom: `1px solid ${TOKENS.line}`,
  fontSize: 13
};
var tableEmpty = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  minHeight: 132,
  padding: "22px 16px",
  color: TOKENS.faint,
  fontSize: 12.5,
  textAlign: "center"
};
var tableHint = { fontSize: 12, color: TOKENS.faint };
var configBlock = {
  border: `1px solid ${TOKENS.line}`,
  borderRadius: 12,
  background: "#fff",
  padding: "18px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 10
};
var summaryRow = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "11px 14px",
  borderBottom: `1px solid ${TOKENS.line}`,
  fontSize: 13
};
var entryItem = {
  border: `1px solid ${TOKENS.line}`,
  borderRadius: 12,
  padding: "14px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 6
};
var primaryButton = {
  border: "none",
  borderRadius: 10,
  padding: "9px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  background: TOKENS.primary,
  color: "#fff"
};
var secondaryButton = {
  border: "1px solid rgba(128,128,140,.3)",
  borderRadius: 10,
  padding: "9px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  background: "transparent",
  color: TOKENS.ink
};
var smallButton = {
  border: "1px solid rgba(128,128,140,.3)",
  borderRadius: 8,
  padding: "5px 11px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  background: "transparent",
  color: TOKENS.ink
};
var disabledButton = {
  ...secondaryButton,
  cursor: "not-allowed",
  color: TOKENS.faint,
  borderColor: TOKENS.line
};
var dockButton = {
  border: "1px solid rgba(128,128,140,.3)",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 12,
  lineHeight: "18px",
  cursor: "pointer",
  background: "transparent",
  color: "inherit",
  whiteSpace: "nowrap"
};
var dot = (color) => ({
  width: 6,
  height: 6,
  borderRadius: 999,
  background: color,
  flex: "none"
});
var statusRow = { display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 };
var result = { fontSize: 12, margin: 0, minHeight: 18 };

// src/client/overview.ts
var UNAVAILABLE_PREFIX = "\u6682\u65F6\u8BFB\u4E0D\u5230";
var PATTERNS = {
  todo: /待办\s*(\d+)/u,
  meeting: /今天\s*(\d+)\s*场/u,
  summary: /今天\s*(\d+\s*小时(?:\s*\d+\s*分)?)/u
};
function overviewValue(command, text) {
  const sentence = text.trim();
  if (sentence === "") return { value: "\u6682\u65F6\u8BFB\u4E0D\u5230", detail: null, kind: "unavailable" };
  if (sentence.startsWith(UNAVAILABLE_PREFIX)) return { value: sentence, detail: null, kind: "unavailable" };
  const matched = PATTERNS[command].exec(sentence);
  if (matched === null) return { value: sentence, detail: null, kind: "plain" };
  const value = matched[1].replace(/\s+/gu, " ").trim();
  return { value, detail: sentence, kind: "metric" };
}

// src/client/tabs.ts
var TABS = [
  { id: "todo", label: "\u5F85\u529E", page: "todo" },
  { id: "mail", label: "\u90AE\u4EF6", page: "mail" },
  { id: "wecom", label: "\u4F01\u4E1A\u5FAE\u4FE1", page: "wecom" },
  { id: "report", label: "\u65E5\u62A5\u5468\u62A5", page: "report" },
  { id: "meeting", label: "\u4F1A\u8BAE", page: "meeting" },
  { id: "team", label: "\u52A9\u7406\u56E2", page: "team" },
  // 技能：自动形成 + 人工查验/增删改查，都在这里。
  { id: "skills", label: "\u6280\u80FD", page: "team" },
  // 桌宠右键菜单里可配置的外观项（形象 / 随机动作 / 显示 / 上台）在这里也有一份。
  { id: "pet", label: "\u5BA0\u7269", page: "general" },
  { id: "settings", label: "\u8BBE\u7F6E", page: "general" }
];
var LIST_TABS = {
  todo: {
    command: "/assistant-todo-list",
    columns: [
      // 标题自适应（`1 1 0` = 不占基础宽度，吃掉剩余空间）；其余四列定宽，
      // 因为它们是**短枚举**（高/中/低、手动/会议/企业/AI、状态、日期），
      // 让它们跟着内容伸缩只会让整张表在切换数据时左右抖动。
      { key: "title", label: "\u6807\u9898", width: "1 1 0" },
      { key: "priority", label: "\u4F18\u5148\u7EA7", width: "72px" },
      { key: "source", label: "\u6765\u6E90", width: "72px" },
      { key: "status", label: "\u72B6\u6001", width: "96px" },
      // 128px：服务端 `stampOf()` 输出 `2026-01-03 08:00`，16 个半角字符，13px 下约 115px。
      // 112px 会截断（只剩 3px 余量），128px 留 ~13px。
      // 为什么不跟历史会议日期列一样用 148px：到期是次要信息，不该和标题争宽；而且窄屏本来就隐藏它。
      { key: "due", label: "\u5230\u671F", width: "128px" }
    ],
    // 旧 3 列 → 新 5 列：标题留在第 1 列，状态从第 2 列搬到第 4 列，到期从第 3 列搬到第 5 列。
    legacy: { from: 3, to: [0, 3, 4] },
    // 等后端把 taskId 追加成第 6 格：用它做"待确认"标记（按 id 记，不按行序）。
    trailing: 1,
    empty: "\u8FD8\u6CA1\u6709\u5F85\u529E",
    unavailable: "\u6682\u65F6\u8BFB\u4E0D\u5230\u5F85\u529E",
    hint: "\u4EFB\u52A1\u6E05\u5355\u6765\u81EA\u684C\u9762\u5BA0\u7269\u7684\u5F85\u529E\u7A97\u53E3\u3002"
  },
  report: {
    command: "/assistant-report-list",
    columns: [
      { key: "date", label: "\u65E5\u671F", width: "1fr" },
      { key: "status", label: "\u72B6\u6001", width: "1fr" },
      { key: "digest", label: "\u6458\u8981", width: "2.4fr" }
    ],
    empty: "\u8FD8\u6CA1\u6709\u65E5\u62A5\u8349\u7A3F",
    unavailable: "\u6682\u65F6\u8BFB\u4E0D\u5230\u65E5\u62A5",
    hint: "\u65E5\u62A5\u7531\u684C\u9762\u5BA0\u7269\u6574\u7406\uFF0C\u8FD9\u91CC\u53EA\u8BFB\u3002"
  },
  meeting: {
    command: "/assistant-meeting-list",
    columns: [
      { key: "time", label: "\u65F6\u95F4", width: "1fr" },
      { key: "name", label: "\u540D\u79F0", width: "2.2fr" },
      { key: "status", label: "\u72B6\u6001", width: "1fr" }
    ],
    empty: "\u4ECA\u5929\u8FD8\u6CA1\u6709\u4F1A\u8BAE",
    unavailable: "\u6682\u65F6\u8BFB\u4E0D\u5230\u4ECA\u5929\u7684\u4F1A\u8BAE",
    hint: "\u4F1A\u8BAE\u4E0E\u7EAA\u8981\u7531\u684C\u9762\u5BA0\u7269\u5F55\u5236\u5E76\u6574\u7406\u3002",
    // 尾列是会议 id（不渲染）：改名/删除按它定位。
    trailing: 1
  },
  team: {
    command: "/assistant-team-list",
    columns: [
      { key: "name", label: "\u540D\u5B57", width: "1.2fr" },
      { key: "role", label: "\u89D2\u8272", width: "1.2fr" },
      { key: "status", label: "\u72B6\u6001", width: "1fr" },
      { key: "quota", label: "\u989D\u5EA6", width: "1fr" }
    ],
    empty: "\u8FD8\u6CA1\u6709\u6210\u5458",
    unavailable: "\u6682\u65F6\u8BFB\u4E0D\u5230\u6210\u5458\u5217\u8868",
    hint: "\u6210\u5458\u4E0E\u989D\u5EA6\u5728\u684C\u9762\u5BA0\u7269\u7684\u52A9\u7406\u56E2\u91CC\u7BA1\u7406\u3002"
  }
};
var MEETING_HISTORY_COMMAND = "/assistant-meeting-history";
var MEETING_HISTORY = {
  command: MEETING_HISTORY_COMMAND,
  columns: [
    // 148px：`2026-11-12 14:30` 是 16 个半角字符（13px 下约 115px），132px 只剩 17px 余量，
    // 真机字体回退（雅黑数字偏宽）会吃掉省略号把时间截掉。148px 留出 ~33px。
    { key: "date", label: "\u65E5\u671F", width: "148px" },
    { key: "name", label: "\u540D\u79F0" },
    { key: "source", label: "\u6765\u6E90", width: "132px" },
    { key: "retention", label: "\u4FDD\u7559\u671F", width: "72px" },
    { key: "status", label: "\u72B6\u6001", width: "80px" }
  ],
  empty: "\u8FD8\u6CA1\u6709\u5386\u53F2\u4F1A\u8BAE",
  unavailable: "\u6682\u65F6\u8BFB\u4E0D\u5230\u5386\u53F2\u4F1A\u8BAE",
  hint: "\u6700\u591A\u663E\u793A 20 \u6761",
  // 尾列是会议 id（不渲染）：改名/删除按它定位。
  trailing: 1
};
var STATUS_TONE = {
  \u8F6C\u5199\u5931\u8D25: "#c2410c"
};
function statusTone(value) {
  return STATUS_TONE[value.trim()] ?? null;
}
var SET_TASK_PRIORITY_COMMAND = "/assistant-set-task-priority";
var PRIORITY_CHOICES = [
  { value: "high", label: "\u9AD8" },
  { value: "normal", label: "\u4E2D" },
  { value: "low", label: "\u4F4E" }
];
function priorityLabel(value) {
  return PRIORITY_CHOICES.find((choice) => choice.value === value)?.label ?? value;
}
function priorityCommand(taskId, value) {
  const id = taskId.trim();
  const picked = PRIORITY_CHOICES.find((choice) => choice.value === value);
  if (id === "" || /\s/u.test(id) || picked === void 0) return null;
  return `${SET_TASK_PRIORITY_COMMAND} ${id} ${picked.value}`;
}
function rowTaskId(row) {
  const id = row.trailing[0]?.trim();
  if (id === void 0 || id === "" || id === EMPTY_CELL) return null;
  return /\s/u.test(id) ? null : id;
}
function rowMeetingId(row) {
  const id = row.trailing[0]?.trim();
  if (id === void 0 || id === "" || id === EMPTY_CELL) return null;
  return /\s/u.test(id) ? null : id;
}
function priorityOutcome(rows2, taskId, requestedValue) {
  const row = rows2.find((candidate) => rowTaskId(candidate) === taskId);
  if (row === void 0) return "gone";
  const index = LIST_TABS.todo.columns.findIndex((column) => column.key === "priority");
  if (index < 0) return "pending";
  return row.cells[index]?.trim() === priorityLabel(requestedValue) ? "applied" : "pending";
}
function reconcilePending(pending, rows2) {
  const keys = Object.keys(pending);
  if (keys.length === 0) return pending;
  const next = {};
  let changed = false;
  for (const key of keys) {
    const row = rows2.find((candidate) => rowTaskId(candidate) === key);
    if (row === void 0) {
      changed = true;
      continue;
    }
    const index = LIST_TABS.todo.columns.findIndex((column) => column.key === "priority");
    if (index >= 0 && row.cells[index]?.trim() === priorityLabel(pending[key])) {
      changed = true;
      continue;
    }
    next[key] = pending[key];
  }
  return changed ? next : pending;
}
var PRIORITY_TONE = {
  \u9AD8: "#c2410c"
};
function priorityTone(value) {
  return PRIORITY_TONE[value.trim()] ?? null;
}
var COLUMN_TONES = {
  status: statusTone,
  priority: priorityTone
};
function columnTone(columnKey, value) {
  if (columnKey === void 0) return void 0;
  const tone = COLUMN_TONES[columnKey];
  return tone === void 0 ? void 0 : tone(value);
}
function columnClassName(prefix, key) {
  return `wb-col-${prefix}-${key}`;
}
var NARROW_HIDDEN_COLUMNS = [
  { prefix: "todo", key: "source" },
  { prefix: "todo", key: "due" },
  { prefix: "history", key: "source" },
  { prefix: "history", key: "retention" }
];
function narrowTableCss() {
  const selectors = NARROW_HIDDEN_COLUMNS.map((column) => `.${columnClassName(column.prefix, column.key)}`).join(",\n    ");
  return `@media (max-width: 720px) {
  ${selectors} { display: none !important; }
}`;
}
function tableView(state, definition) {
  if (state === "rows") return { state, message: null };
  if (state === "loading") return { state, message: "\u8BFB\u53D6\u4E2D\u2026" };
  if (state === "empty") return { state, message: definition.empty };
  return { state, message: definition.unavailable };
}
var LIST_SEPARATOR = " | ";
var EMPTY_CELL = "\u2014";
function alignCells(cells, width, legacy) {
  const aligned = new Array(width).fill(EMPTY_CELL);
  if (legacy !== void 0 && cells.length === legacy.from) {
    cells.forEach((cell, index) => {
      const target = legacy.to[index];
      if (target !== void 0 && target >= 0 && target < width) aligned[target] = cell;
    });
    return aligned;
  }
  cells.forEach((cell, index) => {
    if (index < width) aligned[index] = cell;
  });
  return aligned;
}
function parseList(text, definition) {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return { state: "empty", rows: [], message: "\u8FD8\u6CA1\u6709\u6570\u636E" };
  const tableLines = lines.filter((line) => line.includes(LIST_SEPARATOR));
  if (tableLines.length === 0) {
    const sentence = lines[0];
    const state = sentence.startsWith("\u6682\u65F6\u8BFB\u4E0D\u5230") ? "unavailable" : "empty";
    return { state, rows: [], message: sentence };
  }
  const width = definition.columns.length;
  const rows2 = tableLines.map((line) => {
    const cells = line.split(LIST_SEPARATOR).map((cell) => cell.trim());
    if (definition.legacy !== void 0 && cells.length === definition.legacy.from) {
      return {
        cells: alignCells(cells, width, definition.legacy).map((cell) => cell === "" ? EMPTY_CELL : cell),
        trailing: []
      };
    }
    const visible = alignCells(cells.slice(0, width), width, void 0).map((cell) => cell === "" ? EMPTY_CELL : cell);
    const trailing = cells.slice(width);
    return { cells: visible, trailing };
  });
  return { state: "rows", rows: rows2, message: null };
}
var SETTINGS_SUMMARY_COMMAND = "/assistant-settings-summary";
function parseSettingsSummary(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const unavailable = { state: "unavailable", rows: [], message: "\u6682\u65F6\u8BFB\u4E0D\u5230\u8BBE\u7F6E" };
  if (lines.length === 0) return unavailable;
  const columns = lines.map((line) => line.split(LIST_SEPARATOR));
  if (columns.some((cells) => cells.length !== 2)) {
    return { state: "unavailable", rows: [], message: lines[0] };
  }
  return { state: "rows", rows: columns.map((cells) => [cells[0].trim() || "\u2014", cells[1].trim() || "\u2014"]), message: null };
}

// src/client/config-forms.ts
var SETTINGS_OPTIONS = [
  {
    key: "wake",
    label: "\u5524\u9192",
    summaryLabel: "\u5524\u9192",
    choices: [
      { value: "on", label: "\u5F00" },
      { value: "off", label: "\u5173" }
    ]
  },
  {
    key: "broadcast",
    label: "\u64AD\u62A5",
    summaryLabel: "\u64AD\u62A5",
    choices: [
      { value: "all", label: "\u6240\u6709\u56DE\u590D\u90FD\u5FF5" },
      { value: "voice", label: "\u53EA\u5FF5\u8BED\u97F3\u53D1\u8D77\u7684" }
    ]
  },
  {
    key: "docSpeech",
    label: "\u8BB2\u89E3\u6A21\u5F0F",
    summaryLabel: "\u8BB2\u89E3\u6A21\u5F0F",
    choices: [
      { value: "source", label: "\u539F\u6587\u6717\u8BFB" },
      { value: "ai", label: "AI \u8BB2\u89E3" }
    ]
  }
];
function optionValueOf(key, description) {
  const text = description.trim();
  if (text === "") return null;
  if (key === "wake") {
    if (text.startsWith("\u5F00")) return "on";
    if (text.startsWith("\u5173")) return "off";
    return null;
  }
  if (key === "broadcast") {
    if (text.includes("\u6240\u6709\u56DE\u590D")) return "all";
    if (text.includes("\u53EA\u5FF5\u8BED\u97F3")) return "voice";
    return null;
  }
  if (text.includes("AI")) return "ai";
  if (text.includes("\u539F\u6587")) return "source";
  return null;
}
function optionCommand(key, value) {
  return `/assistant-set-option ${key}=${value}`;
}
var SET_OPTION_FAILURE_PREFIX = "\u8BBE\u7F6E\u6CA1\u6539\u6210";
function setOptionFailure(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SET_OPTION_FAILURE_PREFIX)) return null;
  const reason = trimmed.slice(SET_OPTION_FAILURE_PREFIX.length).replace(/^[:：]\s*/u, "").trim();
  return reason === "" ? trimmed : reason;
}
var MAIL_FIELDS = [
  { key: "address", label: "\u90AE\u7BB1\u5730\u5740", type: "text", placeholder: "name@example.com" },
  { key: "smtpHost", label: "SMTP \u4E3B\u673A", type: "text", placeholder: "smtp.example.com" },
  { key: "smtpPort", label: "SMTP \u7AEF\u53E3", type: "number", placeholder: "465", width: "120px" },
  {
    key: "password",
    label: "\u6388\u6743\u7801 / \u5BC6\u7801",
    type: "password",
    secret: true,
    placeholder: "\u4E0D\u663E\u793A\u5DF2\u4FDD\u5B58\u7684\u503C",
    secretRequiredPlaceholder: "\u8BF7\u8F93\u5165\u6388\u6743\u7801"
  },
  { key: "imapHost", label: "IMAP \u4E3B\u673A", type: "text", placeholder: "imap.example.com" },
  { key: "imapPort", label: "IMAP \u7AEF\u53E3", type: "number", placeholder: "993", width: "120px" }
];
var WECOM_FIELDS = [
  { key: "corpId", label: "\u4F01\u4E1A ID", type: "text", placeholder: "ww\u2026" },
  {
    key: "secret",
    label: "\u5E94\u7528 Secret",
    type: "password",
    secret: true,
    placeholder: "\u4E0D\u663E\u793A\u5DF2\u4FDD\u5B58\u7684\u503C",
    secretRequiredPlaceholder: "\u8BF7\u8F93\u5165 Secret"
  },
  { key: "agentId", label: "AgentId", type: "text", placeholder: "1000002", width: "160px" },
  { key: "toUser", label: "\u63A5\u6536\u4EBA", type: "text", placeholder: "\u8D26\u53F7\u6216 @all", width: "200px" }
];
var EMPTY_SNAPSHOT = { unavailable: false, configured: false, values: {}, hasSecret: false };
var ABSENT = /^(?:未配置|—|-|没有|none)$/u;
var SECRET_SAVED_PLACEHOLDER = "\u5DF2\u4FDD\u5B58\uFF0C\u7559\u7A7A\u8868\u793A\u4E0D\u4FEE\u6539";
function splitViewLine(line) {
  const index = line.indexOf("|");
  if (index < 0) return null;
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}
function splitHostPort(value) {
  const text = value.trim();
  if (text === "" || ABSENT.test(text)) return ["", ""];
  const index = text.lastIndexOf(":");
  if (index < 0) return [text, ""];
  const host = text.slice(0, index).trim();
  const port = text.slice(index + 1).trim();
  if (host === "") return ["", ""];
  if (host.includes(":")) return [text, ""];
  return [host, port === "0" ? "" : port];
}
function viewMap(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return null;
  const map = /* @__PURE__ */ new Map();
  for (const line of lines) {
    const pair = splitViewLine(line);
    if (pair === null) return null;
    map.set(pair[0], pair[1]);
  }
  return map;
}
function looksUnavailable(text) {
  const trimmed = text.trim();
  return trimmed === "" || trimmed.startsWith("\u6682\u65F6\u8BFB\u4E0D\u5230");
}
function looksUnconfigured(text) {
  return !text.includes("|") && /还没有配置|尚未配置|未配置|not\s*configured/i.test(text);
}
var UNREADABLE = { unavailable: true, configured: false, values: {}, hasSecret: false };
var UNCONFIGURED = { unavailable: false, configured: false, values: {}, hasSecret: false };
function parseMailSnapshot(text) {
  if (looksUnavailable(text)) return UNREADABLE;
  if (looksUnconfigured(text)) return UNCONFIGURED;
  const map = viewMap(text);
  if (map === null) return UNREADABLE;
  const values = {};
  const address = map.get("\u90AE\u7BB1") ?? "";
  if (address !== "" && !ABSENT.test(address)) values.address = address;
  const [smtpHost, smtpPort] = splitHostPort(map.get("SMTP") ?? "");
  if (smtpHost !== "") values.smtpHost = smtpHost;
  if (smtpPort !== "") values.smtpPort = smtpPort;
  const [imapHost, imapPort] = splitHostPort(map.get("IMAP") ?? "");
  if (imapHost !== "") values.imapHost = imapHost;
  if (imapPort !== "") values.imapPort = imapPort;
  const hasSecret = (map.get("\u6388\u6743\u7801") ?? "") === "\u5DF2\u4FDD\u5B58";
  return { unavailable: false, configured: Object.keys(values).length > 0 || hasSecret, values, hasSecret };
}
function parseWecomSnapshot(text) {
  if (looksUnavailable(text)) return UNREADABLE;
  if (looksUnconfigured(text)) return UNCONFIGURED;
  const map = viewMap(text);
  if (map === null) return UNREADABLE;
  const values = {};
  for (const [label, key] of [["\u4F01\u4E1A ID", "corpId"], ["AgentId", "agentId"], ["\u63A5\u6536\u4EBA", "toUser"]]) {
    const value = map.get(label) ?? "";
    if (value !== "" && !ABSENT.test(value)) values[key] = value;
  }
  const hasSecret = (map.get("Secret") ?? "") === "\u5DF2\u4FDD\u5B58";
  return { unavailable: false, configured: Object.keys(values).length > 0 || hasSecret, values, hasSecret };
}
function fieldPlaceholder(field, snapshot) {
  if (field.secret !== true) return field.placeholder ?? "";
  if (snapshot.hasSecret) return SECRET_SAVED_PLACEHOLDER;
  return field.secretRequiredPlaceholder ?? field.placeholder ?? "";
}
function initialFormValues(fields, snapshot) {
  const values = {};
  for (const field of fields) {
    if (field.secret === true) continue;
    const value = snapshot.values[field.key];
    if (value !== void 0) values[field.key] = value;
  }
  return values;
}
var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
function portError(value) {
  const text = value.trim();
  if (text === "") return "\u8BF7\u586B\u5199\u7AEF\u53E3";
  if (!/^\d+$/u.test(text)) return "\u7AEF\u53E3\u5FC5\u987B\u662F\u6570\u5B57";
  const port = Number(text);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return "\u7AEF\u53E3\u5FC5\u987B\u5728 1\u201365535 \u4E4B\u95F4";
  return null;
}
function required(value, label) {
  return value.trim() === "" ? `\u8BF7\u586B\u5199${label}` : null;
}
function validateMail(values, stored = { hasSecret: false }) {
  const errors = {};
  const address = values.address ?? "";
  const addressMissing = required(address, "\u90AE\u7BB1\u5730\u5740");
  if (addressMissing !== null) errors.address = addressMissing;
  else if (!EMAIL.test(address.trim())) errors.address = "\u90AE\u7BB1\u5730\u5740\u683C\u5F0F\u4E0D\u5BF9";
  const smtpHost = required(values.smtpHost ?? "", "SMTP \u4E3B\u673A");
  if (smtpHost !== null) errors.smtpHost = smtpHost;
  const imapHost = required(values.imapHost ?? "", "IMAP \u4E3B\u673A");
  if (imapHost !== null) errors.imapHost = imapHost;
  const smtpPort = portError(values.smtpPort ?? "");
  if (smtpPort !== null) errors.smtpPort = smtpPort;
  const imapPort = portError(values.imapPort ?? "");
  if (imapPort !== null) errors.imapPort = imapPort;
  if ((values.password ?? "").trim() === "" && !stored.hasSecret) errors.password = "\u8BF7\u586B\u5199\u6388\u6743\u7801";
  return errors;
}
function validateWecom(values, stored = { hasSecret: false }) {
  const errors = {};
  for (const field of WECOM_FIELDS) {
    if (field.secret === true && stored.hasSecret) continue;
    const missing = required(values[field.key] ?? "", field.label);
    if (missing !== null) errors[field.key] = missing;
  }
  const agentId = (values.agentId ?? "").trim();
  if (agentId !== "" && !/^\d+$/u.test(agentId)) errors.agentId = "AgentId \u5FC5\u987B\u662F\u6570\u5B57";
  return errors;
}
function buildCommandLine(command, values, keys) {
  const parts = [];
  for (const key of keys) {
    const raw = (values[key] ?? "").trim();
    if (raw === "") continue;
    const quoted = /[\s"]/u.test(raw) ? `"${raw.replace(/"/gu, '\\"')}"` : raw;
    parts.push(`${key}=${quoted}`);
  }
  return `/${command} ${parts.join(" ")}`.trim();
}
function looksLikeUnknownCommand(text) {
  return /未知|不存在|没有这个命令|unknown|not\s*found|no\s+such/i.test(text);
}
function optionValuesOf(rows2) {
  const values = {};
  for (const definition of SETTINGS_OPTIONS) {
    const row = rows2.find(([label]) => label.trim() === definition.summaryLabel);
    if (row === void 0) continue;
    const value = optionValueOf(definition.key, row[1]);
    if (value !== null) values[definition.key] = value;
  }
  return values;
}

// src/client/pet-config.ts
var PET_CONFIG_UNAVAILABLE = {
  unavailable: true,
  message: null,
  stageVisible: true,
  characters: [],
  skins: []
};
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function parseActions(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const action = record(item);
    if (!action || typeof action.id !== "string" || action.id === "") return [];
    return [{ id: action.id, label: typeof action.label === "string" && action.label !== "" ? action.label : action.id }];
  });
}
function parseSkins(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const skin = record(item);
    if (!skin || typeof skin.id !== "string" || skin.id === "") return [];
    return [{
      id: skin.id,
      label: typeof skin.label === "string" && skin.label !== "" ? skin.label : skin.id,
      actions: parseActions(skin.actions)
    }];
  });
}
function parseCharacters(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const character = record(item);
    if (!character || typeof character.assistantId !== "string" || character.assistantId === "") return [];
    return [{
      assistantId: character.assistantId,
      displayName: typeof character.displayName === "string" && character.displayName !== "" ? character.displayName : character.assistantId,
      roleId: typeof character.roleId === "string" ? character.roleId : "",
      skin: typeof character.skin === "string" && character.skin !== "" ? character.skin : "panda",
      randomActions: stringArray(character.randomActions),
      steppedDown: character.steppedDown === true,
      chief: character.chief === true
    }];
  });
}
function parsePetConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...PET_CONFIG_UNAVAILABLE, message: "\u6682\u65F6\u8BFB\u4E0D\u5230\u5BA0\u7269\u914D\u7F6E" };
  }
  const body = record(parsed);
  if (!body) return { ...PET_CONFIG_UNAVAILABLE, message: "\u6682\u65F6\u8BFB\u4E0D\u5230\u5BA0\u7269\u914D\u7F6E" };
  if (body.unavailable === true || body.ok === false) {
    return {
      ...PET_CONFIG_UNAVAILABLE,
      message: typeof body.message === "string" && body.message !== "" ? body.message : "\u6682\u65F6\u8BFB\u4E0D\u5230\u5BA0\u7269\u914D\u7F6E"
    };
  }
  const characters = parseCharacters(body.characters);
  const skins = parseSkins(body.skins);
  if (characters.length === 0 || skins.length === 0) {
    return { ...PET_CONFIG_UNAVAILABLE, message: "\u5BA0\u7269\u914D\u7F6E\u56DE\u5305\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5" };
  }
  return {
    unavailable: false,
    message: null,
    stageVisible: body.stageVisible !== false,
    characters,
    skins
  };
}
function parseAssistantState(text) {
  try {
    const body = record(JSON.parse(text));
    if (!body) return { injection: "unknown", capture: "unknown", blocked: null };
    const injection = body.injection === "on" || body.injection === "off" ? body.injection : "unknown";
    const capture = body.capture === "recording" || body.capture === "pending" || body.capture === "blocked" || body.capture === "off" ? body.capture : "unknown";
    return {
      injection,
      capture,
      blocked: typeof body.blocked === "string" && body.blocked !== "" ? body.blocked : null
    };
  } catch {
    return { injection: "unknown", capture: "unknown", blocked: null };
  }
}
function actionsValue(actions) {
  return actions.length === 0 ? "none" : [...new Set(actions)].join(",");
}
function petSetCommand(change) {
  if (change.kind === "stage") return `/assistant-pet-set stage ${change.value ? "show" : "hide"}`;
  if (change.kind === "actions") return `/assistant-pet-set actions ${change.assistantId} ${actionsValue(change.value)}`;
  return `/assistant-pet-set ${change.kind} ${change.assistantId} ${change.value}`;
}

// src/client/skills-view.ts
var SKILLS_UNAVAILABLE = { unavailable: true, message: null, skills: [], pending: [], unverified: [] };
function record2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function rows(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const r = record2(item);
    if (!r || typeof r.id !== "string" || typeof r.name !== "string") return [];
    return [{
      id: r.id,
      assistantId: typeof r.assistantId === "string" ? r.assistantId : "",
      assistantName: typeof r.assistantName === "string" ? r.assistantName : String(r.assistantId ?? ""),
      name: r.name,
      body: typeof r.body === "string" ? r.body : "",
      version: typeof r.version === "number" ? r.version : 1,
      status: typeof r.status === "string" ? r.status : "candidate",
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      origin: typeof r.origin === "string" ? r.origin : "manual"
    }];
  });
}
function evidence(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const r = record2(item);
    if (!r || typeof r.shape !== "string") return [];
    return [{
      assistantId: typeof r.assistantId === "string" ? r.assistantId : "",
      assistantName: typeof r.assistantName === "string" ? r.assistantName : String(r.assistantId ?? ""),
      shape: r.shape,
      count: typeof r.count === "number" ? r.count : 0
    }];
  });
}
function parseSkills(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...SKILLS_UNAVAILABLE, message: "\u6682\u65F6\u8BFB\u4E0D\u5230\u6280\u80FD" };
  }
  const body = record2(parsed);
  if (!body || body.ok === false) return { ...SKILLS_UNAVAILABLE, message: typeof body?.message === "string" ? body.message : "\u6682\u65F6\u8BFB\u4E0D\u5230\u6280\u80FD" };
  return {
    unavailable: false,
    message: null,
    skills: rows(body.skills),
    pending: evidence(body.pending),
    unverified: evidence(body.unverified)
  };
}
var ORIGIN_LABEL = {
  manual: "\u4EBA\u5DE5/\u663E\u5F0F\u63D0\u4EA4",
  "auto-verified": "\u81EA\u52A8\xB7\u672C\u4EBA\u786E\u8BA4\u6837\u672C",
  "auto-selfreport": "\u81EA\u52A8\xB7\u6210\u5458\u81EA\u62A5\uFF08\u5F85\u67E5\u9A8C\uFF09"
};
var STATUS_LABEL = {
  active: "\u751F\u6548\u4E2D",
  candidate: "\u5019\u9009",
  retired: "\u5DF2\u9000\u5F79"
};

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var PANEL_ID = "personal-assistant";
var inject = ["slots", "uiSession", "remote", "remote.commands"];
var KNOWN_COMMANDS = [
  "summon-pet",
  "bind-pet",
  "assistant-on",
  "assistant-off",
  "assistant-state",
  "open-workbench",
  "assistant-pet-config",
  "assistant-pet-set"
];
var OVERVIEW_COMMANDS = {
  todo: "/assistant-todo-count",
  meeting: "/assistant-meeting-today",
  summary: "/assistant-today-summary"
};
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
function currentSessionId(ctx) {
  try {
    return ctx.uiSession?.current?.getSnapshot()?.key;
  } catch {
    return void 0;
  }
}
async function executeCommand(ctx, line) {
  const id = currentSessionId(ctx);
  if (!id) return { ok: false, text: "\u5148\u5728\u5DE6\u4FA7\u6253\u5F00\u6216\u65B0\u5EFA\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u518D\u70B9\u8FD9\u91CC" };
  try {
    const response = await ctx.remote?.commands?.execute(id, line, []);
    if (!response) return { ok: false, text: "\u547D\u4EE4\u901A\u9053\u8FD8\u6CA1\u5C31\u7EEA\uFF0C\u7A0D\u540E\u518D\u8BD5" };
    if (!response.ok) return { ok: false, text: response.error?.message ?? "\u547D\u4EE4\u6CA1\u80FD\u6267\u884C" };
    const outcome = response.value?.result;
    return { ok: outcome?.kind !== "error", text: outcome?.text ?? "\u5DF2\u6267\u884C" };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}
function parsePort(text) {
  const matched = /桥接端口\s*(\d{2,5})/u.exec(text);
  return matched === null ? null : Number(matched[1]);
}
function BindSessionButton({ ctx }) {
  const [state, setState] = (0, import_react.useState)("idle");
  const [hint, setHint] = (0, import_react.useState)("");
  const bind = async () => {
    setState("busy");
    setHint("");
    const outcome = await executeCommand(ctx, "/bind-pet");
    setState(outcome.ok ? "done" : "error");
    setHint(outcome.text);
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
var OVERVIEW = [
  { icon: "checklist", label: "\u5F85\u529E", command: "todo" },
  { icon: "calendar", label: "\u4ECA\u5929\u4F1A\u8BAE", command: "meeting" },
  { icon: "clock", label: "\u4ECA\u65E5\u6D3B\u52A8", command: "summary" },
  { icon: "document", label: "\u65E5\u62A5\u8349\u7A3F", command: null }
];
function isListTab(tab) {
  return tab === "todo" || tab === "report" || tab === "meeting" || tab === "team";
}
var MEETING_LIST_TTL_MS = 3e4;
var SETTINGS_TTL_MS = 3e4;
var HISTORY_TTL_MS = 6e4;
var NARROW_TABLE_CSS = narrowTableCss();
function AssistantPanel({ ctx }) {
  const [busy, setBusy] = (0, import_react.useState)(null);
  const [power, setPower] = (0, import_react.useState)(null);
  const [petReload, setPetReload] = (0, import_react.useState)(0);
  const [bound, setBound] = (0, import_react.useState)({ bound: false, port: null });
  const [outcome, setOutcome] = (0, import_react.useState)(null);
  const [readouts, setReadouts] = (0, import_react.useState)(null);
  const [readingOverview, setReadingOverview] = (0, import_react.useState)(false);
  const [tab, setTab] = (0, import_react.useState)("todo");
  const [lists, setLists] = (0, import_react.useState)({});
  const [listLoading, setListLoading] = (0, import_react.useState)({});
  const listFetchedAt = (0, import_react.useRef)({});
  const [settings, setSettings] = (0, import_react.useState)(void 0);
  const [settingsLoading, setSettingsLoading] = (0, import_react.useState)(false);
  const [optionValues, setOptionValues] = (0, import_react.useState)({});
  const [optionSaving, setOptionSaving] = (0, import_react.useState)(null);
  const [optionErrors, setOptionErrors] = (0, import_react.useState)({});
  const settingsFetchedAt = (0, import_react.useRef)(0);
  const [history, setHistory] = (0, import_react.useState)(void 0);
  const [historyLoading, setHistoryLoading] = (0, import_react.useState)(false);
  const historyFetchedAt = (0, import_react.useRef)(0);
  const [pendingPriority, setPendingPriority] = (0, import_react.useState)({});
  const [priorityBusy, setPriorityBusy] = (0, import_react.useState)(null);
  const [priorityNotice, setPriorityNotice] = (0, import_react.useState)(null);
  const [taskEdit, setTaskEdit] = (0, import_react.useState)(null);
  const [meetingEdit, setMeetingEdit] = (0, import_react.useState)(null);
  const [editNotice, setEditNotice] = (0, import_react.useState)(null);
  const [editBusy, setEditBusy] = (0, import_react.useState)(null);
  const sessionId = currentSessionId(ctx);
  const refreshPower = async () => {
    if (currentSessionId(ctx) === void 0) {
      setPower(null);
      return;
    }
    const result2 = await executeCommand(ctx, "/assistant-state");
    setPower(result2.ok ? parseAssistantState(result2.text) : { injection: "unknown", capture: "unknown", blocked: null });
  };
  (0, import_react.useEffect)(() => {
    void refreshPower();
  }, [ctx, sessionId]);
  (0, import_react.useEffect)(() => {
    if (currentSessionId(ctx) === void 0) {
      setReadouts(null);
      setReadingOverview(false);
      return;
    }
    let cancelled = false;
    setReadingOverview(true);
    const read = async (command) => {
      try {
        const result2 = await executeCommand(ctx, OVERVIEW_COMMANDS[command]);
        return overviewValue(command, result2.ok ? result2.text : "\u6682\u65F6\u8BFB\u4E0D\u5230");
      } catch {
        return overviewValue(command, "\u6682\u65F6\u8BFB\u4E0D\u5230");
      }
    };
    void Promise.all([read("todo"), read("meeting"), read("summary")]).then(([todo, meeting, summary]) => {
      if (cancelled) return;
      setReadouts({ todo, meeting, summary });
      setReadingOverview(false);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx, sessionId]);
  const loadList = async (id, options = {}) => {
    if (sessionId === void 0) return void 0;
    const definition = LIST_TABS[id];
    const command = definition.command;
    if (command === null) return void 0;
    const fetchedAt = listFetchedAt.current[id];
    const ttl = id === "meeting" ? MEETING_LIST_TTL_MS : 0;
    if (options.force !== true && fetchedAt !== void 0 && Date.now() - fetchedAt < ttl) {
      return lists[id];
    }
    setListLoading((previous) => ({ ...previous, [id]: true }));
    const result2 = await executeCommand(ctx, command);
    const parsed = parseList(result2.ok ? result2.text : "\u6682\u65F6\u8BFB\u4E0D\u5230", definition);
    listFetchedAt.current[id] = Date.now();
    setLists((previous) => ({ ...previous, [id]: parsed }));
    if (id === "todo") setPendingPriority((previous) => reconcilePending(previous, parsed.rows));
    setListLoading((previous) => ({ ...previous, [id]: false }));
    return parsed;
  };
  (0, import_react.useEffect)(() => {
    if (!isListTab(tab)) return;
    void loadList(tab);
  }, [ctx, sessionId, tab]);
  (0, import_react.useEffect)(() => {
    if (tab !== "meeting") return;
    if (sessionId === void 0) return;
    if (historyFetchedAt.current !== 0 && Date.now() - historyFetchedAt.current < HISTORY_TTL_MS) return;
    let cancelled = false;
    setHistoryLoading(true);
    void executeCommand(ctx, MEETING_HISTORY_COMMAND).then((result2) => {
      if (cancelled) return;
      historyFetchedAt.current = Date.now();
      setHistory(parseList(result2.ok ? result2.text : "\u6682\u65F6\u8BFB\u4E0D\u5230\u5386\u53F2\u4F1A\u8BAE", MEETING_HISTORY));
      setHistoryLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx, sessionId, tab]);
  const setPriority = async (taskId, value) => {
    const command = priorityCommand(taskId, value);
    if (command === null) {
      setPriorityNotice({ tone: "bad", text: "\u8FD9\u4E00\u884C\u6682\u65F6\u6539\u4E0D\u4E86\uFF08\u4EFB\u52A1\u53F7\u4E0D\u53EF\u7528\uFF09" });
      return;
    }
    setPriorityBusy(taskId);
    setPriorityNotice(null);
    try {
      const result2 = await executeCommand(ctx, command);
      const parsed = await loadList("todo", { force: true });
      const outcome2 = parsed === void 0 ? "pending" : priorityOutcome(parsed.rows, taskId, value);
      if (outcome2 === "gone") {
        setPendingPriority((previous) => removeKey(previous, taskId));
        setPriorityNotice({ tone: "warn", text: "\u5217\u8868\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0" });
        return;
      }
      if (!result2.ok) {
        setPendingPriority((previous) => removeKey(previous, taskId));
        setPriorityNotice({ tone: "bad", text: result2.text });
        return;
      }
      if (outcome2 === "applied") {
        setPendingPriority((previous) => removeKey(previous, taskId));
        setPriorityNotice({ tone: "ok", text: result2.text });
        return;
      }
      setPendingPriority((previous) => ({ ...previous, [taskId]: value }));
      setPriorityNotice({ tone: "warn", text: "\u5DF2\u63D0\u4EA4\uFF0C\u8BF7\u5728\u684C\u9762\u5BA0\u7269\u91CC\u786E\u8BA4" });
    } finally {
      setPriorityBusy(null);
    }
  };
  const setOption = async (key, value) => {
    const previous = optionValues[key];
    setOptionValues((current) => ({ ...current, [key]: value }));
    setOptionErrors((current) => ({ ...current, [key]: void 0 }));
    setOptionSaving(key);
    try {
      const result2 = await executeCommand(ctx, optionCommand(key, value));
      const reason = setOptionFailure(result2.text);
      const failure = result2.ok ? reason : reason ?? result2.text;
      if (failure !== null) {
        setOptionValues((current) => ({ ...current, [key]: previous }));
        setOptionErrors((current) => ({ ...current, [key]: failure }));
      }
      const refreshed = await executeCommand(ctx, SETTINGS_SUMMARY_COMMAND);
      if (refreshed.ok) {
        const parsed = parseSettingsSummary(refreshed.text);
        setSettings(parsed);
        if (parsed.state === "rows") setOptionValues(optionValuesOf(parsed.rows));
      }
      settingsFetchedAt.current = Date.now();
    } finally {
      setOptionSaving(null);
    }
  };
  (0, import_react.useEffect)(() => {
    if (tab !== "settings") return;
    if (sessionId === void 0) return;
    if (settingsFetchedAt.current !== 0 && Date.now() - settingsFetchedAt.current < SETTINGS_TTL_MS) return;
    let cancelled = false;
    setSettingsLoading(true);
    void executeCommand(ctx, SETTINGS_SUMMARY_COMMAND).then((result2) => {
      if (cancelled) return;
      settingsFetchedAt.current = Date.now();
      const parsed = parseSettingsSummary(result2.ok ? result2.text : "\u6682\u65F6\u8BFB\u4E0D\u5230\u8BBE\u7F6E");
      setSettings(parsed);
      if (parsed.state === "rows") setOptionValues(optionValuesOf(parsed.rows));
      setSettingsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [ctx, sessionId, tab]);
  const run = async (kind, line) => {
    setBusy(kind);
    try {
      const result2 = await executeCommand(ctx, line);
      setOutcome(result2);
      if (result2.ok && (kind === "summon" || kind === "bind")) {
        setBound({ bound: true, port: parsePort(result2.text) });
      }
      if (kind === "summon" && result2.ok) setPetReload((value) => value + 1);
      if (kind === "assistant") void refreshPower();
    } finally {
      setBusy(null);
    }
  };
  const openInPet = async (pageName) => {
    setBusy("open");
    try {
      const result2 = await executeCommand(ctx, `/open-workbench ${pageName}`);
      setOutcome(result2);
    } finally {
      setBusy(null);
    }
  };
  const runEdit = async (key, line, close) => {
    setEditBusy(key);
    setEditNotice(null);
    try {
      const result2 = await executeCommand(ctx, line);
      setEditNotice({ tone: result2.ok ? "ok" : "bad", text: result2.text });
      if (result2.ok) {
        if (isListTab(tab)) await loadList(tab, { force: true });
        close?.();
      }
    } finally {
      setEditBusy(null);
    }
  };
  const editNoticeNode = editNotice === null ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "status", style: { margin: "8px 0 0", fontSize: 12, color: editNotice.tone === "ok" ? TOKENS.ok : TOKENS.bad }, children: editNotice.text });
  const todoExtra = {
    label: "\u64CD\u4F5C",
    width: "116px",
    render: (row) => {
      const id = rowTaskId(row);
      if (id === null) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: tableHint, children: "\u2014" });
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", gap: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: smallButton,
            disabled: editBusy !== null,
            onClick: () => {
              setTaskEdit({ taskId: id, title: row.cells[0] ?? "" });
              setEditNotice(null);
            },
            children: "\u4FEE\u6539"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: smallButton,
            disabled: editBusy !== null,
            onClick: () => void runEdit(`cancel:${id}`, `/assistant-task-set cancel ${id}`),
            children: "\u5220\u9664"
          }
        )
      ] });
    }
  };
  const meetingExtra = {
    label: "\u64CD\u4F5C",
    width: "140px",
    render: (row) => {
      const id = rowMeetingId(row);
      if (id === null) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: tableHint, children: "\u2014" });
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", gap: 6 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: smallButton,
            disabled: editBusy !== null,
            onClick: () => {
              setMeetingEdit({ meetingId: id, name: row.cells[1] ?? "" });
              setEditNotice(null);
            },
            children: "\u91CD\u547D\u540D"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: smallButton,
            disabled: editBusy !== null,
            onClick: () => void runEdit(`meeting-del:${id}`, `/assistant-meeting-set delete ${id}`),
            children: "\u5220\u9664"
          }
        )
      ] });
    }
  };
  const todoFooter = /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    taskEdit !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      TaskEditBar,
      {
        edit: taskEdit,
        busy: editBusy !== null,
        onClose: () => setTaskEdit(null),
        onSubmit: (kind, value) => void runEdit(`${kind}:${taskEdit.taskId}`, `/assistant-task-set ${kind} ${taskEdit.taskId} ${value}`, () => setTaskEdit(null))
      }
    ),
    editNoticeNode
  ] });
  const meetingFooter = /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    meetingEdit !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      MeetingEditBar,
      {
        edit: meetingEdit,
        busy: editBusy !== null,
        onClose: () => setMeetingEdit(null),
        onSubmit: (name) => void runEdit(`meeting-rename:${meetingEdit.meetingId}`, `/assistant-meeting-set rename ${meetingEdit.meetingId} ${name}`, () => setMeetingEdit(null))
      }
    ),
    editNoticeNode
  ] });
  const connected = sessionId !== void 0 && bound.bound;
  const dotColor = outcome !== null && !outcome.ok ? TOKENS.amber : connected ? TOKENS.green : TOKENS.grey;
  const injectionOn = power?.injection === "on";
  const powerText = power === null || power.injection === "unknown" ? "" : injectionOn ? " \xB7 \u52A9\u7406\u5DF2\u5F00\u542F" : " \xB7 \u52A9\u7406\u5DF2\u5173\u95ED";
  const captureText = power?.capture === "recording" ? " \xB7 \u8BB0\u5F55\u4E2D" : power?.capture === "pending" ? " \xB7 \u91C7\u96C6\u5F85\u786E\u8BA4" : power?.capture === "blocked" ? " \xB7 \u91C7\u96C6\u88AB\u62E6" : "";
  const connectionText = sessionId === void 0 ? "\u5C1A\u672A\u6253\u5F00\u4F1A\u8BDD" : connected ? `\u4F1A\u8BDD\u5DF2\u7ED1\u5B9A${bound.port === null ? "" : ` \xB7 \u6865\u63A5\u7AEF\u53E3 ${bound.port}`}${powerText}${captureText}` : `\u672A\u7ED1\u5B9A${powerText}${captureText}`;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: page, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("style", { children: NARROW_TABLE_CSS }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("header", { style: header, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: titleRow, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { style: title, children: "\u4E2A\u4EBA\u52A9\u7406" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: badge, children: connected ? "\u5DF2\u5C31\u7EEA" : "\u672A\u8FDE\u63A5" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: subtitle, children: "\u53EC\u5524\u684C\u9762\u5BA0\u7269\u3001\u67E5\u770B\u5F85\u529E\u4E0E\u4F1A\u8BAE\u3001\u6574\u7406\u65E5\u62A5\uFF1B\u6240\u6709\u5199\u64CD\u4F5C\u4ECD\u8D70\u4F60\u672C\u4EBA\u786E\u8BA4\u3002" })
    ] }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: statusBar, "aria-label": "\u8FDE\u63A5\u72B6\u6001", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: statusRow, title: power?.blocked ?? void 0, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { style: dot(dotColor) }),
        connectionText
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "flex", gap: 8, flexWrap: "wrap" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy !== null, onClick: () => void run("summon", "/summon-pet"), style: smallButton, children: busy === "summon" ? "\u53EC\u5524\u4E2D\u2026" : "\u53EC\u5524\u5BA0\u7269" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            disabled: busy !== null,
            onClick: () => void run("assistant", injectionOn ? "/assistant-off" : "/assistant-on"),
            style: smallButton,
            children: busy === "assistant" ? "\u5904\u7406\u4E2D\u2026" : injectionOn ? "\u5173\u95ED\u4E2A\u4EBA\u52A9\u7406" : "\u5F00\u542F\u4E2A\u4EBA\u52A9\u7406"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy !== null, onClick: () => void run("bind", "/bind-pet"), style: smallButton, children: busy === "bind" ? "\u7ED1\u5B9A\u4E2D\u2026" : "\u4EC5\u7ED1\u5B9A\u4F1A\u8BDD" })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...result, marginTop: 6, color: outcome === null ? TOKENS.faint : outcome.ok ? TOKENS.ok : TOKENS.bad }, children: outcome === null ? "\u8FD8\u6CA1\u6709\u6267\u884C\u64CD\u4F5C" : outcome.text }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: statGrid, children: OVERVIEW.map((item) => {
      const readout = item.command === null ? null : readouts?.[item.command] ?? null;
      const loadingThis = item.command !== null && readingOverview && readout === null;
      const value = item.command === null ? "\u2014" : loadingThis ? "\u8BFB\u53D6\u4E2D\u2026" : readout === null ? "\u672A\u8FDE\u63A5" : readout.value;
      const note = readout?.kind === "metric" && readout.detail !== null ? readout.detail : item.command === null ? "\u672A\u8FDE\u63A5" : null;
      const muted = item.command === null || loadingThis || readout === null || readout.kind === "unavailable";
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: statTile, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...readout?.kind === "metric" ? statValue : statValueSmall, color: muted ? TOKENS.faint : TOKENS.ink }, children: value }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: statLabel, children: item.label }),
        note !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: statNote, children: note })
      ] }, item.label);
    }) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("nav", { style: tabBar, role: "tablist", "aria-label": "\u5DE5\u4F5C\u53F0\u9875\u9762", children: TABS.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        role: "tab",
        "aria-selected": tab === item.id,
        onClick: () => setTab(item.id),
        style: tabButton(tab === item.id),
        children: item.label
      },
      item.id
    )) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tabPanel, role: "tabpanel", children: tab === "mail" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      ConfigFormPanel,
      {
        ctx,
        title: "\u90AE\u4EF6",
        description: "\u5BA1\u6279\u53D1\u4FE1\u7528\u7684\u90AE\u7BB1\u3002\u586B\u597D\u4FDD\u5B58\u5373\u53EF\uFF0C\u968F\u540E\u5BA1\u6279\u90AE\u4EF6\u7684\u53D1\u4FE1\u4F1A\u7528\u8FD9\u5957\u914D\u7F6E\u3002",
        fields: MAIL_FIELDS,
        command: "assistant-mail-config",
        validate: validateMail,
        passwordKeys: ["password"],
        readSnapshot: parseMailSnapshot
      }
    ) : tab === "wecom" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      ConfigFormPanel,
      {
        ctx,
        title: "\u4F01\u4E1A\u5FAE\u4FE1",
        description: "\u4F01\u4E1A\u5FAE\u4FE1\u5E94\u7528\u7684\u8FDE\u63A5\u4FE1\u606F\u3002\u586B\u597D\u4FDD\u5B58\u5373\u53EF\uFF0C\u968F\u540E\u6D88\u606F\u63A8\u9001\u4E0E\u5BA1\u6279\u4F1A\u7528\u8FD9\u5957\u914D\u7F6E\u3002",
        fields: WECOM_FIELDS,
        command: "assistant-wecom-config",
        validate: validateWecom,
        passwordKeys: ["secret"],
        readSnapshot: parseWecomSnapshot
      }
    ) : tab === "skills" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SkillsPanel, { ctx, connected: sessionId !== void 0 }) : tab === "pet" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      PetConfigPanel,
      {
        ctx,
        connected: sessionId !== void 0,
        reloadToken: petReload,
        summoning: busy === "summon",
        onSummon: () => void run("summon", "/summon-pet")
      }
    ) : tab === "settings" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      SettingsPanel,
      {
        values: optionValues,
        loading: settingsLoading,
        connected: sessionId !== void 0,
        saving: optionSaving,
        errors: optionErrors,
        onSet: (key, value) => void setOption(key, value)
      }
    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        ListPanel,
        {
          tab,
          result: lists[tab],
          loading: listLoading[tab] === true,
          connected: sessionId !== void 0,
          busy: busy === "open",
          onOpen: (pageName) => void openInPet(pageName),
          ...tab === "todo" ? {
            priority: {
              pending: pendingPriority,
              busyId: priorityBusy,
              notice: priorityNotice,
              onPick: (taskId, value) => void setPriority(taskId, value)
            },
            extra: todoExtra,
            footer: todoFooter
          } : {},
          ...tab === "meeting" ? { extra: meetingExtra, footer: meetingFooter } : {}
        }
      ),
      tab === "meeting" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        MeetingHistoryPanel,
        {
          result: history,
          loading: historyLoading,
          connected: sessionId !== void 0,
          busy: busy === "open",
          onOpen: (pageName) => void openInPet(pageName),
          extra: meetingExtra,
          footer: meetingFooter
        }
      )
    ] }) })
  ] });
}
function columnFlex(width) {
  if (width === void 0) return "1 1 0";
  return width.endsWith("px") ? `0 0 ${width}` : width;
}
function removeKey(record3, key) {
  const next = { ...record3 };
  delete next[key];
  return next;
}
function PriorityCell({ value, pending, busy, onOpen }) {
  const tone = columnTone("priority", value) ?? TOKENS.muted;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }, children: [
    pending !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { title: "\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u5728\u684C\u9762\u5BA0\u7269\u91CC\u786E\u8BA4", style: dot(TOKENS.amber), "aria-label": "\u5F85\u786E\u8BA4" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        "aria-haspopup": "menu",
        disabled: busy,
        onClick: onOpen,
        title: pending === void 0 ? "\u70B9\u51FB\u4FEE\u6539\u4F18\u5148\u7EA7" : "\u5DF2\u63D0\u4EA4\uFF0C\u7B49\u5F85\u5728\u684C\u9762\u5BA0\u7269\u91CC\u786E\u8BA4",
        style: {
          font: "inherit",
          padding: 0,
          border: "none",
          background: "transparent",
          color: tone,
          cursor: busy ? "progress" : "pointer",
          borderBottom: `1px dashed ${TOKENS.line}`,
          opacity: busy ? 0.5 : pending === void 0 ? 1 : 0.55,
          maxWidth: "100%",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap"
        },
        children: value
      }
    )
  ] });
}
function TableBody({ definition, page: page2, result: result2, loading, connected, busy, onOpen, keyPrefix, rightAlignLast = false, renderCell, extra }) {
  const state = result2?.state;
  const message = loading ? tableView("loading", definition).message : !connected ? "\u672A\u8FDE\u63A5" : state === "empty" ? result2?.message ?? definition.empty : result2?.message ?? definition.unavailable;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: tableWrap, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: tableHeadRow, children: [
      definition.columns.map((column, index) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "span",
        {
          className: columnClassName(keyPrefix, column.key),
          style: {
            flex: columnFlex(column.width),
            minWidth: 0,
            textAlign: rightAlignLast && index === definition.columns.length - 1 ? "right" : "left"
          },
          children: column.label
        },
        column.key
      )),
      extra !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: columnFlex(extra.width), minWidth: 0 }, children: extra.label })
    ] }),
    state === "rows" && result2 !== void 0 ? result2.rows.map((row, rowIndex) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: tableRow, children: [
      row.cells.map((cell, cellIndex) => {
        const column = definition.columns[cellIndex];
        const tone = columnTone(column?.key, cell);
        return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "span",
          {
            className: column === void 0 ? void 0 : columnClassName(keyPrefix, column.key),
            style: {
              flex: columnFlex(column?.width),
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              textAlign: rightAlignLast && cellIndex === definition.columns.length - 1 ? "right" : "left",
              ...tone === void 0 ? {} : { color: tone ?? TOKENS.muted }
            },
            title: cell,
            children: renderCell === void 0 || column === void 0 ? cell : renderCell({ row, column, cell })
          },
          cellIndex
        );
      }),
      extra !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { flex: columnFlex(extra.width), minWidth: 0 }, children: extra.render(row) })
    ] }, rowIndex)) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: tableEmpty, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: message }),
      !loading && state !== "empty" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: busy, onClick: () => onOpen(page2), style: secondaryButton, children: busy ? "\u6253\u5F00\u4E2D\u2026" : "\u5728\u684C\u9762\u5BA0\u7269\u91CC\u6253\u5F00" })
    ] })
  ] });
}
function ListPanel({ tab, result: result2, loading, connected, busy, onOpen, priority, extra, footer }) {
  const definition = LIST_TABS[tab];
  const [editing, setEditing] = (0, import_react.useState)(null);
  const renderCell = priority === void 0 || tab !== "todo" ? void 0 : ({ row, column, cell }) => {
    if (column.key !== "priority") return cell;
    const taskId = rowTaskId(row);
    if (taskId === null) return cell;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      PriorityCell,
      {
        value: cell,
        pending: priority.pending[taskId],
        busy: priority.busyId === taskId,
        onOpen: () => setEditing({ taskId, title: row.cells[0]?.trim() ?? taskId, value: cell })
      }
    );
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { "aria-label": definition.hint, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      TableBody,
      {
        definition,
        page: tab,
        result: result2,
        loading,
        connected,
        busy,
        onOpen,
        keyPrefix: tab,
        renderCell,
        extra
      }
    ),
    footer,
    priority !== void 0 && editing !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        role: "menu",
        "aria-label": `\u4FEE\u6539\u300C${editing.title}\u300D\u7684\u4F18\u5148\u7EA7`,
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginTop: 8,
          padding: "8px 12px",
          border: `1px solid ${TOKENS.line}`,
          borderRadius: 10,
          background: TOKENS.soft
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12, color: TOKENS.muted }, children: [
            "\u628A\u300C",
            editing.title,
            "\u300D\u6539\u6210\uFF08\u5F53\u524D ",
            editing.value,
            "\uFF09\uFF1A"
          ] }),
          PRIORITY_CHOICES.map((choice) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "button",
            {
              type: "button",
              role: "menuitem",
              disabled: priority.busyId !== null,
              onClick: () => {
                const picked = editing;
                setEditing(null);
                priority.onPick(picked.taskId, choice.value);
              },
              style: choice.label === editing.value ? { ...smallButton, fontWeight: 600 } : smallButton,
              children: choice.label
            },
            choice.value
          )),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", onClick: () => setEditing(null), style: secondaryButton, children: "\u53D6\u6D88" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...tableHint, flexBasis: "100%" }, children: "\u8FD9\u6761\u8D70\u5BA1\u6279\uFF1A\u63D0\u4EA4\u540E\u9700\u8981\u4F60\u5728\u684C\u9762\u5BA0\u7269\u91CC\u786E\u8BA4\uFF0C\u5217\u8868\u624D\u4F1A\u53D8\u3002" })
        ]
      }
    ),
    priority !== void 0 && priority.notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "p",
      {
        role: "status",
        style: {
          margin: "8px 0 0",
          fontSize: 12,
          color: priority.notice.tone === "ok" ? TOKENS.ok : priority.notice.tone === "bad" ? TOKENS.bad : TOKENS.amber
        },
        children: priority.notice.text
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...tableHint, marginTop: 8 }, children: definition.hint })
  ] });
}
function MeetingHistoryPanel({ result: result2, loading, connected, busy, onOpen, extra, footer }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { "aria-label": "\u6700\u8FD1\u4F1A\u8BAE", style: { marginTop: 18 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", margin: "0 0 8px" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 13 }, children: "\u6700\u8FD1\u4F1A\u8BAE" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: tableHint, children: "\u6700\u591A\u663E\u793A 20 \u6761" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      TableBody,
      {
        definition: MEETING_HISTORY,
        page: "meeting",
        result: result2,
        loading,
        connected,
        busy,
        onOpen,
        keyPrefix: "history",
        rightAlignLast: true,
        extra
      }
    ),
    footer
  ] });
}
function SettingsPanel({ values, loading, connected, saving, errors, onSet }) {
  const unavailable = loading ? "\u8BFB\u53D6\u4E2D\u2026" : !connected ? "\u672A\u8FDE\u63A5" : null;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { "aria-label": "\u901A\u7528\u8BBE\u7F6E", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: tableWrap, children: [
      unavailable !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableEmpty, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: unavailable }) }),
      SETTINGS_OPTIONS.map((definition) => {
        const selected = values[definition.key];
        const busy = saving === definition.key;
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...summaryRow, alignItems: "center", gap: 12, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { minWidth: 72 }, children: definition.label }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { role: "group", "aria-label": definition.label, style: { display: "inline-flex", gap: 6, flexWrap: "wrap" }, children: [
            definition.choices.map((choice) => {
              const active = selected === choice.value;
              return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  "aria-pressed": active,
                  disabled: busy,
                  onClick: () => onSet(definition.key, choice.value),
                  style: {
                    ...smallButton,
                    // 选中态用品牌色描边 + 极浅底：与设置页的选中语言一致，不引入新控件。
                    ...active ? { borderColor: "rgba(74,125,255,.55)", background: "rgba(74,125,255,.08)", color: TOKENS.primary } : {},
                    opacity: busy ? 0.6 : 1,
                    cursor: busy ? "progress" : "pointer"
                  },
                  children: busy && active ? "\u4FDD\u5B58\u4E2D\u2026" : choice.label
                },
                choice.value
              );
            }),
            selected === void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: tableHint, children: "\u672A\u77E5\uFF08\u670D\u52A1\u7AEF\u6CA1\u7ED9\u8FD9\u4E00\u9879\uFF09" })
          ] }),
          errors[definition.key] !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: TOKENS.bad, fontSize: 12, flexBasis: "100%" }, role: "alert", children: errors[definition.key] })
        ] }, definition.key);
      })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...tableHint, marginTop: 8 }, children: "\u6539\u5B8C\u7ACB\u5373\u751F\u6548\uFF1B\u5931\u8D25\u4F1A\u663E\u793A\u5177\u4F53\u539F\u56E0\uFF0C\u5E76\u9000\u56DE\u539F\u6765\u7684\u9009\u62E9\u3002" })
  ] });
}
var editBarStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 8,
  padding: "8px 12px",
  border: `1px solid ${TOKENS.line}`,
  borderRadius: 10,
  background: TOKENS.soft
};
var editInputStyle = {
  font: "inherit",
  fontSize: 12.5,
  padding: "4px 8px",
  borderRadius: 8,
  border: `1px solid ${TOKENS.line}`,
  background: "#fff",
  color: TOKENS.ink
};
function TaskEditBar({ edit, busy, onSubmit, onClose }) {
  const [title2, setTitle] = (0, import_react.useState)(edit.title);
  const [deadline, setDeadline] = (0, import_react.useState)("");
  const [interval, setInterval] = (0, import_react.useState)("");
  const [problem, setProblem] = (0, import_react.useState)(null);
  const submit = (kind, raw) => {
    if (kind === "title") {
      const value = raw.trim();
      if (value === "" || value.length > 200) {
        setProblem("\u6807\u9898\u9700\u4E3A 1\u2013200 \u5B57");
        return;
      }
      setProblem(null);
      onSubmit(kind, value);
      return;
    }
    if (kind === "deadline") {
      if (raw === "") {
        setProblem("\u5148\u9009\u4E00\u4E2A\u65F6\u95F4");
        return;
      }
      const ms = new Date(raw).getTime();
      if (!Number.isFinite(ms)) {
        setProblem("\u65F6\u95F4\u4E0D\u5408\u6CD5");
        return;
      }
      setProblem(null);
      onSubmit(kind, String(ms));
      return;
    }
    const seconds = Number(raw);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 604800) {
      setProblem("\u95F4\u9694\u9700\u4E3A 60\u2013604800 \u79D2");
      return;
    }
    setProblem(null);
    onSubmit(kind, String(seconds));
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { role: "group", "aria-label": `\u4FEE\u6539\u5F85\u529E\u300C${edit.title}\u300D`, style: editBarStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12, color: TOKENS.muted, flexBasis: "100%" }, children: [
      "\u4FEE\u6539\u300C",
      edit.title,
      "\u300D\uFF1A"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }, children: [
      "\u6807\u9898",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: { ...editInputStyle, width: 160 }, value: title2, disabled: busy, onChange: (e) => setTitle(e.target.value) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy, onClick: () => submit("title", title2), children: "\u4FDD\u5B58\u6807\u9898" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }, children: [
      "\u5230\u671F",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "datetime-local", style: editInputStyle, value: deadline, disabled: busy, onChange: (e) => setDeadline(e.target.value) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy, onClick: () => submit("deadline", deadline), children: "\u4FDD\u5B58\u6539\u671F" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }, children: [
      "\u95F4\u9694\u79D2",
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { type: "number", style: { ...editInputStyle, width: 90 }, value: interval, disabled: busy, onChange: (e) => setInterval(e.target.value) })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy, onClick: () => submit("interval", interval), children: "\u4FDD\u5B58\u95F4\u9694" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: secondaryButton, disabled: busy, onClick: onClose, children: "\u5173\u95ED" }),
    problem !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "alert", style: { color: TOKENS.bad, fontSize: 12, flexBasis: "100%" }, children: problem }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...tableHint, flexBasis: "100%" }, children: "\u6539\u6807\u9898/\u6539\u671F\u63D0\u4EA4\u540E\u9700\u5728\u684C\u9762\u5BA0\u7269\u786E\u8BA4\u624D\u751F\u6548\uFF1B\u95F4\u9694\u4E0E\u5220\u9664\u5728\u684C\u9762\u5F39\u7A97\u786E\u8BA4\u3002\u91CD\u590D\u63D0\u9192\u6539\u671F\u53EA\u6362\u9996\u6B21\u65F6\u95F4\uFF0C\u4E0D\u62B9\u6389\u91CD\u590D\u89C4\u5219\u3002" })
  ] });
}
function MeetingEditBar({ edit, busy, onSubmit, onClose }) {
  const [name, setName] = (0, import_react.useState)(edit.name);
  const [problem, setProblem] = (0, import_react.useState)(null);
  const submit = () => {
    const value = name.trim();
    if (value === "" || value.length > 200) {
      setProblem("\u540D\u79F0\u9700\u4E3A 1\u2013200 \u5B57");
      return;
    }
    setProblem(null);
    onSubmit(value);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { role: "group", "aria-label": `\u91CD\u547D\u540D\u4F1A\u8BAE\u300C${edit.name}\u300D`, style: editBarStyle, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12, color: TOKENS.muted }, children: [
      "\u91CD\u547D\u540D\u300C",
      edit.name,
      "\u300D\u4E3A\uFF1A"
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: { ...editInputStyle, width: 200 }, value: name, disabled: busy, onChange: (e) => setName(e.target.value) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy, onClick: submit, children: "\u4FDD\u5B58\u540D\u79F0" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: secondaryButton, disabled: busy, onClick: onClose, children: "\u5173\u95ED" }),
    problem !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "alert", style: { color: TOKENS.bad, fontSize: 12, flexBasis: "100%" }, children: problem })
  ] });
}
function SkillsPanel({ ctx, connected }) {
  const [snap, setSnap] = (0, import_react.useState)(null);
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(null);
  const [editing, setEditing] = (0, import_react.useState)(null);
  const [creating, setCreating] = (0, import_react.useState)(false);
  const [cAssistant, setCAssistant] = (0, import_react.useState)("");
  const [cName, setCName] = (0, import_react.useState)("");
  const [cBody, setCBody] = (0, import_react.useState)("");
  const load = async () => {
    if (!connected) {
      setSnap(null);
      return;
    }
    setLoading(true);
    try {
      const result2 = await executeCommand(ctx, "/assistant-skills");
      setSnap(parseSkills(result2.ok ? result2.text : ""));
    } finally {
      setLoading(false);
    }
  };
  (0, import_react.useEffect)(() => {
    void load();
  }, [ctx, connected]);
  const run = async (key, line, after) => {
    setBusy(key);
    setNotice(null);
    try {
      const result2 = await executeCommand(ctx, line);
      setNotice({ ok: result2.ok, text: result2.text });
      if (result2.ok) {
        await load();
        after?.();
      }
    } finally {
      setBusy(null);
    }
  };
  if (!connected) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableWrap, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableEmpty, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u672A\u8FDE\u63A5\uFF1A\u5148\u5728\u5DE6\u4FA7\u6253\u5F00\u6216\u65B0\u5EFA\u4E00\u4E2A\u4F1A\u8BDD" }) }) });
  if (snap === null) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableWrap, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableEmpty, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: loading ? "\u8BFB\u53D6\u4E2D\u2026" : "\u6682\u65F6\u8BFB\u4E0D\u5230\u6280\u80FD" }) }) });
  if (snap.unavailable) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableWrap, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: tableEmpty, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: snap.message ?? "\u6682\u65F6\u8BFB\u4E0D\u5230\u6280\u80FD" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: secondaryButton, disabled: loading, onClick: () => void load(), children: "\u5237\u65B0" })
  ] }) });
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { "aria-label": "\u6280\u80FD", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: tableHint, children: "\u540C\u7C7B\u5DE5\u4F5C\u6512\u591F\u6837\u672C\u4F1A\u81EA\u52A8\u603B\u7ED3\u6210\u6280\u80FD\uFF1B\u4F60\u5728\u8FD9\u91CC\u67E5\u9A8C\u3001\u4FEE\u6539\u6216\u5220\u9664\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { marginLeft: "auto", display: "inline-flex", gap: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: loading || busy !== null, onClick: () => void load(), children: "\u5237\u65B0" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy !== null, onClick: () => {
          setCreating((v) => !v);
          setEditing(null);
        }, children: creating ? "\u6536\u8D77\u65B0\u5EFA" : "\u65B0\u5EFA\u6280\u80FD" })
      ] })
    ] }),
    creating && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: editBarStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: { ...editInputStyle, width: 140 }, placeholder: "\u52A9\u7406ID\uFF08member-\u2026\uFF09", value: cAssistant, onChange: (e) => setCAssistant(e.target.value) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: { ...editInputStyle, width: 140 }, placeholder: "\u6280\u80FD\u540D\u79F0", value: cName, onChange: (e) => setCName(e.target.value) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { style: { ...editInputStyle, flex: 1, minWidth: 200 }, placeholder: "\u6B63\u6587\uFF1A\u505A\u4EC0\u4E48\u3001\u6309\u4EC0\u4E48\u6B65\u9AA4\u3001\u6CE8\u610F\u4EC0\u4E48", value: cBody, onChange: (e) => setCBody(e.target.value) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          style: smallButton,
          disabled: busy !== null || !cAssistant || !cName || !cBody,
          onClick: () => void run("create", `/assistant-skill-set create ${cAssistant} ${cName} ${cBody}`, () => {
            setCreating(false);
            setCAssistant("");
            setCName("");
            setCBody("");
          }),
          children: "\u4FDD\u5B58"
        }
      )
    ] }),
    editing && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: editBarStyle, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { style: { ...editInputStyle, flex: 1, minWidth: 240, minHeight: 64 }, value: editing.body, onChange: (e) => setEditing({ ...editing, body: e.target.value }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          style: smallButton,
          disabled: busy !== null || editing.body.trim() === "",
          onClick: () => void run(`edit:${editing.id}`, `/assistant-skill-set edit ${editing.id} ${editing.body}`, () => setEditing(null)),
          children: "\u4FDD\u5B58\u4FEE\u6539"
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: secondaryButton, onClick: () => setEditing(null), children: "\u53D6\u6D88" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "grid", gap: 10 }, children: [
      snap.skills.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableWrap, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableEmpty, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: '\u8FD8\u6CA1\u6709\u6280\u80FD\u3002\u540C\u7C7B\u6D3B\u505A\u591A\u4E86\u4F1A\u81EA\u52A8\u6512\u51FA\u6765\uFF0C\u4E5F\u53EF\u70B9"\u65B0\u5EFA\u6280\u80FD"\u3002' }) }) }),
      snap.skills.map((skill) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: configBlock, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 14 }, children: skill.name }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: badge, children: skill.assistantName }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: badge, children: STATUS_LABEL[skill.status] ?? skill.status }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: badge, children: [
            "v",
            skill.version
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...tableHint, color: skill.origin === "auto-selfreport" ? TOKENS.amber : TOKENS.faint }, children: ORIGIN_LABEL[skill.origin] ?? skill.origin })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...tableHint, margin: 0, whiteSpace: "pre-wrap" }, children: skill.body.length > 120 ? `${skill.body.slice(0, 120)}\u2026` : skill.body }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" }, children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy !== null, onClick: () => {
            setEditing({ id: skill.id, body: skill.body });
            setCreating(false);
          }, children: "\u7F16\u8F91" }),
          skill.status !== "active" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy !== null, onClick: () => void run(`promote:${skill.id}`, `/assistant-skill-set promote ${skill.id}`), children: "\u8BA9\u5B83\u751F\u6548" }),
          skill.status === "active" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy !== null, onClick: () => void run(`retire:${skill.id}`, `/assistant-skill-set retire ${skill.id}`), children: "\u9000\u5F79" }),
          skill.version > 1 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy !== null, onClick: () => void run(`rollback:${skill.id}`, `/assistant-skill-set rollback ${skill.id} ${skill.version - 1}`), children: "\u56DE\u6EDA\u4E0A\u4E00\u7248" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy !== null, onClick: () => void run(`delete:${skill.id}`, `/assistant-skill-set delete ${skill.id}`), children: "\u5220\u9664" })
        ] })
      ] }, skill.id))
    ] }),
    (snap.pending.length > 0 || snap.unverified.length > 0) && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 12, display: "grid", gap: 8 }, children: [
      snap.unverified.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...editBarStyle, marginTop: 0 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12 }, children: [
          item.assistantName,
          "\u300C",
          item.shape,
          "\u300D\u81EA\u62A5 ",
          item.count,
          " \u6B21\uFF0C\u5F85\u4F60\u786E\u8BA4"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy !== null, onClick: () => void run(`verify:${item.shape}`, `/assistant-skill-set verify ${item.assistantId} ${item.shape}`), children: "\u786E\u8BA4\u5C5E\u5B9E" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: busy !== null, onClick: () => void run(`retract:${item.shape}`, `/assistant-skill-set retract ${item.assistantId} ${item.shape}`), children: "\u64A4\u56DE" })
      ] }, `u:${item.assistantId}:${item.shape}`)),
      snap.pending.map((item) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { ...editBarStyle, marginTop: 0 }, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { fontSize: 12 }, children: [
        item.assistantName,
        "\u300C",
        item.shape,
        "\u300D\u5DF2\u6512 ",
        item.count,
        " \u6B21\u53EF\u4FE1\u6210\u529F\uFF0C\u591F\u683C\u5F62\u6210\u6280\u80FD"
      ] }) }, `p:${item.assistantId}:${item.shape}`))
    ] }),
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "status", style: { margin: "8px 0 0", fontSize: 12, color: notice.ok ? TOKENS.ok : TOKENS.bad }, children: notice.text })
  ] });
}
function PetConfigPanel({ ctx, connected, reloadToken, summoning, onSummon }) {
  const [snapshot, setSnapshot] = (0, import_react.useState)(null);
  const [loading, setLoading] = (0, import_react.useState)(false);
  const [busy, setBusy] = (0, import_react.useState)(null);
  const [notice, setNotice] = (0, import_react.useState)(null);
  const load = async () => {
    if (!connected) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    try {
      const result2 = await executeCommand(ctx, "/assistant-pet-config");
      setSnapshot(parsePetConfig(result2.ok ? result2.text : "\u6682\u65F6\u8BFB\u4E0D\u5230\u5BA0\u7269\u914D\u7F6E"));
    } finally {
      setLoading(false);
    }
  };
  (0, import_react.useEffect)(() => {
    void load();
  }, [ctx, connected, reloadToken]);
  const mutate = async (key, command, optimistic) => {
    if (snapshot === null) return;
    const before = snapshot;
    setSnapshot(optimistic(snapshot));
    setBusy(key);
    setNotice(null);
    try {
      const result2 = await executeCommand(ctx, command);
      if (!result2.ok) {
        setSnapshot(before);
        setNotice({ ok: false, text: result2.text });
        return;
      }
      setNotice({ ok: true, text: result2.text });
      const refreshed = await executeCommand(ctx, "/assistant-pet-config");
      setSnapshot(parsePetConfig(refreshed.ok ? refreshed.text : "\u6682\u65F6\u8BFB\u4E0D\u5230\u5BA0\u7269\u914D\u7F6E"));
    } finally {
      setBusy(null);
    }
  };
  if (!connected) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableWrap, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableEmpty, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "\u672A\u8FDE\u63A5\uFF1A\u5148\u5728\u5DE6\u4FA7\u6253\u5F00\u6216\u65B0\u5EFA\u4E00\u4E2A\u4F1A\u8BDD\uFF0C\u518D\u914D\u7F6E\u5BA0\u7269" }) }) });
  }
  if (snapshot === null) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableWrap, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableEmpty, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: loading ? "\u8BFB\u53D6\u4E2D\u2026" : "\u6682\u65F6\u8BFB\u4E0D\u5230\u5BA0\u7269\u914D\u7F6E" }) }) });
  }
  if (snapshot.unavailable) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: tableWrap, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: tableEmpty, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: snapshot.message ?? "\u6682\u65F6\u8BFB\u4E0D\u5230\u5BA0\u7269\u914D\u7F6E" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: summoning, onClick: onSummon, style: secondaryButton, children: summoning ? "\u53EC\u5524\u4E2D\u2026" : "\u53EC\u5524\u5BA0\u7269" })
    ] }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { "aria-label": "\u5BA0\u7269\u914D\u7F6E", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: tableHint, children: "\u4E0E\u684C\u9762\u5BA0\u7269\u53F3\u952E\u83DC\u5355\u662F\u540C\u4E00\u4EFD\u8BBE\u7F6E\uFF0C\u6539\u5B8C\u7ACB\u5373\u751F\u6548\u3002" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { marginLeft: "auto", display: "inline-flex", gap: 8, flexWrap: "wrap" }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: smallButton, disabled: loading || busy !== null, onClick: () => void load(), children: loading ? "\u5237\u65B0\u4E2D\u2026" : "\u5237\u65B0" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: smallButton,
            disabled: busy !== null,
            onClick: () => void mutate(
              "stage",
              petSetCommand({ kind: "stage", value: !snapshot.stageVisible }),
              (current) => ({ ...current, stageVisible: !current.stageVisible })
            ),
            children: snapshot.stageVisible ? "\u9690\u85CF\u89D2\u8272\uFF08\u622A\u56FE / \u5F55\u5C4F\uFF09" : "\u663E\u793A\u89D2\u8272"
          }
        )
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "grid", gap: 10 }, children: snapshot.characters.map((character) => {
      const skin = snapshot.skins.find((item) => item.id === character.skin) ?? snapshot.skins[0];
      const actions = skin?.actions ?? [];
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        CharacterConfigCard,
        {
          character,
          skins: snapshot.skins,
          actions,
          busy: busy !== null,
          onSkin: (value) => void mutate(
            `skin:${character.assistantId}`,
            petSetCommand({ kind: "skin", assistantId: character.assistantId, value }),
            (current) => ({
              ...current,
              characters: current.characters.map((item) => item.assistantId === character.assistantId ? { ...item, skin: value } : item)
            })
          ),
          onActions: (value) => void mutate(
            `actions:${character.assistantId}`,
            petSetCommand({ kind: "actions", assistantId: character.assistantId, value }),
            (current) => ({
              ...current,
              characters: current.characters.map((item) => item.assistantId === character.assistantId ? { ...item, randomActions: [...value] } : item)
            })
          ),
          onStep: (value) => void mutate(
            `step:${character.assistantId}`,
            petSetCommand({ kind: "step", assistantId: character.assistantId, value }),
            (current) => ({
              ...current,
              characters: current.characters.map((item) => item.assistantId === character.assistantId ? { ...item, steppedDown: value === "down" } : item)
            })
          )
        },
        character.assistantId
      );
    }) }),
    notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { role: "status", style: { margin: "8px 0 0", fontSize: 12, color: notice.ok ? TOKENS.ok : TOKENS.bad }, children: notice.text }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...tableHint, marginTop: 8 }, children: "\u968F\u673A\u52A8\u4F5C\u53EA\u5F71\u54CD\u7A7A\u95F2\u65F6\u7684\u81EA\u53D1\u8868\u6F14\uFF1B\u5F62\u8C61\u4E0E\u52A8\u4F5C\u6765\u81EA\u684C\u9762\u5BA0\u7269\u5F53\u524D\u53EF\u7528\u7684\u7D20\u6750\uFF0C\u81EA\u5B9A\u4E49\u5F62\u8C61\u4F1A\u51FA\u73B0\u5728\u5F62\u8C61\u5217\u8868\u91CC\u3002" })
  ] });
}
function CharacterConfigCard({ character, skins, actions, busy, onSkin, onActions, onStep }) {
  const selectable = skins.some((skin) => skin.id === character.skin);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: configBlock, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 14 }, children: character.displayName }),
      character.chief && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: badge, children: "\u603B\u52A9\u7406" }),
      character.steppedDown && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: badge, children: "\u5DF2\u9000\u4E0B" }),
      !character.chief && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          disabled: busy,
          onClick: () => onStep(character.steppedDown ? "up" : "down"),
          style: { ...smallButton, marginLeft: "auto" },
          children: character.steppedDown ? "\u8BF7\u4E0A\u53F0" : "\u8BA9TA\u9000\u4E0B\uFF08\u4E0D\u9000\u51FA\u5BA0\u7269\uFF09"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12.5 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: TOKENS.muted, minWidth: 64 }, children: "\u5F62\u8C61" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
        "select",
        {
          "aria-label": `${character.displayName} \u7684\u5F62\u8C61`,
          value: character.skin,
          disabled: busy,
          onChange: (event) => onSkin(event.target.value),
          style: {
            font: "inherit",
            padding: "4px 8px",
            borderRadius: 8,
            border: `1px solid ${TOKENS.line}`,
            background: "#fff",
            color: TOKENS.ink
          },
          children: [
            !selectable && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: character.skin, children: character.skin }),
            skins.map((skin) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: skin.id, children: skin.label }, skin.id))
          ]
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap", fontSize: 12.5 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: TOKENS.muted, minWidth: 64, lineHeight: "18px" }, children: "\u968F\u673A\u52A8\u4F5C" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { display: "inline-flex", gap: 12, flexWrap: "wrap", lineHeight: "18px" }, children: [
        actions.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: tableHint, children: "\u8FD9\u4E2A\u5F62\u8C61\u6CA1\u6709\u53EF\u52FE\u9009\u7684\u52A8\u4F5C" }),
        actions.map((action) => {
          const checked = character.randomActions.includes(action.id);
          return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4 }, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "input",
              {
                type: "checkbox",
                checked,
                disabled: busy,
                onChange: (event) => onActions(event.target.checked ? [...character.randomActions, action.id] : character.randomActions.filter((id) => id !== action.id))
              }
            ),
            action.label
          ] }, action.id);
        })
      ] })
    ] })
  ] });
}
function configStatusText(snapshot, reading) {
  if (reading || snapshot === null) return { text: "\u8BFB\u53D6\u4E2D\u2026", tone: TOKENS.grey };
  if (snapshot.unavailable) return { text: "\u6682\u65F6\u8BFB\u4E0D\u5230\u5F53\u524D\u914D\u7F6E\uFF0C\u53EF\u4EE5\u76F4\u63A5\u586B\u5199\u4FDD\u5B58", tone: TOKENS.amber };
  if (snapshot.configured) return { text: "\u5DF2\u914D\u7F6E", tone: TOKENS.green };
  return { text: "\u672A\u914D\u7F6E", tone: TOKENS.grey };
}
function ConfigFormPanel({ ctx, title: title2, description, fields, command, validate, passwordKeys, readSnapshot }) {
  const [values, setValues] = (0, import_react.useState)({});
  const [errors, setErrors] = (0, import_react.useState)({});
  const [saving, setSaving] = (0, import_react.useState)(false);
  const [notice, setNotice] = (0, import_react.useState)(null);
  const [snapshot, setSnapshot] = (0, import_react.useState)(null);
  const [reading, setReading] = (0, import_react.useState)(true);
  const readOnce = (0, import_react.useRef)(false);
  const load = async () => {
    setReading(true);
    const result2 = await executeCommand(ctx, `/${command}`);
    const next = result2.ok ? readSnapshot(result2.text) : { unavailable: true, configured: false, values: {}, hasSecret: false };
    setSnapshot(next);
    setReading(false);
    if (next.unavailable) return;
    if (readOnce.current) return;
    readOnce.current = true;
    setValues(initialFormValues(fields, next));
  };
  (0, import_react.useEffect)(() => {
    void load();
  }, []);
  const stored = { hasSecret: snapshot?.hasSecret === true };
  const submit = async () => {
    const found = validate(values, stored);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setNotice({ ok: false, text: "\u6709\u51E0\u9879\u8FD8\u4E0D\u5408\u6CD5\uFF0C\u5148\u6309\u63D0\u793A\u6539\u597D\u518D\u4FDD\u5B58" });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result2 = await executeCommand(ctx, buildCommandLine(command, values, fields.map((field) => field.key)));
      if (!result2.ok) {
        setNotice({
          ok: false,
          text: looksLikeUnknownCommand(result2.text) ? `${title2}\u914D\u7F6E\u63A5\u53E3\u8FD8\u6CA1\u5C31\u7EEA\uFF1A${result2.text}` : result2.text
        });
        return;
      }
      const cleared = { ...values };
      for (const key of passwordKeys) delete cleared[key];
      setValues(cleared);
      setSnapshot((previous) => previous === null || previous.unavailable ? { unavailable: false, configured: true, values: previous?.values ?? {}, hasSecret: true } : { ...previous, configured: true, hasSecret: true });
      setNotice({ ok: true, text: "\u5DF2\u4FDD\u5B58" });
    } finally {
      setSaving(false);
    }
  };
  const status = configStatusText(snapshot, reading);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { style: configBlock, "aria-label": title2, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("i", { style: dot(status.tone) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { style: { fontSize: 14 }, children: title2 }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...tableHint, marginLeft: "auto" }, children: status.text })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...tableHint, margin: 0 }, children: description }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }, children: fields.map((field) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: { display: "flex", flexDirection: "column", gap: 6, fontSize: 12.5 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: TOKENS.muted }, children: field.label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: field.type,
          value: values[field.key] ?? "",
          placeholder: fieldPlaceholder(field, snapshot ?? EMPTY_SNAPSHOT),
          style: { width: field.width ?? "100%", boxSizing: "border-box" },
          onChange: (event) => {
            setValues((previous) => ({ ...previous, [field.key]: event.target.value }));
            setErrors((previous) => {
              if (previous[field.key] === void 0) return previous;
              const next = { ...previous };
              delete next[field.key];
              return next;
            });
          }
        }
      ),
      errors[field.key] !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { color: TOKENS.bad, fontSize: 12 }, role: "alert", children: errors[field.key] })
    ] }, field.key)) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 12, marginTop: 4 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", disabled: saving, onClick: () => void submit(), style: primaryButton, children: saving ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58" }),
      notice !== null && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { role: "status", style: { fontSize: 12, color: notice.ok ? TOKENS.ok : TOKENS.bad }, children: notice.text })
    ] })
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
