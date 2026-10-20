/**
 * macOS 实现：`desktop-actions.ts` 契约 → osascript（JXA）。**未在 Mac 真机验证**。
 *
 * 调用方式：`/usr/bin/osascript -l JavaScript -e <常量脚本> dsh-args <JSON>`。
 * 脚本正文是本文件里的常量；目标身份、文档名、页码等可变内容只经最后一个 argv（JSON）传入，
 * 不拼进脚本文本，也不经 shell。
 *
 * 三种隐私权限分开判断，缺哪项只禁用依赖它的能力（见 `macCapabilities`）：
 * - 辅助功能（Accessibility）：读窗口标题与界面元素、发导航键。
 * - 自动化（Apple Events → System Events）：本实现经 System Events 做界面脚本，同样必需。
 * - 屏幕录制（Screen Recording）：缺辅助功能时，用 CGWindowList 读窗口标题做只读识别。
 * 打开文件（/usr/bin/open）与激活应用（NSRunningApplication）不需要这三项。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import {
  fail,
  identityMismatches,
  isActionErrorCode,
  ok,
  validPage,
  type ActionError,
  type ActionEvidence,
  type ActionName,
  type ActionResult,
  type AppLaunchTarget,
  type DesktopActions,
  type FocusOptions,
  type ForegroundSnapshot,
  type MacPermission,
  type OpenOutcome,
  type PagePosition,
  type ScrollOutcome,
  type ScrollRequest,
  type TextReadGrant,
  type VisibleText,
  type WindowIdentity,
  type WindowQuery,
} from './desktop-actions.ts'
import { openWithSpecifiedApp, type OpenWithAppDeps } from './doc-fs.ts'
import { osascriptJxaSpec, type CommandSpec } from './platform.ts'

// ===== 权限 =====

export type PermissionState = 'granted' | 'denied' | 'unknown'
export type MacPermissionStatus = Record<MacPermission, PermissionState>

export type MacCapability =
  | 'openWith' | 'activateApp' | 'findWindow' | 'findWindowTitlesOnly' | 'raiseWindow'
  | 'readPage' | 'gotoPage' | 'scroll' | 'readVisibleText'

/** 每项能力依赖的权限。空数组表示不需要隐私权限。 */
export const MAC_CAPABILITY_NEEDS: Readonly<Record<MacCapability, readonly MacPermission[]>> = {
  openWith: [],
  activateApp: [],
  findWindow: ['accessibility', 'automation'],
  findWindowTitlesOnly: ['screen-recording'],
  raiseWindow: ['accessibility', 'automation'],
  readPage: ['accessibility', 'automation'],
  gotoPage: ['accessibility', 'automation'],
  scroll: ['accessibility', 'automation'],
  readVisibleText: ['accessibility', 'automation'],
}

/** 给用户看的引导文字。 */
export const MAC_PERMISSION_GUIDANCE: Readonly<Record<MacPermission, string>> = {
  accessibility: '请打开「系统设置 → 隐私与安全性 → 辅助功能」，允许本应用（dsh-pet）控制电脑，然后重新打开文档。缺这项时无法读取 WPS 页码、无法翻页。',
  automation: '请打开「系统设置 → 隐私与安全性 → 自动化」，在本应用下勾选「System Events」。缺这项时无法识别 WPS 窗口与翻页。',
  'screen-recording': '请打开「系统设置 → 隐私与安全性 → 屏幕与系统录音」，允许本应用。缺这项只影响在没有辅助功能权限时读取窗口标题，不影响翻页。',
}

export function macCapabilities(status: MacPermissionStatus): Record<MacCapability, { available: boolean; missing: MacPermission[] }> {
  const out = {} as Record<MacCapability, { available: boolean; missing: MacPermission[] }>
  for (const cap of Object.keys(MAC_CAPABILITY_NEEDS) as MacCapability[]) {
    // unknown 不当成 denied：先试，失败时再按错误号归类。
    const missing = MAC_CAPABILITY_NEEDS[cap].filter(p => status[p] === 'denied')
    out[cap] = { available: missing.length === 0, missing }
  }
  return out
}

/** osascript 失败输出 → 权限归类。认不出返回 null。 */
export function classifyMacFailure(stderr: string): MacPermission | null {
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(stderr)) return 'automation'
  if (/-1719\b|-25211\b|assistive access|辅助功能/i.test(stderr)) return 'accessibility'
  if (/screen recording|屏幕录制|CGPreflightScreenCaptureAccess/i.test(stderr)) return 'screen-recording'
  return null
}

