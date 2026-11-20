/**
 * 语义验证器（4.6 切片1）：执行器回执从 review 走向 done 之前的只读证据检查。
 *
 * 规则来自设计文档 4.6：仅 issued=true 最多 review；读回/产物证据通过语义校验
 * 才允许 review→done。这里不做模型调用、不产生副作用，只对执行器交回的证据
 * 做确定性检查。没有任何验证器登记的 kind 一律不通过（fail-closed）。
 *
 * 验证器按证据种类登记（file-artifact / ui-readback，也可按任务 kind 登记）；
 * 回执侧用 validatorKind 指明本份证据应走哪一组检查。
 */

export interface SemanticCheckResult {
  passed: boolean
  reason: string
}

export interface SemanticValidator {
  kind: string
  check(evidence: unknown): SemanticCheckResult
}

const validators = new Map<string, SemanticValidator[]>()

const pass = (reason: string): SemanticCheckResult => ({ passed: true, reason })
const fail = (reason: string): SemanticCheckResult => ({ passed: false, reason })

export function registerValidator(validator: SemanticValidator): void {
  if (!validator || typeof validator.kind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(validator.kind)
    || typeof validator.check !== 'function') {
    throw new Error('语义验证器必须声明 kind 与 check')
  }
  const list = validators.get(validator.kind) ?? []
  list.push(validator)
  validators.set(validator.kind, list)
}

/** 逐项检查并保留原因，供回执与产物审计。无验证器或检查抛错都算不通过。 */
export function validateEvidence(kind: string, evidence: unknown): { passed: boolean; reasons: string[] } {
  const list = validators.get(kind)
  if (!list || list.length === 0) return { passed: false, reasons: [`没有为 ${kind} 登记语义验证器，不能据此判定完成`] }
  const reasons: string[] = []
  let passed = true
  for (const validator of list) {
    let result: SemanticCheckResult
    try { result = validator.check(evidence) } catch { result = fail('证据检查异常') }
    if (result.passed !== true) passed = false
    reasons.push(result.reason)
  }
  return { passed, reasons }
}

/** 供执行器回执 review→done 判定：该 kind 下全部验证器通过才算通过。 */
export function allPassed(kind: string, evidence: unknown): boolean {
  return validateEvidence(kind, evidence).passed
}

/** 仅供测试与装配重置：清空后重新登记内置验证器。 */
export function resetSemanticValidators(): void {
  validators.clear()
  registerValidator(fileArtifactValidator)
  registerValidator(uiReadbackValidator)
}

// ===== 内置验证器 =====

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const sha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const positiveInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * 规范化绝对路径：统一分隔符、拒绝任何 `..` 段（证据路径必须是规范路径，
 * 不接受"先归一再猜"）。Windows 盘符/UNC 路径按大小写不敏感比较。
 */
function canonicalAbsolute(raw: unknown): { path: string; insensitive: boolean } | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2000) return null
  const win = /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]+\\[^\\]+/.test(raw)
  if (!win && !raw.startsWith('/')) return null
  const unified = raw.replace(/\\/g, '/')
  const segments = unified.split('/')
  if (segments.some(segment => segment === '..')) return null
  const cleaned = segments.filter(segment => segment !== '' && segment !== '.')
  if (win && /^[A-Za-z]:$/.test(segments[0] ?? '')) {
    if (cleaned.length < 1) return null
    return { path: cleaned.join('/').toLowerCase(), insensitive: true }
  }
  if (win) {
    // UNC：//server/share/... 至少要有服务器与共享名
    if (cleaned.length < 2) return null
    return { path: `//${cleaned.join('/')}`.toLowerCase(), insensitive: true }
  }
  if (cleaned.length === 0) return null
  return { path: `/${cleaned.join('/')}`, insensitive: false }
}

