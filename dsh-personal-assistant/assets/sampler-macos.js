// Personal-assistant foreground app sampler for macOS (managed child process, file-backed).
// Launched by the plugin as:  /usr/bin/osascript -l JavaScript sampler-macos.js
// Appends one JSON sample per interval to <DSH_SAMPLE_DIR>/<yyyy-MM-dd>.jsonl (local date),
// writes its own pid to <DSH_SAMPLE_DIR>/sampler.pid and keeps running until the plugin kills it.
//
// Same JSONL fields as sampler.ps1:
//   {"ts":<unix-ms>,"pid":N,"proc":"name","title":"text","idleMs":N}
//   without title authorization (DSH_SAMPLE_TITLES=0): {"ts","pid","proc","idleMs"}
//   no frontmost app (or login window / screen saver):  {"ts","idle":true,"idleMs"}
//   excluded app or excluded title keyword:              {"ts","excluded":true}
// macOS-only marker: when titles are authorized but cannot be read, the sample carries
//   "titleUnavailable":"accessibility" | "automation" | "error" and has no "title" (never invented).
//
// Privacy order (same as Windows): the excluded-process check runs BEFORE any title read, and a hit
// never contacts System Events. With titles off, System Events is not contacted at all.
//
// Permissions: app name, pid and idle time need none (NSWorkspace + ioreg). Window titles go through
// System Events UI scripting, which needs Accessibility; macOS also asks once for Automation
// ("control System Events"). Both are granted to the app that launched dsh (Terminal, iTerm, ...).
//
// This file is ASCII on purpose (like sampler.ps1): osascript must never have to guess the encoding.
// Everything above run() is plain JavaScript without ObjC/Application access, so the plugin's tests
// evaluate this exact file in Node and exercise the decision logic that ships here.

var DEFAULT_EXCLUDED_PROCESSES = ['KeePass', 'KeePassXC', '1Password', 'Bitwarden']
var DEFAULT_INTERVAL_MS = 5000
var MIN_INTERVAL_MS = 1000
// Frontmost "apps" that mean nobody is working: treated like a missing foreground window on Windows.
var IDLE_BUNDLE_IDS = ['com.apple.loginwindow', 'com.apple.ScreenSaver.Engine']
var IOREG_COMMAND = '/usr/sbin/ioreg -c IOHIDSystem'

// Exclusion lists arrive as JSON arrays. A broken list fails closed (see run): sampling without the
// user's exclusions could write the very titles they asked us to skip.
function parseList(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return { value: fallback.slice(), error: null }
  var parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch (e) {
    return { value: fallback.slice(), error: 'exclusion list is not valid JSON' }
  }
  if (!Array.isArray(parsed)) return { value: fallback.slice(), error: 'exclusion list is not a JSON array' }
  var out = []
  for (var i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] === 'string' && parsed[i].length > 0) out.push(parsed[i])
  }
  return { value: out, error: null }
}

function parseConfig(env) {
  var dir = env.DSH_SAMPLE_DIR ? String(env.DSH_SAMPLE_DIR) : ''
  var interval = parseInt(String(env.DSH_SAMPLE_INTERVAL_MS || ''), 10)
  if (!isFinite(interval)) interval = DEFAULT_INTERVAL_MS
  if (interval < MIN_INTERVAL_MS) interval = MIN_INTERVAL_MS
  var processes = parseList(env.DSH_SAMPLE_EXCLUDED_PROCESSES, DEFAULT_EXCLUDED_PROCESSES)
  var titles = parseList(env.DSH_SAMPLE_EXCLUDED_TITLES, [])
  return {
    dir: dir,
    intervalMs: interval,
    captureTitles: String(env.DSH_SAMPLE_TITLES) !== '0',
    excludedProcesses: processes.value,
    excludedTitles: titles.value,
    error: dir ? (processes.error || titles.error || null) : 'DSH_SAMPLE_DIR is missing',
  }
}