export function permissionError(permission: MacPermission): ActionError {
  return {
    code: 'permission-denied',
    message: { accessibility: '缺少辅助功能权限', automation: '缺少自动化（System Events）权限', 'screen-recording': '缺少屏幕录制权限' }[permission],
    permission,
    guidance: MAC_PERMISSION_GUIDANCE[permission],
  }
}

// ===== JXA 脚本（常量，不做任何插值）=====

/**
 * 单一脚本按 op 分派。返回值由 osascript 打印到 stdout：一行 JSON。
 * 注意：String.raw 保留正则里的反斜杠；全文不含插值占位符。
 */
export const MAC_JXA_SCRIPT = String.raw`
ObjC.import('AppKit');
var KEYS = { Left: 123, Right: 124, Down: 125, Up: 126, Home: 115, End: 119, PageUp: 116, PageDown: 121 };
var PAGE_RE = /^\s*(\d{1,6})\s*\/\s*(\d{1,6})\s*$/;
var deadline = 0;

function run(argv) {
  var out;
  try {
    var req = JSON.parse(argv[1]);
    deadline = Date.now() + Math.max(1000, Math.min(60000, req.timeoutMs || 10000));
    out = dispatch(req);
  } catch (e) { out = errOut(e); }
  return JSON.stringify(out);
}

function errOut(e) {
  var n = e && e.errorNumber;
  var msg = String((e && e.message) || e);
  if (n === -1743 || /not authori[sz]ed to send apple events/i.test(msg)) return { ok: false, code: 'permission-denied', permission: 'automation', message: msg };
  if (n === -1719 || n === -25211 || /assistive access/i.test(msg)) return { ok: false, code: 'permission-denied', permission: 'accessibility', message: msg };
  if (n === -1728) return { ok: false, code: 'window-not-found', message: msg };
  if (msg === 'DSH_TIMEOUT') return { ok: false, code: 'timeout', message: 'timeout' };
  return { ok: false, code: 'failed', message: msg };
}
function fail(code, message, detail) { var r = { ok: false, code: code, message: message }; if (detail) r.detail = detail; return r; }
function checkDeadline() { if (Date.now() > deadline) throw new Error('DSH_TIMEOUT'); }
function str(v) { return (v === undefined || v === null) ? '' : String(v); }
function has(hay, needle) { return !!needle && str(hay).indexOf(needle) >= 0; }

function appInfo(pid) {
  var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app || app.isNil()) return null;
  var started = '';
  try { if (!app.launchDate.isNil()) started = String(app.launchDate.timeIntervalSince1970); } catch (e) {}
  return { pid: pid, bundleId: str(ObjC.unwrap(app.bundleIdentifier)), path: str(ObjC.unwrap(app.bundleURL.path)), started: started, app: app };
}
function pidsForBundle(id) {
  var arr = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(id);
  var out = [];
  for (var i = 0; i < arr.count; i++) out.push(arr.objectAtIndex(i).processIdentifier);
  return out;
}
function frontPid() { var a = $.NSWorkspace.sharedWorkspace.frontmostApplication; return (a && !a.isNil()) ? a.processIdentifier : 0; }
function modifierHeld() { var f = $.NSEvent.modifierFlags; return (f & ((1 << 17) | (1 << 18) | (1 << 19) | (1 << 20))) !== 0; }

function permissions() {
  var acc = 'unknown', scr = 'unknown', auto = 'unknown';
  try { ObjC.import('ApplicationServices'); acc = $.AXIsProcessTrusted() ? 'granted' : 'denied'; } catch (e) {}
  try { ObjC.import('CoreGraphics'); scr = $.CGPreflightScreenCaptureAccess() ? 'granted' : 'denied'; } catch (e) {}
  try { Application('System Events').processes.length; auto = 'granted'; } catch (e) { if (e.errorNumber === -1743) auto = 'denied'; }
  return { ok: true, accessibility: acc, automation: auto, screenRecording: scr };
}

function locate(req) {
  var ws = $.NSWorkspace.sharedWorkspace, out = [];
  (req.bundleIds || []).forEach(function (id) {
    var url = ws.URLForApplicationWithBundleIdentifier(id);
    if (url && !url.isNil()) out.push(describeApp(str(ObjC.unwrap(url.path)), 'bundle-id', null));
  });
  (req.appNames || []).forEach(function (name) {
    var p = ws.fullPathForApplication(name);
    if (p && !p.isNil()) out.push(describeApp(str(ObjC.unwrap(p)), 'name', name));
  });
  return { ok: true, candidates: out };
}
function describeApp(path, via, name) {
  var b = $.NSBundle.bundleWithPath(path), id = '', ver = '';
  if (b && !b.isNil()) {
    id = str(ObjC.unwrap(b.bundleIdentifier));
    var v = b.objectForInfoDictionaryKey('CFBundleShortVersionString');
    if (v && !v.isNil()) ver = str(ObjC.unwrap(v));
  }
  return { path: path, via: via, name: name, bundleId: id, version: ver };
}

function axDocument(w) { try { return str(w.attributes.byName('AXDocument').value()); } catch (e) { return ''; } }
function docPathOf(url) { if (url.indexOf('file://') !== 0) return ''; try { return decodeURIComponent(url.slice(7)); } catch (e) { return ''; } }

function identityOf(info, w, documentName) {
  var url = axDocument(w), docPath = docPathOf(url);
  var id = { platform: 'darwin', pid: info.pid, windowId: docPath ? 'ax-doc:' + docPath : 'ax-title:' + str(documentName), title: str(w.name()), processPath: info.path, processStartedAt: info.started };
  if (documentName) id.documentName = documentName;
  if (docPath) id.documentPath = docPath;
  return id;
}

// 在进程的窗口里找目标文档窗口：AXDocument 路径优先，其次标题含文档名。
function findDocWindow(info, documentName, documentPath) {
  var se = Application('System Events');
  var procs = se.processes.whose({ unixId: info.pid });
  if (procs.length === 0) return { error: fail('window-not-found', 'process gone', 'app-closed') };
  var p = procs[0], wins = p.windows(), hits = [];
  for (var i = 0; i < wins.length; i++) {
    checkDeadline();
    var w = wins[i], dp = docPathOf(axDocument(w));
    if (documentPath && dp) { if (dp === documentPath) hits.push({ w: w, index: i }); continue; }
    if (has(w.name(), documentName)) hits.push({ w: w, index: i });
  }
  if (hits.length === 0) return { error: fail('window-not-found', 'document window not found', 'no-match') };
  if (hits.length > 1) return { error: fail('ambiguous-window', 'more than one window matches', 'multiple-windows') };
  return { proc: p, w: hits[0].w, index: hits[0].index };
}

function dialogState(proc, w) {
  try { if (w.sheets().length > 0) return 'sheet'; } catch (e) {}
  try {
    var front = proc.windows[0];
    var sr = str(front.subrole());
    if ((sr === 'AXDialog' || sr === 'AXSystemDialog') && str(front.name()) !== str(w.name())) return 'dialog';
  } catch (e) {}
  return '';
}

function checkTarget(req) {
  var exp = req.identity;
  if (!exp) return { error: fail('invalid-argument', 'missing identity') };
  var info = appInfo(exp.pid);
  if (!info) return { error: fail('window-not-found', 'app not running', 'app-closed') };
  if (info.path !== exp.processPath) return { error: fail('identity-changed', 'process path changed', 'processPath') };
  if (exp.processStartedAt && info.started && info.started !== exp.processStartedAt) return { error: fail('identity-changed', 'pid reused', 'processStartedAt') };
  var found = findDocWindow(info, exp.documentName, exp.documentPath);
  if (found.error) return found;
  var id = identityOf(info, found.w, exp.documentName);
  if (exp.documentName && !has(id.title, exp.documentName) && !exp.documentPath) return { error: fail('identity-changed', 'title changed', 'document-switched'), identity: id };
  var d = dialogState(found.proc, found.w);
  if (d) return { error: fail('dialog-blocking', 'dialog open', d), identity: id };
  return { info: info, proc: found.proc, w: found.w, identity: id };
}

function foreground(t, owners) {
  var fp = frontPid();
  var snap = { isTarget: false, pid: fp, isOwner: (owners || []).indexOf(fp) >= 0, isDialogOfTarget: false };
  if (fp === t.info.pid) {
    try { var front = t.proc.windows[0]; snap.isTarget = str(front.name()) === str(t.w.name()); snap.isDialogOfTarget = !snap.isTarget && /Dialog/.test(str(front.subrole())); } catch (e) {}
  }
  return snap;
}

// 有界的广度优先遍历。
function walk(root, maxDepth, maxNodes, visit) {
  var queue = [[root, 0]], n = 0;
  while (queue.length && n < maxNodes) {
    if ((n % 20) === 0) checkDeadline();
    var item = queue.shift(), el = item[0], d = item[1]; n++;
    if (visit(el) === true) return;
    if (d >= maxDepth) continue;
    var kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    for (var i = 0; i < kids.length; i++) queue.push([kids[i], d + 1]);
  }
}

function readPage(t) {
  var texts = [];
  walk(t.w, 10, 800, function (el) {
    var role = '';
    try { role = str(el.role()); } catch (e) { return false; }
    if (role !== 'AXStaticText' && role !== 'AXTextField') return false;
    var v = '';
    try { v = str(el.value()); } catch (e) {}
    if (!v) { try { v = str(el.name()); } catch (e) {} }
    texts.push({ role: role, v: v });
    return false;
  });
  for (var i = 0; i < texts.length; i++) {
    var m = PAGE_RE.exec(texts[i].v);
    if (m) return { page: +m[1], total: +m[2], raw: texts[i].v };
    // "3" 输入框 + "/ 12" 文本相邻的形态。
    if (/^\s*\d{1,6}\s*$/.test(texts[i].v) && i + 1 < texts.length) {
      var m2 = /^\s*\/\s*(\d{1,6})\s*$/.exec(texts[i + 1].v);
      if (m2) return { page: +texts[i].v, total: +m2[1], raw: texts[i].v + texts[i + 1].v };
    }
  }
  return null;
}

function scrollValue(t) {
  var val = null;
  walk(t.w, 8, 400, function (el) {
    try {
      if (str(el.role()) === 'AXScrollBar' && str(el.orientation()) === 'AXVerticalOrientation') { val = Number(el.value()); return true; }
    } catch (e) {}
    return false;
  });
  return val;
}

function readyForKeys(t, req) {
  var fg = foreground(t, req.ownerPids);
  if (fg.isTarget) return { snap: fg };
  if (fg.isDialogOfTarget) return { snap: fg, error: fail('dialog-blocking', 'dialog in front', 'foreground-dialog') };
  if (!fg.isOwner) return { snap: fg, error: fail('focus-stolen', 'another app is frontmost', 'foreground-other') };
  t.info.app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
  try { t.w.actions.byName('AXRaise').perform(); } catch (e) {}
  delay(0.3);
  var again = foreground(t, req.ownerPids);
  if (!again.isTarget) return { snap: fg, error: fail('focus-stolen', 'could not bring window to front', 'foreground-refused') };
  return { snap: fg };
}

function tap(t, name) {
  if (!(name in KEYS)) throw new Error('only navigation keys are allowed');
  if (frontPid() !== t.info.pid) return fail('focus-stolen', 'frontmost app changed before key', 'foreground-changed');
  if (str(t.proc.windows[0].name()) !== str(t.w.name())) return fail('focus-stolen', 'front window changed before key', 'window-changed');
  if (modifierHeld()) return fail('focus-stolen', 'modifier key held by user', 'modifier-held');
  Application('System Events').keyCode(KEYS[name]);
  if (frontPid() !== t.info.pid) return fail('focus-stolen', 'frontmost app changed after key', 'foreground-changed-after');
  return null;
}

function waitChange(t, prev) {
  var start = Date.now(), last = prev;
  while (Date.now() - start < 1500) {
    delay(0.1);
    var cur = readPage(t);
    if (cur && prev && cur.page !== prev.page) { delay(0.12); return readPage(t) || cur; }
    if (cur) last = cur;
  }
  return last;
}

function after(t, r, req) {
  try { r.foregroundAfter = foreground(t, req.ownerPids); } catch (e) {}
  try { r.after = identityOf(t.info, t.w, req.identity.documentName); } catch (e) {}
  return r;
}

function dispatch(req) {
  if (req.op === 'permissions') return permissions();
  if (req.op === 'locate') return locate(req);
  if (req.op === 'find') return find(req);
  var t = checkTarget(req);
  if (t.error) { if (t.identity) t.error.after = t.identity; return t.error; }
  if (req.op === 'verify') { var p = readPage(t); var r = { ok: true, before: t.identity, after: t.identity, foregroundBefore: foreground(t, req.ownerPids) }; if (p) { r.page = p.page; r.total = p.total; r.raw = p.raw; } return r; }
  if (req.op === 'focus') return focus(t, req);
  if (req.op === 'read-page') {
    var pg = readPage(t);
    if (!pg) return fail('unsupported', 'page label not exposed via accessibility', 'page-label-missing');
    return after(t, { ok: true, before: t.identity, page: pg.page, total: pg.total, raw: pg.raw, method: 'ax-read', foregroundBefore: foreground(t, req.ownerPids) }, req);
  }
  if (req.op === 'goto-page') return gotoPage(t, req);
  if (req.op === 'scroll') return scroll(t, req);
  if (req.op === 'read-text') return readText(t, req);
  return fail('invalid-argument', 'unknown op');
}

function find(req) {
  var pids = req.query.bundleId ? pidsForBundle(req.query.bundleId) : [];
  if (req.query.pid) pids = pids.filter(function (p) { return p === req.query.pid; });
  if (pids.length === 0) return fail('window-not-found', 'app not running', 'app-not-running');
  var hits = [];
  for (var i = 0; i < pids.length; i++) {
    var info = appInfo(pids[i]);
    if (!info || (req.query.processDir && info.path !== req.query.processDir)) continue;
    var found;
    try { found = findDocWindow(info, req.documentName || req.query.titleIncludes, null); }
    catch (e) {
      var err = errOut(e);
      if (err.code === 'permission-denied' && err.permission === 'accessibility') return titlesOnly(req, pids, err);
      return err;
    }
    if (found.error) { if (found.error.code === 'ambiguous-window') return found.error; continue; }
    hits.push(identityOf(info, found.w, req.documentName));
  }
  if (hits.length === 0) return fail('window-not-found', 'no matching window', 'no-match');
  if (hits.length > 1) return fail('ambiguous-window', 'more than one window matches', 'multiple-windows');
  return { ok: true, identity: hits[0], method: 'ax' };
}

// 没有辅助功能权限时的只读识别：需要屏幕录制权限才能读到其他应用的窗口标题。
function titlesOnly(req, pids, axErr) {
  var scr = false;
  try { ObjC.import('CoreGraphics'); scr = $.CGPreflightScreenCaptureAccess(); } catch (e) {}
  if (!scr) return axErr;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))) || [];
  var hits = list.filter(function (w) { return pids.indexOf(w.kCGWindowOwnerPID) >= 0 && has(w.kCGWindowName, req.query.titleIncludes); });
  if (hits.length !== 1) return axErr;
  var info = appInfo(hits[0].kCGWindowOwnerPID);
  var r = fail('permission-denied', 'window identified read-only; accessibility needed to control it', 'titles-only');
  r.permission = 'accessibility';
  r.identity = { platform: 'darwin', pid: info.pid, windowId: 'cg:' + hits[0].kCGWindowNumber, title: str(hits[0].kCGWindowName), processPath: info.path, processStartedAt: info.started, documentName: req.documentName };
  return r;
}

function focus(t, req) {
  var r = { before: t.identity, method: 'activate+AXRaise' };
  var fg = foreground(t, req.ownerPids);
  r.foregroundBefore = fg;
  if (!fg.isTarget) {
    if (fg.isDialogOfTarget) return after(t, fail('dialog-blocking', 'dialog in front', 'foreground-dialog'), req);
    if (!fg.isOwner && fg.pid !== t.info.pid) { var e = fail('focus-stolen', 'another app is frontmost; not stealing focus', 'foreground-other'); e.before = t.identity; e.foregroundBefore = fg; return after(t, e, req); }
    t.info.app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
    try { t.w.actions.byName('AXRaise').perform(); } catch (e2) {}
    delay(0.4);
  } else { r.method = 'already-foreground'; }
  var t2 = checkTarget(req);
  if (t2.error) return t2.error;
  r.ok = true;
  return after(t2, r, req);
}

function gotoPage(t, req) {
  var target = req.page | 0;
  var ready = readyForKeys(t, req);
  if (ready.error) { ready.error.before = t.identity; ready.error.foregroundBefore = ready.snap; return ready.error; }
  var cur = readPage(t);
  if (!cur) return fail('unsupported', 'page label not exposed via accessibility', 'page-label-missing');
  if (target < 1 || target > cur.total) return fail('invalid-argument', 'page out of range');
  var r = { before: t.identity, foregroundBefore: ready.snap, pageBefore: { page: cur.page, total: cur.total } };
  var steps = [], keys = 0, round = 0, stalled = 0;
  while (cur.page !== target && round < 12) {
    round++;
    var delta = target - cur.page, plan = [];
    if (target === 1) plan = ['Home'];
    else if (target === cur.total) plan = ['End'];
    else { var n = Math.min(Math.abs(delta), 10); for (var i = 0; i < n; i++) plan.push(delta > 0 ? 'Right' : 'Left'); }
    for (var k = 0; k < plan.length; k++) {
      var e = tap(t, plan[k]);
      if (e) { e.steps = steps; e.before = t.identity; return after(t, e, req); }
      keys++;
      delay(0.04);
    }
    var prev = cur;
    cur = waitChange(t, prev);
    if (!cur) return after(t, fail('failed', 'page label lost after keys', 'page-label-lost'), req);
    steps.push(plan[0] + 'x' + plan.length + '->' + cur.page + '/' + cur.total);
    stalled = (cur.page === prev.page) ? stalled + 1 : 0;
    if (stalled >= 2) break;
  }
  r.steps = steps; r.page = cur.page; r.total = cur.total; r.raw = cur.raw; r.method = 'key-nav x' + keys;
  if (cur.page !== target) { r.ok = false; r.code = 'failed'; r.message = 'read back page ' + cur.page + ', target ' + target; r.detail = 'readback-mismatch'; }
  else r.ok = true;
  return after(t, r, req);
}

function scroll(t, req) {
  var names = { 'line-down': 'Down', 'line-up': 'Up', 'page-down': 'PageDown', 'page-up': 'PageUp' };
  var name = names[req.unit + '-' + req.direction];
  if (!name) return fail('invalid-argument', 'bad scroll request');
  var count = Math.max(1, Math.min(10, req.count | 0));
  var ready = readyForKeys(t, req);
  if (ready.error) { ready.error.before = t.identity; return ready.error; }
  var cur = readPage(t);
  if (!cur) return fail('unsupported', 'page label not exposed via accessibility', 'page-label-missing');
  var s0 = scrollValue(t);
  for (var i = 0; i < count; i++) { var e = tap(t, name); if (e) { e.before = t.identity; return after(t, e, req); } delay(0.04); }
  delay(0.35);
  var a = readPage(t), s1 = scrollValue(t);
  if (!a) return fail('failed', 'page label lost after scroll', 'page-label-lost');
  var r = { before: t.identity, foregroundBefore: ready.snap, pageBefore: { page: cur.page, total: cur.total }, page: a.page, total: a.total, raw: a.raw, method: 'key-' + name + ' x' + count };
  if (s0 !== null) r.scrollValueBefore = s0;
  if (s1 !== null) { r.scrollValueAfter = s1; r.scrollValue = s1; }
  r.moved = a.page !== cur.page || (s0 !== null && s1 !== null && s0 !== s1);
  r.atBoundary = (req.direction === 'down' && a.page === a.total) || (req.direction === 'up' && a.page === 1);
  if (!r.moved && !r.atBoundary) { r.ok = false; r.code = 'failed'; r.message = 'no movement'; r.detail = 'no-movement'; } else r.ok = true;
  return after(t, r, req);
}

function readText(t, req) {
  if (req.authorized !== true) return fail('not-authorized', 'authorization required');
  var max = Math.max(100, Math.min(50000, req.maxChars | 0)), parts = [], len = 0;
  walk(t.w, 12, 1500, function (el) {
    try {
      if (str(el.role()) !== 'AXStaticText') return false;
      var v = str(el.value());
      if (v) { parts.push(v); len += v.length + 1; }
    } catch (e) {}
    return len >= max;
  });
  var text = parts.join('\n').slice(0, max).trim();
  if (!text) return fail('unsupported', 'no text exposed via accessibility', 'no-text');
  return after(t, { ok: true, before: t.identity, text: text, truncated: len >= max, method: 'ax-statictext' }, req);
}
`

