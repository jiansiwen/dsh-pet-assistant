import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allPassed, registerValidator, resetSemanticValidators, validateEvidence } from '../src/semantic-validators.ts'

const digestA = 'a'.repeat(64)
const digestB = 'b'.repeat(64)

const fileEvidence = (over: Record<string, unknown> = {}) => ({
  authorizedDirs: ['D:\\authorized'],
  artifacts: [{ path: 'D:\\authorized\\out\\translated.docx', expectedDigest: digestA, actualDigest: digestA }],
  coverage: { total: 3, covered: 3, reportRef: 'coverage-report-1' },
  ...over,
})

test('file-artifact：授权目录内、重读摘要一致、覆盖齐全才通过', () => {
  assert.equal(allPassed('file-artifact', fileEvidence()), true)
  assert.equal(allPassed('file-artifact', fileEvidence({ authorizedDirs: ['D:\\authorized\\out'] })), true, '子目录授权同样有效')
  assert.equal(allPassed('file-artifact', fileEvidence({
    artifacts: [{ path: 'D:/authorized/out/translated.docx', expectedDigest: digestA, actualDigest: digestA }],
  })), true, '分隔符写法不同但仍是同一规范路径')
})

test('file-artifact：重读摘要不符拒绝', () => {
  const evidence = fileEvidence({
    artifacts: [{ path: 'D:\\authorized\\out\\translated.docx', expectedDigest: digestA, actualDigest: digestB }],
  })
  assert.equal(allPassed('file-artifact', evidence), false)
  assert.match(validateEvidence('file-artifact', evidence).reasons.join('；'), /摘要/)
  assert.equal(allPassed('file-artifact', fileEvidence({
    artifacts: [{ path: 'D:\\authorized\\out\\translated.docx', expectedDigest: '短摘要', actualDigest: '短摘要' }],
  })), false, '非 sha256 摘要不认')
})

test('file-artifact：越界路径与路径逃逸拒绝', () => {
  assert.equal(allPassed('file-artifact', fileEvidence({
    artifacts: [{ path: 'D:\\other\\translated.docx', expectedDigest: digestA, actualDigest: digestA }],
  })), false, '授权目录之外拒绝')
  assert.equal(allPassed('file-artifact', fileEvidence({
    artifacts: [{ path: 'D:\\authorized\\..\\secret\\translated.docx', expectedDigest: digestA, actualDigest: digestA }],
  })), false, '含 .. 的路径一律拒绝，不先归一再猜')
  assert.equal(allPassed('file-artifact', fileEvidence({
    artifacts: [{ path: 'out\\translated.docx', expectedDigest: digestA, actualDigest: digestA }],
  })), false, '相对路径拒绝')
  assert.equal(allPassed('file-artifact', fileEvidence({
    artifacts: [{ path: 'D:\\authorized-evil\\translated.docx', expectedDigest: digestA, actualDigest: digestA }],
  })), false, '前缀同名目录不算授权目录内')
  assert.equal(allPassed('file-artifact', fileEvidence({ authorizedDirs: [] })), false, '没有授权目录清单不通过')
})

test('file-artifact：覆盖报告不齐全拒绝', () => {
  assert.equal(allPassed('file-artifact', fileEvidence({ coverage: { total: 3, covered: 2, reportRef: 'r' } })), false)
  assert.equal(allPassed('file-artifact', fileEvidence({ coverage: { total: 3, covered: 3 } })), false, '缺报告引用')
  assert.equal(allPassed('file-artifact', fileEvidence({ coverage: null })), false)
  assert.equal(allPassed('file-artifact', fileEvidence({ artifacts: [] })), false, '没有产物不通过')
})

const uiEvidence = (successCheck: Record<string, unknown>, readBack: Record<string, unknown>) => ({ successCheck, readBack })

test('ui-readback：页码与期望一致才通过', () => {
  assert.equal(allPassed('ui-readback', uiEvidence({ page: 3, total: 12 }, { page: 3, total: 12 })), true)
  assert.equal(allPassed('ui-readback', uiEvidence({ page: 3 }, { page: 4, total: 12 })), false, '读回页码不符不 passed')
  assert.equal(allPassed('ui-readback', uiEvidence({ page: 3, total: 12 }, { page: 3, total: 13 })), false, '总页数不符也不 passed')
  assert.equal(allPassed('ui-readback', uiEvidence({ page: 3 }, {})), false, '缺读回值不 passed')
})

test('ui-readback：控件值/文字期望逐项核对', () => {
  assert.equal(allPassed('ui-readback', uiEvidence({ controlValue: '已保存' }, { controlValue: '已保存' })), true)
  assert.equal(allPassed('ui-readback', uiEvidence({ controlValue: '已保存' }, { controlValue: '未保存' })), false)
  assert.equal(allPassed('ui-readback', uiEvidence({ textIncludes: '翻译完成' }, { text: '第 3 页 翻译完成' })), true)
  assert.equal(allPassed('ui-readback', uiEvidence({ textIncludes: '翻译完成' }, { text: '第 3 页' })), false)
  assert.equal(allPassed('ui-readback', uiEvidence({}, { page: 3 })), false, '没有声明期望不能证明匹配')
  assert.equal(allPassed('ui-readback', { readBack: { page: 3 } }), false, '缺 successCheck 不通过')
  assert.equal(allPassed('ui-readback', null), false)
})

test('未登记验证器的 kind 一律不通过（fail-closed）；自定义验证器可登记', () => {
  assert.equal(allPassed('desktop-action', { anything: true }), false, '没有验证器不能直接判完成')
  assert.equal(allPassed('no-such-kind', {}), false)
  registerValidator({ kind: 'custom-check', check: evidence => ({ passed: evidence === 'ok', reason: evidence === 'ok' ? '通过' : '证据不符' }) })
  assert.equal(allPassed('custom-check', 'ok'), true)
  assert.equal(allPassed('custom-check', 'bad'), false)
  resetSemanticValidators()
  assert.equal(allPassed('custom-check', 'ok'), false, '重置后自定义验证器清除')
  assert.equal(allPassed('ui-readback', uiEvidence({ page: 3 }, { page: 3 })), true, '内置验证器仍在')
})

test('检查抛错按不通过处理，不放过异常证据', () => {
  registerValidator({ kind: 'throwing', check: () => { throw new Error('boom') } })
  try {
    assert.equal(allPassed('throwing', {}), false)
  } finally { resetSemanticValidators() }
})