// Case-insensitive like PowerShell -contains. Any identity counts (executable, display name, bundle
// id), so a user who wrote "1Password 7" or "com.bitwarden.desktop" is honored too.
function isExcludedApp(app, list) {
  var ids = [app.executable, app.name, app.bundleId]
  for (var i = 0; i < list.length; i++) {
    var wanted = String(list[i]).toLowerCase()
    if (!wanted) continue
    for (var j = 0; j < ids.length; j++) {
      if (ids[j] && String(ids[j]).toLowerCase() === wanted) return true
    }
  }
  return false
}

function hasExcludedKeyword(title, keywords) {
  var text = String(title).toLowerCase()
  for (var i = 0; i < keywords.length; i++) {
    var keyword = String(keywords[i])
    if (keyword && text.indexOf(keyword.toLowerCase()) >= 0) return true
  }
  return false
}

function isIdleApp(app) {
  return IDLE_BUNDLE_IDS.indexOf(app.bundleId) >= 0
}

// ioreg prints the HID idle time in nanoseconds:   "HIDIdleTime" = 4275000000
function parseHidIdleMs(text) {
  var match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(text || ''))
  if (!match) return null
  var ns = Number(match[1])
  if (!isFinite(ns) || ns < 0) return null
  return Math.floor(ns / 1000000)
}

// System Events error numbers are locale independent; the text match is only a fallback.
//   -1719 / -25211: UI scripting refused, the launching app lacks Accessibility.
//   -1743: Automation of System Events not allowed (denied, or never answered).
function classifyTitleError(error) {
  var code = error && typeof error.errorNumber === 'number' ? error.errorNumber : null
  var text = String((error && error.message) || error || '')
  if (code === -1719 || code === -25211 || /assistive access|accessibility|\u8f85\u52a9/i.test(text)) return 'accessibility'
  if (code === -1743 || /not (authori[sz]ed|allowed) to send apple ?events/i.test(text)) return 'automation'
  return 'error'
}

// One sample from a probe: { now(), idleMs(), frontmost(), title(app) }.
// frontmost() returns { pid, executable, name, bundleId } or null; title(app) throws on failure.
function buildSample(probe, config) {
  var ts = probe.now()
  var idleMs = null
  try {
    idleMs = probe.idleMs()
  } catch (e) {
    idleMs = null
  }
  var app = probe.frontmost()
  if (!app || isIdleApp(app)) {
    var idle = { ts: ts, idle: true }
    if (typeof idleMs === 'number') idle.idleMs = idleMs
    return idle
  }
  // Decided from the app identity alone, before any title read: an excluded app never reaches System Events.
  if (isExcludedApp(app, config.excludedProcesses)) return { ts: ts, excluded: true }
  var sample = { ts: ts, pid: app.pid, proc: app.executable || app.name || 'unknown' }
  if (typeof idleMs === 'number') sample.idleMs = idleMs
  if (!config.captureTitles) return sample
  var title
  try {
    title = probe.title(app)
  } catch (error) {
    sample.titleUnavailable = classifyTitleError(error)
    return sample
  }
  title = title === null || title === undefined ? '' : String(title)
  if (hasExcludedKeyword(title, config.excludedTitles)) return { ts: ts, excluded: true }
  sample.title = title
  return sample
}