// ===== 运行器 =====

export interface MacRunOutput {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type MacRunner = (spec: CommandSpec, timeoutMs: number) => Promise<MacRunOutput>

const defaultRunner: MacRunner = (spec, timeoutMs) => new Promise(resolve => {
  const child = nodeSpawn(spec.command, [...spec.args], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
  child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d })
  child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d })
  child.on('error', error => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(error), timedOut }) })
  child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
})

/** 解析 osascript 的输出：取最后一个非空行的 JSON。 */
export function parseMacOutput(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  try {
    const v: unknown = JSON.parse(lines[lines.length - 1])
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

function asString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function asNumber(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }

export function parseMacIdentity(value: unknown): WindowIdentity | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const pid = asNumber(v.pid)
  const windowId = asString(v.windowId)
  const title = asString(v.title)
  const processPath = asString(v.processPath)
  if (pid === undefined || !windowId || title === undefined || !processPath) return undefined
  const id: WindowIdentity = { platform: 'darwin', pid, windowId, title, processPath }
  const started = asString(v.processStartedAt)
  if (started) id.processStartedAt = started
  const doc = asString(v.documentName)
  if (doc) id.documentName = doc
  const docPath = asString(v.documentPath)
  if (docPath) id.documentPath = docPath
  return id
}

function parseForeground(value: unknown): ForegroundSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (typeof v.isTarget !== 'boolean') return undefined
  return { isTarget: v.isTarget, pid: asNumber(v.pid), isOwner: v.isOwner === true, isDialogOfTarget: v.isDialogOfTarget === true }
}

