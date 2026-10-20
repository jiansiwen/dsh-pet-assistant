import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActionResult, PagePosition } from '../src/main/desktop-actions.ts'
import type { DocAnchor, DocViewTargetSession, DocViewUserAction, PresenterStatus } from '../src/main/doc-presenter.ts'
import type { WpsController, WpsSession, WpsSyncStatus } from '../src/main/wps-control.ts'
import { WpsViewTarget } from '../src/main/wps-view-target.ts'

const evidence = {} as ActionResult<unknown>['evidence']
const session = { file: 'D:/授权/讲解样本.pdf', documentName: '讲解样本.pdf', profile: {}, position: { page: 1, total: 3 } } as unknown as WpsSession
const plan = { sessionId: 's1', fingerprint: 'f1', pageCount: 3, textLayer: true, sections: [], startSection: 0 } as unknown as NonNullable<DocViewTargetSession['plan']>
const shown: DocViewTargetSession = { realPath: 'D:/授权/讲解样本.pdf', name: '讲解样本.pdf', fingerprint: 'f1', plan, problem: null }
const anchor = (page: number): DocAnchor => ({ section: 0, page, precision: 'page' } as unknown as DocAnchor)
const playing: PresenterStatus = { mode: 'following', paused: false, viewPage: 1, narration: null, playing: true, stopReason: null, textLayer: true }
const inSync = (page: number): WpsSyncStatus => ({ state: 'in-sync', position: { page, total: 3 }, evidence })
const paused = (reason: 'focus-lost' | 'closed'): WpsSyncStatus => ({
  state: 'paused', reason, evidence,
  error: { code: reason === 'closed' ? 'window-not-found' : 'focus-stolen', message: reason === 'closed' ? '窗口不见了' : '前台是别的应用' },
} as WpsSyncStatus)

function fakeWps(open: ActionResult<WpsSession>) {
  const calls: string[] = []
  const queue: WpsSyncStatus[] = []
  const wps = {
    platform: 'win32', unverifiedOnDevice: false,
    open: async (file: string) => { calls.push(`open:${file}`); return open },
    syncTo: async (_session: WpsSession, page: number) => { calls.push(`sync:${page}`); return queue.shift() ?? inSync(page) },
    status: async () => { calls.push('status'); return queue.shift() ?? inSync(1) },
    dispose: () => {},
  } as unknown as WpsController
  return { wps, calls, queue }
}

function target(fake: ReturnType<typeof fakeWps>, pollMs = 60_000) {
  const notices: string[] = []
  const actions: DocViewUserAction[] = []
  const view = new WpsViewTarget({ wps: () => fake.wps, notify: message => notices.push(message), pollMs })
  view.onUserAction(action => actions.push(action))
  return { view, notices, actions }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('打开失败或读不到页码时如实抛错，不假装可以同步', async () => {
  const failed = target(fakeWps({ ok: false, error: { code: 'not-installed', message: '没装 WPS', guidance: '请先安装 WPS' }, evidence } as ActionResult<WpsSession>))
  await assert.rejects(Promise.resolve(failed.view.show(shown)), /WPS 没能打开：请先安装 WPS/)
  const noPage = target(fakeWps({ ok: true, value: { ...session, position: undefined }, evidence }))
  await assert.rejects(Promise.resolve(noPage.view.show(shown)), /读不到页码/)
  assert.equal(noPage.view.currentPage(), null)
})

test('按状态机的锚点跳页，读回页码作为当前页；连续跳页串行执行', async () => {
  const fake = fakeWps({ ok: true, value: session, evidence })
  const { view, actions } = target(fake)
  await view.show(shown)
  assert.deepEqual(fake.calls, ['open:D:/授权/讲解样本.pdf'])
  view.goto(anchor(2), { highlight: true })
  view.goto(anchor(3), { highlight: true })
  await settle()
  assert.deepEqual(fake.calls.slice(1), ['sync:2', 'sync:3'])
  assert.equal(view.currentPage(), 3)
  assert.deepEqual(actions, [], '跳到的就是讲解要的页，不算用户翻页')
  view.dispose()
})

test('失焦暂停讲解并说明原因；WPS 关闭则停止同步，之后的跳页不再碰 WPS', async () => {
  const fake = fakeWps({ ok: true, value: session, evidence })
  const { view, notices, actions } = target(fake)
  await view.show(shown)
  fake.queue.push(paused('focus-lost'))
  view.goto(anchor(2), { highlight: true })
  await settle()
  assert.equal(actions.at(-1)?.kind, 'error')
  assert.match(notices.at(-1)!, /WPS 不在前台，讲解已暂停/)

  fake.queue.push(paused('closed'))
  view.goto(anchor(2), { highlight: true })
  await settle()
  assert.equal(actions.at(-1)?.kind, 'closed')
  const before = fake.calls.length
  view.goto(anchor(3), { highlight: true })
  await settle()
  assert.equal(fake.calls.length, before, '关闭后不再向 WPS 发任何操作')
  view.dispose()
})

test('只在讲解推进时轮询；用户在 WPS 里自己翻页按手动翻页回报', async () => {
  const fake = fakeWps({ ok: true, value: session, evidence })
  const { view, actions } = target(fake, 15)
  await view.show(shown)
  await settle()
  assert.ok(!fake.calls.includes('status'), '没在讲（未收到推进状态）时不去碰 WPS')
  view.status(playing)
  fake.queue.push(inSync(3))
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.ok(fake.calls.includes('status'))
  assert.deepEqual(actions[0], { kind: 'page', page: 3 })
  view.status({ ...playing, paused: true })
  const polled = fake.calls.length
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(fake.calls.length, polled, '暂停后停止轮询')
  view.dispose()
})