function sampleLine(sample) {
  return JSON.stringify(sample)
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

// Local calendar date, matching Get-Date -Format 'yyyy-MM-dd' on Windows and localDateOf() in the plugin.
function localDate(ms) {
  var d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

function sampleFileName(ms) {
  return localDate(ms) + '.jsonl'
}

// ---------------------------------------------------------------------------------------------
// Everything below talks to macOS (ObjC bridge, System Events, the shell) and only runs under osascript.
// ---------------------------------------------------------------------------------------------

function unwrapString(value) {
  if (value === undefined || value === null) return ''
  if (typeof value.isNil === 'function' && value.isNil()) return ''
  var text = ObjC.unwrap(value)
  return typeof text === 'string' ? text : ''
}

function readEnvironment(names) {
  var env = $.NSProcessInfo.processInfo.environment
  var out = {}
  for (var i = 0; i < names.length; i++) out[names[i]] = unwrapString(env.objectForKey(names[i]))
  return out
}

function joinPath(dir, name) {
  return dir.charAt(dir.length - 1) === '/' ? dir + name : dir + '/' + name
}

function writeText(file, text) {
  $(text).writeToFileAtomicallyEncodingError($(file), true, $.NSUTF8StringEncoding, $())
}

function appendLine(file, line) {
  var manager = $.NSFileManager.defaultManager
  var data = $(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding)
  if (!manager.fileExistsAtPath($(file))) {
    if (!manager.createFileAtPathContentsAttributes($(file), data, $())) throw new Error('cannot create sample file')
    return
  }
  var handle = $.NSFileHandle.fileHandleForWritingAtPath($(file))
  if (handle.isNil()) throw new Error('cannot open sample file')
  handle.seekToEndOfFile
  handle.writeData(data)
  handle.closeFile
}

function macProbe() {
  var workspace = $.NSWorkspace.sharedWorkspace
  var shell = Application.currentApplication()
  shell.includeStandardAdditions = true
  var systemEvents = null
  return {
    now: function () {
      return Date.now()
    },
    idleMs: function () {
      return parseHidIdleMs(shell.doShellScript(IOREG_COMMAND))
    },
    frontmost: function () {
      var app = workspace.frontmostApplication
      if (!app || app.isNil()) return null
      var executable = app.executableURL
      return {
        pid: Number(app.processIdentifier),
        executable: executable && !executable.isNil() ? unwrapString(executable.lastPathComponent) : '',
        name: unwrapString(app.localizedName),
        bundleId: unwrapString(app.bundleIdentifier),
      }
    },
    // Only called after the exclusion check and only with title authorization on.
    title: function (app) {
      if (systemEvents === null) systemEvents = Application('System Events')
      var matches = systemEvents.processes.whose({ unixId: app.pid })
      if (matches.length === 0) return ''
      var windows = matches[0].windows
      if (windows.length === 0) return ''
      return windows[0].name()
    },
  }
}

// Sleep that also lets the main run loop deliver NSWorkspace notifications: a command-line process
// that never runs its loop can keep reporting a stale frontmost app. runUntilDate returns at once when
// the loop has no input sources, so a real delay follows and the loop never spins.
function pause(ms) {
  var until = Date.now() + ms
  var loop = $.NSRunLoop.currentRunLoop
  while (true) {
    var left = until - Date.now()
    if (left <= 0) return
    loop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(Math.min(left, 250) / 1000))
    left = until - Date.now()
    if (left > 0) delay(Math.min(left, 250) / 1000)
  }
}

function run() {
  ObjC.import('Foundation')
  ObjC.import('AppKit')
  ObjC.import('stdlib')
  var config = parseConfig(readEnvironment([
    'DSH_SAMPLE_DIR',
    'DSH_SAMPLE_INTERVAL_MS',
    'DSH_SAMPLE_TITLES',
    'DSH_SAMPLE_EXCLUDED_PROCESSES',
    'DSH_SAMPLE_EXCLUDED_TITLES',
  ]))
  // Fail closed: no sample dir, or an unreadable exclusion list, means we record nothing at all.
  if (config.error) $.exit(1)
  $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(config.dir), true, $(), $())
  // Publish own pid so the plugin can diagnose this process (not used as a liveness check).
  try {
    writeText(joinPath(config.dir, 'sampler.pid'), String($.NSProcessInfo.processInfo.processIdentifier))
  } catch (e) {}
  var probe = macProbe()
  while (true) {
    try {
      var sample = buildSample(probe, config)
      appendLine(joinPath(config.dir, sampleFileName(sample.ts)), sampleLine(sample))
    } catch (e) {
      // Skip a failed single sample and keep sampling (same as sampler.ps1).
    }
    pause(config.intervalMs)
  }
}