function positionOf(v: Record<string, unknown>): PagePosition | undefined {
  const page = asNumber(v.page)
  const total = asNumber(v.total)
  return page !== undefined && total !== undefined && validPage(page, total) ? { page, total } : undefined
}

function evidenceOf(action: ActionName, out: Record<string, unknown>): ActionEvidence {
  const evidence: ActionEvidence = { action, platform: 'darwin' }
  const method = asString(out.method)
  if (method) evidence.method = method
  const before = parseMacIdentity(out.before) ?? parseMacIdentity(out.identity)
  if (before) evidence.before = before
  const afterId = parseMacIdentity(out.after)
  if (afterId) evidence.after = afterId
  const fb = parseForeground(out.foregroundBefore)
  if (fb) evidence.foregroundBefore = fb
  const fa = parseForeground(out.foregroundAfter)
  if (fa) evidence.foregroundAfter = fa
  const pb = out.pageBefore && typeof out.pageBefore === 'object' ? positionOf(out.pageBefore as Record<string, unknown>) : undefined
  if (pb) evidence.pageBefore = pb
  const pos = positionOf(out)
  if (pos) {
    evidence.readBack = { ...pos }
    const sv = asNumber(out.scrollValue)
    if (sv !== undefined) evidence.readBack.scrollValue = sv
    const raw = asString(out.raw)
    if (raw !== undefined) evidence.readBack.raw = raw
  }
  if (Array.isArray(out.steps)) evidence.steps = out.steps.filter((s): s is string => typeof s === 'string')
  return evidence
}

