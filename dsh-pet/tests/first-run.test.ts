/**
 * 首次启动检查：给定已查到的事实，输出给用户看的检查项、下一步与数据去向。
 *
 * 钉住的几件事：
 * - 未装模型时明确引导（给下载入口，逐项确认），模型检查过了截止时间就如实报超时，不无限转圈；
 * - 会改动系统或用户配置的动作只作为"下一步"列出（下载、请求权限、装插件），这里一个都不执行；
 * - 数据去向逐项列出：本地识别、edge-tts 联网合成、对话发往会话服务商；
 * - 可选能力（分人模型、macOS 的 WPS 相关权限）缺失不影响"就绪"。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildFirstRunReport,
  MODEL_CHECK_DEADLINE_MS,
  type FirstRunInput,
  type FirstRunItem,
  type FirstRunReport,
} from '../src/main/first-run.ts'
import { MODEL_MANIFEST, type ModelCheck, type ModelId, type ModelState } from '../src/main/model-resources.ts'
import type { LaunchFailure, RuntimePlan } from '../src/main/runtime-launch.ts'

function checks(states: Partial<Record<ModelId, ModelState>> = {}): ModelCheck[] {
  return MODEL_MANIFEST.map((spec) => {
    const state = states[spec.id] ?? 'complete'
    return { id: spec.id, title: spec.title, optional: spec.optional, state, files: [], message: `${spec.title}：${state}` }
  })
}

const READY_PLAN: RuntimePlan = {
  ok: true,
  profile: 'web',
  profileDir: '/home/u/.dsh/profiles/web',
  pluginDir: '/plugins/dsh-personal-assistant',
  pluginVersion: '0.1.0',
  overlayPath: '/plugins/dsh-personal-assistant/cordis.team.patch.yml',
  cliPath: '/app/node_modules/@deepseek-ai/dsh/lib/bin.js',
  dshVersion: '0.1.1-rc.2',
  command: '/app/exe',
  args: [],
  cwd: '/home/u/.dsh/profiles/web',
  env: { ELECTRON_RUN_AS_NODE: '1' },
}

function failure(stage: LaunchFailure['stage'], message = `失败在 ${stage}`): LaunchFailure {
  return { ok: false, stage, message }
}

function input(over: Partial<FirstRunInput> = {}): FirstRunInput {
  return {
    platform: 'win32',
    packaged: true,
    models: checks(),
    permissions: { microphone: 'granted' },
    runtime: { profile: 'web', plan: READY_PLAN },
    ...over,
  }
}

function item(report: FirstRunReport, id: string): FirstRunItem {
  const found = report.items.find(entry => entry.id === id)
  assert.ok(found, `报告里没有 ${id}：${report.items.map(entry => entry.id).join(', ')}`)
  return found
}

const ALLOWED_STEPS = new Set(['confirm-download', 'request-permission', 'open-settings', 'run-command', 'reinstall', 'retry-check'])

describe('就绪与数据去向', () => {
  test('Windows 一切就绪 → 环境就绪，没有下一步，也不列 macOS 的隐私权限', () => {
    const report = buildFirstRunReport(input())
    assert.equal(report.summary.ready, true)
    assert.equal(report.summary.needsAction, 0)
    assert.equal(report.summary.headline, '环境就绪')
    assert.deepEqual(report.nextSteps, [])
    assert.equal(report.items.every(entry => entry.status === 'ready'), true, JSON.stringify(report.items))
    assert.equal(report.items.some(entry => entry.id === 'permission:accessibility'), false)
    assert.match(item(report, 'runtime').detail, /0\.1\.1-rc\.2/)
  })

  test('数据去向逐项列出：本地识别在本机，edge-tts 与对话在云端，并写明去向', () => {
    const flows = buildFirstRunReport(input()).dataFlows
    const byId = new Map(flows.map(flow => [flow.id, flow]))
    assert.deepEqual([...byId.keys()], ['local-speech', 'edge-tts', 'model-chat', 'voice-api'])
    assert.equal(byId.get('local-speech')?.where, 'local')
    assert.equal(byId.get('edge-tts')?.where, 'cloud')
    assert.match(byId.get('edge-tts')!.destination, /speech\.platform\.bing\.com/)
    assert.match(byId.get('edge-tts')!.data, /不发送录音/)
    assert.equal(byId.get('model-chat')?.where, 'cloud')
    assert.match(byId.get('model-chat')!.destination, /profile「web」/)
    assert.match(byId.get('model-chat')!.data, /文档/)
    assert.match(byId.get('model-chat')!.data, /会议转写/)
    assert.equal(byId.get('voice-api')?.active, false)
    for (const flow of flows) assert.ok(flow.control.length > 0, flow.id)
  })

  test('选用自配语音服务后：听写改道、朗读不再走 edge-tts，唤醒与会议仍在本机', () => {
    const flows = buildFirstRunReport(input({ voiceApi: { asr: true, tts: true } })).dataFlows
    const byId = new Map(flows.map(flow => [flow.id, flow]))
    assert.equal(byId.get('voice-api')?.active, true)
    assert.match(byId.get('voice-api')!.data, /听写录音与要朗读的文字/)
    assert.equal(byId.get('edge-tts')?.active, false)
    assert.equal(byId.get('local-speech')?.active, true)
    assert.match(byId.get('local-speech')!.control, /唤醒词与会议转写仍在本机/)
  })
})

describe('模型：未装明确引导，不无限等待', () => {
  test('macOS 什么模型都没装 → 听写模型要处理、分人模型可选，下载合并成一次逐项确认', () => {
    const report = buildFirstRunReport(input({
      platform: 'darwin',
      models: checks({ sensevoice: 'missing', streaming: 'missing', 'diarization-segmentation': 'missing', 'diarization-embedding': 'missing' }),
      permissions: { microphone: 'granted', mac: { accessibility: 'granted', automation: 'granted', 'screen-recording': 'granted' } },
    }))
    assert.equal(item(report, 'model:sensevoice').status, 'action')
    assert.equal(item(report, 'model:streaming').status, 'action')
    assert.match(item(report, 'model:streaming').impact ?? '', /Mac 上听写不可用/)
    assert.equal(item(report, 'model:diarization-segmentation').status, 'optional')
    assert.equal(item(report, 'model:diarization-embedding').status, 'optional')
    const downloads = report.nextSteps.filter(step => step.kind === 'confirm-download')
    assert.equal(downloads.length, 1)
    assert.deepEqual(
      downloads[0].kind === 'confirm-download' ? [...downloads[0].modelIds].sort() : [],
      ['diarization-embedding', 'diarization-segmentation', 'sensevoice', 'streaming'],
    )
    assert.match(downloads[0].label, /逐项确认/)
    assert.equal(report.summary.ready, false)
    assert.equal(report.summary.needsAction, 2)
  })

  test('只缺可选的分人模型 → 仍算就绪，但下一步里有下载入口', () => {
    const report = buildFirstRunReport(input({ models: checks({ 'diarization-embedding': 'missing' }) }))
    assert.equal(report.summary.ready, true)
    assert.equal(report.nextSteps.length, 1)
    assert.equal(report.nextSteps[0].kind, 'confirm-download')
  })

  test('损坏的模型哪怕是可选的也要处理：损坏文件可能让识别器加载失败', () => {
    const report = buildFirstRunReport(input({ models: checks({ 'diarization-embedding': 'corrupt' }) }))
    const entry = item(report, 'model:diarization-embedding')
    assert.equal(entry.status, 'action')
    assert.equal(entry.step?.kind, 'confirm-download')
    assert.match(entry.step?.label ?? '', /替换/)
    assert.equal(report.summary.ready, false)
  })

  test('Windows 缺听写模型时说明会退回系统识别，而不是说不可用', () => {
    const report = buildFirstRunReport(input({ models: checks({ streaming: 'missing' }) }))
    assert.match(item(report, 'model:streaming').impact ?? '', /系统自带识别/)
  })

  test('还在检查：截止时间内显示检查中；过了截止时间如实报超时并给出重试', () => {
    const waiting = buildFirstRunReport(input({ models: null, modelCheckStartedAt: 0, now: 1_000 }))
    assert.equal(item(waiting, 'models').status, 'checking')
    assert.equal(waiting.summary.ready, false)
    assert.equal(waiting.summary.checking, 1)
    assert.equal(waiting.summary.headline, '正在检查环境…')

    const late = buildFirstRunReport(input({ models: null, modelCheckStartedAt: 0, now: MODEL_CHECK_DEADLINE_MS + 1 }))
    const entry = item(late, 'models')
    assert.equal(entry.status, 'blocked')
    assert.equal(entry.step?.kind, 'retry-check')
    assert.match(entry.detail, /已停止等待/)
    assert.equal(late.summary.checking, 0)
    assert.match(late.summary.headline, /本地语音模型/)
  })
})

describe('权限', () => {
  test('麦克风未询问 → 让系统弹询问（由界面在用户点了之后做）', () => {
    const report = buildFirstRunReport(input({ platform: 'darwin', permissions: { microphone: 'not-determined' } }))
    const entry = item(report, 'permission:microphone')
    assert.equal(entry.status, 'action')
    assert.deepEqual(entry.step, { kind: 'request-permission', label: '让系统弹出麦克风授权询问', permission: 'microphone' })
  })

  test('麦克风被拒 → 打开系统设置，两平台的入口不同', () => {
    const win = item(buildFirstRunReport(input({ permissions: { microphone: 'denied' } })), 'permission:microphone')
    assert.equal(win.step?.kind, 'open-settings')
    assert.equal(win.step?.kind === 'open-settings' ? win.step.uri : null, 'ms-settings:privacy-microphone')
    const mac = item(buildFirstRunReport(input({ platform: 'darwin', permissions: { microphone: 'denied' } })), 'permission:microphone')
    assert.match(mac.step?.kind === 'open-settings' ? mac.step.uri ?? '' : '', /^x-apple\.systempreferences:.*Privacy_Microphone$/)
    const restricted = item(buildFirstRunReport(input({ permissions: { microphone: 'restricted' } })), 'permission:microphone')
    assert.match(restricted.detail, /策略/)
  })

  test('读不到麦克风状态 → 未知，不算需要处理，也不编一个下一步', () => {
    const report = buildFirstRunReport(input({ platform: 'linux', permissions: { microphone: 'unknown' } }))
    const entry = item(report, 'permission:microphone')
    assert.equal(entry.status, 'unknown')
    assert.equal(entry.step, null)
    assert.equal(report.summary.ready, true)
  })

  test('macOS 隐私权限只影响 WPS 讲解：拒绝 → 可选项并给设置入口，未检查 → 未知，都不挡就绪', () => {
    const report = buildFirstRunReport(input({
      platform: 'darwin',
      permissions: { microphone: 'granted', mac: { accessibility: 'denied', automation: 'granted' } },
    }))
    const accessibility = item(report, 'permission:accessibility')
    assert.equal(accessibility.status, 'optional')
    assert.match(accessibility.step?.kind === 'open-settings' ? accessibility.step.uri ?? '' : '', /Privacy_Accessibility$/)
    assert.match(accessibility.impact ?? '', /WPS/)
    assert.equal(item(report, 'permission:automation').status, 'ready')
    assert.equal(item(report, 'permission:screen-recording').status, 'unknown')
    assert.equal(report.summary.ready, true)
  })
})

describe('运行时：插件不随包，缺了就给出用户自己执行的命令', () => {
  test('安装版缺插件 → 用壳自身可执行文件跑随包 CLI 的完整命令，写明会改动 profile、需要 pnpm', () => {
    const report = buildFirstRunReport(input({
      runtime: {
        profile: 'web',
        plan: failure('locate-plugin'),
        cliPath: 'C:\\P\\dsh 桌面助理团\\resources\\app.asar.unpacked\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
        execPath: 'C:\\P\\dsh 桌面助理团\\dsh 桌面助理团.exe',
      },
    }))
    const entry = item(report, 'runtime')
    assert.equal(entry.status, 'action')
    assert.equal(entry.step?.kind, 'run-command')
    if (entry.step?.kind !== 'run-command') return
    assert.match(entry.step.command, /ELECTRON_RUN_AS_NODE/)
    assert.equal(entry.step.command.includes("'C:\\P\\dsh 桌面助理团\\dsh 桌面助理团.exe'"), true, entry.step.command)
    assert.match(entry.step.command, /'plugin' '--profile' 'web' 'add' '<插件包路径>'/)
    assert.match(entry.step.effect, /~\/\.dsh\/profiles\/web/)
    assert.match(entry.step.effect, /pnpm/)
    assert.match(entry.step.effect, /不会替你执行/)
    assert.match(entry.impact ?? '', /桌面角色照常显示/)
  })

  test('开发态缺插件 → 直接给 dsh plugin 命令', () => {
    const report = buildFirstRunReport(input({ packaged: false, runtime: { profile: 'web', plan: failure('locate-plugin') } }))
    const step = item(report, 'runtime').step
    assert.equal(step?.kind === 'run-command' ? step.command : null, 'dsh plugin --profile web add <插件包路径>')
  })

  test('profile 不存在 → 同一条命令会先新建 profile；名字不合法 → 不给命令，引导换一个', () => {
    const missing = item(buildFirstRunReport(input({ runtime: { profile: 'web', plan: failure('locate-profile', 'profile「web」不存在') } })), 'runtime')
    assert.equal(missing.step?.kind, 'run-command')
    assert.match(missing.step?.label ?? '', /新建 profile/)
    const invalid = item(buildFirstRunReport(input({ runtime: { profile: '../x', plan: failure('locate-profile', 'profile 名「../x」不合法') } })), 'runtime')
    assert.equal(invalid.step?.kind, 'retry-check')
  })

  test('找不到随包 CLI：安装版是安装包不完整，只能重装；开发态是去装依赖', () => {
    const packaged = item(buildFirstRunReport(input({ runtime: { profile: 'web', plan: failure('locate-cli') } })), 'runtime')
    assert.equal(packaged.status, 'blocked')
    assert.equal(packaged.step?.kind, 'reinstall')
    const dev = item(buildFirstRunReport(input({ packaged: false, runtime: { profile: 'web', plan: failure('locate-cli') } })), 'runtime')
    assert.equal(dev.status, 'action')
    assert.equal(dev.step?.kind === 'run-command' ? dev.step.command : null, 'pnpm install')
  })

  test('运行时还没核对 → 检查中', () => {
    const report = buildFirstRunReport(input({ runtime: { profile: 'web', plan: null } }))
    assert.equal(item(report, 'runtime').status, 'checking')
    assert.equal(report.summary.ready, false)
  })
})

describe('汇总', () => {
  test('下一步按 blocked → action → optional 排；只列用户可操作的动作，没有任何自动执行项', () => {
    const report = buildFirstRunReport(input({
      platform: 'darwin',
      models: checks({ streaming: 'missing' }),
      permissions: { microphone: 'denied', mac: { accessibility: 'denied' } },
      runtime: { profile: 'web', plan: failure('locate-cli') },
    }))
    assert.deepEqual(report.nextSteps.map(step => step.kind), ['reinstall', 'confirm-download', 'open-settings', 'open-settings'])
    const settings = report.nextSteps.filter(step => step.kind === 'open-settings')
    assert.deepEqual(settings.map(step => step.kind === 'open-settings' ? step.target : null), ['microphone', 'accessibility'])
    for (const step of report.nextSteps) assert.equal(ALLOWED_STEPS.has(step.kind), true, step.kind)
    assert.equal(report.summary.needsAction, 3)
    assert.match(report.summary.headline, /还有 3 项需要处理/)
  })

  test('纯函数：同样的输入给出同样的输出，不改动输入', () => {
    const frozen = deepFreeze(input({
      platform: 'darwin',
      models: checks({ sensevoice: 'corrupt' }),
      permissions: { microphone: 'not-determined', mac: { automation: 'denied' } },
      runtime: { profile: 'web', plan: failure('locate-plugin'), cliPath: '/a/bin.js', execPath: '/a/exe' },
    }))
    assert.deepEqual(buildFirstRunReport(frozen), buildFirstRunReport(frozen))
  })
})

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}
