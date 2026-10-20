/**
 * 桌面宠物目录解析的行为契约：社区零配置可用的关键。
 *
 * 顺序必须钉死：显式配置 > DSH_PET_DIR > 插件同级 dsh-pet。
 * 顺序错了，用户明明配了 petDir 却被同级目录抢走，或者克隆仓库的人根本没被发现。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolvePetDir } from '../src/pet-dir.ts'

/** 存在性判断按真实路径比较：Windows 上 path.resolve 会把正斜杠统一成反斜杠。 */
const existsIn = (...dirs: string[]) => (dir: string): boolean =>
  dirs.some(candidate => path.resolve(candidate) === path.resolve(dir))

describe('resolvePetDir', () => {
  test('显式配置优先于环境变量与同级目录', () => {
    const result = resolvePetDir({
      configured: 'D:/custom/pet',
      env: 'D:/env/pet',
      pluginDir: 'C:/repo/dsh-personal-assistant',
      exists: existsIn('D:/custom/pet', 'D:/env/pet', 'C:/repo/dsh-pet'),
    })
    assert.deepEqual(result, { dir: 'D:/custom/pet', source: 'config' })
  })

  test('没有配置时用 DSH_PET_DIR', () => {
    const result = resolvePetDir({
      env: 'D:/env/pet',
      pluginDir: 'C:/repo/dsh-personal-assistant',
      exists: existsIn('D:/env/pet', 'C:/repo/dsh-pet'),
    })
    assert.deepEqual(result, { dir: 'D:/env/pet', source: 'env' })
  })

  test('都没配时自动识别插件同级的 dsh-pet', () => {
    const sibling = path.resolve('C:/repo/dsh-personal-assistant', '..', 'dsh-pet')
    const result = resolvePetDir({
      pluginDir: 'C:/repo/dsh-personal-assistant',
      exists: existsIn('C:/repo/dsh-pet'),
    })
    assert.equal(result.dir, sibling)
    assert.equal(result.source, 'sibling')
  })

  test('配置了但目录不存在：如实报告 missing，不悄悄改用其它来源', () => {
    const result = resolvePetDir({
      configured: 'D:/gone/pet',
      pluginDir: 'C:/repo/dsh-personal-assistant',
      exists: existsIn('C:/repo/dsh-pet'),
    })
    assert.equal(result.dir, null)
    assert.equal(result.source, 'config')
    assert.equal(result.missing, 'D:/gone/pet')
  })

  test('环境变量指向不存在的目录同样如实报告', () => {
    const result = resolvePetDir({
      env: 'D:/gone/pet',
      pluginDir: 'C:/repo/dsh-personal-assistant',
      exists: existsIn('C:/repo/dsh-pet'),
    })
    assert.equal(result.dir, null)
    assert.equal(result.source, 'env')
    assert.equal(result.missing, 'D:/gone/pet')
  })

  test('什么都没有时返回 null，交给界面提示手动启动', () => {
    const result = resolvePetDir({
      pluginDir: 'C:/repo/dsh-personal-assistant',
      exists: () => false,
    })
    assert.deepEqual(result, { dir: null, source: null })
  })

  test('空白配置按「没配」处理', () => {
    const result = resolvePetDir({
      configured: '   ',
      env: '  ',
      pluginDir: 'C:/repo/dsh-personal-assistant',
      exists: existsIn('C:/repo/dsh-pet'),
    })
    assert.equal(result.source, 'sibling')
    assert.equal(result.dir, path.resolve('C:/repo/dsh-personal-assistant', '..', 'dsh-pet'))
  })
})