function errorOf(out: Record<string, unknown>): ActionError {
  const code = isActionErrorCode(out.code) ? out.code : 'failed'
  const perm = out.permission
  if (code === 'permission-denied' && (perm === 'accessibility' || perm === 'automation' || perm === 'screen-recording')) {
    const e = permissionError(perm)
    const detail = asString(out.detail)
    if (detail) e.detail = detail
    return e
  }
  const error: ActionError = { code, message: asString(out.message) ?? 'osascript 未说明原因' }
  const detail = asString(out.detail)
  if (detail) error.detail = detail
  if (code === 'unsupported') error.fallback = 'reading-view'
  return error
}

export interface MacAppCandidate {
  path: string
  via: 'bundle-id' | 'name'
  name?: string
  bundleId?: string
  version?: string
}

export interface MacDesktopActions extends DesktopActions {
  readonly platform: 'darwin'
  checkPermissions(): Promise<ActionResult<MacPermissionStatus>>
  locateApps(bundleIds: readonly string[], appNames: readonly string[]): Promise<ActionResult<MacAppCandidate[]>>
}

export interface MacActionsOptions {
  run?: MacRunner
  openDeps?: OpenWithAppDeps
  timeoutMs?: number
}

export function createMacActions(options: MacActionsOptions): MacDesktopActions {
  const run = options.run ?? defaultRunner
  const timeoutMs = options.timeoutMs ?? 10_000

  async function call(action: ActionName, payload: Record<string, unknown>, budget = timeoutMs): Promise<{ out: Record<string, unknown> } | { result: ActionResult<never> }> {
    const evidence: ActionEvidence = { action, platform: 'darwin' }
    const spec = osascriptJxaSpec('darwin', MAC_JXA_SCRIPT, JSON.stringify({ ...payload, timeoutMs: budget }))
    if (spec === null) return { result: fail('unsupported', 'osascript 只在 macOS 上可用', evidence) }
    const res = await run(spec, budget + 5_000)
    if (res.timedOut) return { result: fail('timeout', 'osascript 超时，已结束', evidence) }
    const out = parseMacOutput(res.stdout)
    if (out === null) {
      const perm = classifyMacFailure(res.stderr)
      if (perm !== null) return { result: { ok: false, error: permissionError(perm), evidence } }
      return { result: fail('failed', `osascript 失败：${res.stderr.trim().slice(0, 300) || `退出码 ${res.code}`}`, evidence) }
    }
    return { out }
  }

  function finish<T>(action: ActionName, out: Record<string, unknown>, expected: WindowIdentity | undefined, requireFg: boolean,
    build: (out: Record<string, unknown>, evidence: ActionEvidence) => T | undefined): ActionResult<T> {
    const evidence = evidenceOf(action, out)
    if (out.ok !== true) return { ok: false, error: errorOf(out), evidence }
    if (expected !== undefined) {
      for (const seen of [evidence.before, evidence.after]) {
        if (seen === undefined) continue
        const diff = identityMismatches(expected, seen)
        if (diff.length > 0) return fail('identity-changed', '窗口身份与目标不一致', evidence, { detail: diff.join(',') })
      }
    }
    if (requireFg && evidence.foregroundAfter?.isTarget !== true) {
      return fail('focus-stolen', '动作后前台已不是目标窗口', evidence, { detail: 'foreground-lost-after' })
    }
    const value = build(out, evidence)
    if (value === undefined) return fail('failed', 'osascript 的回应缺少必要字段', evidence)
    return ok(value, evidence)
  }

  const owners = (o?: FocusOptions) => [...(o?.ownerPids ?? [])]

  return {
    platform: 'darwin',

    async checkPermissions() {
      const r = await call('verify', { op: 'permissions' })
      if ('result' in r) return r.result
      const norm = (v: unknown): PermissionState => (v === 'granted' || v === 'denied' ? v : 'unknown')
      return ok({
        accessibility: norm(r.out.accessibility),
        automation: norm(r.out.automation),
        'screen-recording': norm(r.out.screenRecording),
      }, { action: 'verify', platform: 'darwin', method: 'permission-probe' })
    },

    async locateApps(bundleIds, appNames) {
      const r = await call('locate', { op: 'locate', bundleIds: [...bundleIds], appNames: [...appNames] })
      if ('result' in r) return r.result
      return finish('locate', r.out, undefined, false, out => {
        if (!Array.isArray(out.candidates)) return undefined
        return out.candidates.flatMap((c): MacAppCandidate[] => {
          if (c === null || typeof c !== 'object') return []
          const v = c as Record<string, unknown>
          const p = asString(v.path)
          if (!p || !p.startsWith('/') || (v.via !== 'bundle-id' && v.via !== 'name')) return []
          return [{ path: p, via: v.via, name: asString(v.name) || undefined, bundleId: asString(v.bundleId) || undefined, version: asString(v.version) || undefined }]
        })
      })
    },

    async openWith(app: AppLaunchTarget, file: string): Promise<ActionResult<OpenOutcome>> {
      return openWithSpecifiedApp(file, app, { ...options.openDeps, platform: 'darwin' })
    },

    async findWindow(query: WindowQuery, opts = {}) {
      if (!query.bundleId) return fail('invalid-argument', 'macOS 上查找窗口必须给 bundle id', { action: 'findWindow', platform: 'darwin' })
      const r = await call('findWindow', { op: 'find', query: { ...query }, documentName: opts.documentName })
      if ('result' in r) return r.result
      return finish('findWindow', r.out, undefined, false, (out, evidence) => {
        const id = parseMacIdentity(out.identity)
        if (id === undefined) return undefined
        if (query.processDir && id.processPath !== query.processDir) return undefined
        evidence.after = id
        return id
      })
    },

    async focus(identity, opts) {
      const r = await call('focus', { op: 'focus', identity, ownerPids: owners(opts) })
      if ('result' in r) return r.result
      return finish('focus', r.out, identity, true, (_o, evidence) => evidence.after)
    },

    async readVisibleText(identity, grant: TextReadGrant) {
      const evidence: ActionEvidence = { action: 'readVisibleText', platform: 'darwin', grantReason: grant?.reason }
      if (grant?.authorized !== true) return fail('not-authorized', '读取可见文字需要调用方显式授权', evidence)
      const r = await call('readVisibleText', { op: 'read-text', identity, authorized: true, maxChars: grant.maxChars ?? 20_000 })
      if ('result' in r) return r.result
      const result = finish<VisibleText>('readVisibleText', r.out, identity, false, out => {
        const text = asString(out.text)
        return text === undefined ? undefined : { text, truncated: out.truncated === true }
      })
      result.evidence.grantReason = grant.reason
      return result
    },

    async readPage(identity, _profile, opts) {
      const r = await call('readPage', { op: 'read-page', identity, ownerPids: owners(opts) })
      if ('result' in r) return r.result
      return finish('readPage', r.out, identity, false, out => positionOf(out))
    },

    async gotoPage(identity, page, _profile, opts) {
      if (!validPage(page)) return fail('invalid-argument', '页码必须是正整数', { action: 'gotoPage', platform: 'darwin' })
      const r = await call('gotoPage', { op: 'goto-page', identity, page, ownerPids: owners(opts) }, Math.min(45_000, timeoutMs + 4_000))
      if ('result' in r) return r.result
      const result = finish('gotoPage', r.out, identity, true, out => positionOf(out))
      if (result.ok && result.value.page !== page) {
        return fail('failed', `读回第 ${result.value.page} 页，不是目标第 ${page} 页`, result.evidence, { detail: 'readback-mismatch' })
      }
      return result
    },

    async scroll(identity, request: ScrollRequest, _profile, opts) {
      const r = await call('scroll', { op: 'scroll', identity, direction: request.direction, unit: request.unit, count: request.count, ownerPids: owners(opts) })
      if ('result' in r) return r.result
      return finish<ScrollOutcome>('scroll', r.out, identity, true, out => {
        const pos = positionOf(out)
        if (pos === undefined || typeof out.moved !== 'boolean') return undefined
        return { ...pos, moved: out.moved, atBoundary: out.atBoundary === true, scrollValueBefore: asNumber(out.scrollValueBefore), scrollValueAfter: asNumber(out.scrollValueAfter) }
      })
    },

    dispose() { /* osascript 每次一个进程，没有常驻资源 */ },
  }
}