function pathWithin(file: { path: string; insensitive: boolean }, dir: { path: string; insensitive: boolean }): boolean {
  if (file.insensitive !== dir.insensitive) return false
  const base = dir.path.endsWith('/') ? dir.path : `${dir.path}/`
  return file.path.startsWith(base) && file.path.length > base.length
}

/**
 * 产物验证：产物路径在授权目录内 + 重读摘要与期望一致 + 覆盖报告齐全。
 * 证据形状：{ authorizedDirs: string[], artifacts: [{path, expectedDigest, actualDigest}],
 *            coverage: {total, covered, reportRef} }
 */
export const fileArtifactValidator: SemanticValidator = {
  kind: 'file-artifact',
  check(evidence) {
    const value = object(evidence)
    if (!value) return fail('产物证据必须是对象')
    const dirs = Array.isArray(value.authorizedDirs) ? value.authorizedDirs.map(canonicalAbsolute) : []
    if (dirs.length === 0 || dirs.some(dir => dir === null)) return fail('缺少有效的授权目录清单')
    const artifacts = Array.isArray(value.artifacts) ? value.artifacts : []
    if (artifacts.length === 0) return fail('没有登记任何产物')
    for (const raw of artifacts) {
      const artifact = object(raw)
      if (!artifact) return fail('产物条目必须是对象')
      const file = canonicalAbsolute(artifact.path)
      if (!file) return fail('产物路径不是规范的绝对路径')
      if (!dirs.some(dir => dir !== null && pathWithin(file, dir))) return fail(`产物路径越出授权目录：${String(artifact.path).slice(0, 200)}`)
      if (!sha256(artifact.expectedDigest) || !sha256(artifact.actualDigest)) return fail('产物缺少有效的期望/重读摘要')
      if (artifact.expectedDigest !== artifact.actualDigest) return fail('产物重读摘要与期望不一致')
    }
    const coverage = object(value.coverage)
    if (!coverage || !positiveInt(coverage.total) || typeof coverage.covered !== 'number'
      || !Number.isSafeInteger(coverage.covered) || coverage.covered !== coverage.total
      || typeof coverage.reportRef !== 'string' || !coverage.reportRef) {
      return fail('覆盖报告不齐全：必须全部覆盖并给出报告引用')
    }
    return pass('产物在授权目录内、重读摘要一致且覆盖报告齐全')
  },
}

/**
 * UI 读回验证：读回证据的控件值/页码与 successCheck 期望逐项一致。
 * 证据形状：{ successCheck: {controlValue?, textIncludes?, page?, total?},
 *            readBack: {controlValue?, text?, page?, total?} }
 * 至少声明一项期望；任何一项不符都没有通过。
 */
export const uiReadbackValidator: SemanticValidator = {
  kind: 'ui-readback',
  check(evidence) {
    const value = object(evidence)
    const expected = object(value?.successCheck)
    const readBack = object(value?.readBack)
    if (!expected || !readBack) return fail('读回证据必须同时包含 successCheck 与 readBack')
    const checks: Array<() => boolean> = []
    if (expected.page !== undefined) {
      checks.push(() => positiveInt(expected.page) && readBack.page === expected.page)
    }
    if (expected.total !== undefined) {
      checks.push(() => positiveInt(expected.total) && readBack.total === expected.total)
    }
    if (expected.controlValue !== undefined) {
      checks.push(() => typeof expected.controlValue === 'string'
        && (readBack.controlValue ?? readBack.text) === expected.controlValue)
    }
    if (expected.textIncludes !== undefined) {
      checks.push(() => typeof expected.textIncludes === 'string' && expected.textIncludes.length > 0
        && typeof readBack.text === 'string' && readBack.text.includes(expected.textIncludes))
    }
    if (checks.length === 0) return fail('successCheck 没有声明任何期望，不能证明读回匹配')
    if (!checks.every(check => check())) return fail('读回的控件值/页码与 successCheck 期望不一致')
    return pass('读回证据与 successCheck 期望一致')
  },
}

registerValidator(fileArtifactValidator)
registerValidator(uiReadbackValidator)