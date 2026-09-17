/**
 * 文档页投影的测试。
 *
 * 这一页上每一个字符串都是用户要照着做决定的：候选列表里的体积和时间是他挑哪一份的依据，
 * 进度那句话是他判断"还要听多久"的依据，缩短后的目录是他确认"我授权的是哪个盘"的依据。
 * 说错了不崩溃，只是界面在撒谎 —— 所以钉在这里，不靠开壳用眼睛看。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formatDate, formatSize, progressLabel, sectionLabel, shortenDir } from '../src/renderer/doc-panel.ts'

describe('formatSize', () => {
  it('按 1024 进制标 B/KB/MB', () => {
    assert.equal(formatSize(0), '0B')
    assert.equal(formatSize(1023), '1023B')
    assert.equal(formatSize(1024), '1KB')
    assert.equal(formatSize(1024 * 1024), '1.0MB')
    assert.equal(formatSize(1536 * 1024), '1.5MB')
  })

  it('解析上限那一份报成 8.0MB —— 主进程的拒绝理由也用这个数，两处得对得上', () => {
    assert.equal(formatSize(8 * 1024 * 1024), '8.0MB')
  })

  it('拿不到体积时说"未知"，不说 0B', () => {
    // 0B 会被读成"这是个空文件"，跟"我没读到"是两件事。
    assert.equal(formatSize(-1), '体积未知')
    assert.equal(formatSize(Number.NaN), '体积未知')
    assert.equal(formatSize(Number.POSITIVE_INFINITY), '体积未知')
  })
})

describe('formatDate', () => {
  it('给到分钟，月和日补零', () => {
    // 用本地分量构造，不用时间戳字面量：换一个时区跑这条测试也不该失败。
    assert.equal(formatDate(new Date(2026, 2, 5, 9, 7).getTime()), '2026-03-05 09:07')
  })

  it('拿不到时间时说"未知"，不说 1970', () => {
    // 0 会被画成 1970-01-01，用户会以为这份文档比他还老。
    assert.equal(formatDate(0), '时间未知')
    assert.equal(formatDate(-1), '时间未知')
    assert.equal(formatDate(Number.NaN), '时间未知')
  })
})

describe('sectionLabel', () => {
  it('有标题就用标题', () => {
    assert.equal(sectionLabel('授权与边界', 0), '授权与边界')
  })

  it('没有标题的段报段号，段号从 1 数', () => {
    // 纯文本和 Markdown 的开头都没有标题，可提纲上不能留一行空白。
    assert.equal(sectionLabel(null, 0), '第 1 段')
    assert.equal(sectionLabel('', 2), '第 3 段')
    assert.equal(sectionLabel('   ', 11), '第 12 段')
  })
})

describe('progressLabel', () => {
  it('没有可讲的段落时直说，不报"共 0 段"', () => {
    assert.equal(progressLabel(0, 0, 0), '这份文档没有可讲的段落')
  })

  it('一段没讲时报整份的范围', () => {
    // 这是 §2.10 要的"先给估计范围再逐段讲"在面板上的那一份。
    assert.equal(progressLabel(0, 12, 6), '共 12 段，全部讲完大约 6 分钟')
  })

  it('讲到中间时报已讲、下一段和剩下的时长', () => {
    assert.equal(progressLabel(3, 12, 6), '已讲 3/12 段，接下来第 4 段，剩下约 5 分钟')
  })

  it('讲完了和没开始是两句话', () => {
    // next 是"下一段要讲的下标"：没开始时是 0，讲完时等于段数。只摆数字用户分不清站在哪一头。
    assert.equal(progressLabel(12, 12, 6), '共 12 段，已经讲完')
    assert.notEqual(progressLabel(12, 12, 6), progressLabel(0, 12, 6))
  })

  it('剩下不到一分钟也报一分钟，不报 0', () => {
    // "剩下约 0 分钟"读起来像卡住了。
    assert.equal(progressLabel(11, 12, 1), '已讲 11/12 段，接下来第 12 段，剩下约 1 分钟')
  })

  it('段号越界时按讲完了算，不报负的剩余时长', () => {
    assert.equal(progressLabel(20, 12, 6), '共 12 段，已经讲完')
    assert.equal(progressLabel(-3, 12, 6), '共 12 段，全部讲完大约 6 分钟')
  })
})

describe('shortenDir', () => {
  it('短路径原样显示', () => {
    assert.equal(shortenDir('D:\\docs'), 'D:\\docs')
    assert.equal(shortenDir('/home/me/docs'), '/home/me/docs')
  })

  it('先剥掉尾部的分隔符', () => {
    // 原生目录框给回来的路径带不带尾分隔符都有可能，不剥的话两条一样的目录会长得不一样。
    assert.equal(shortenDir('D:\\docs\\'), 'D:\\docs')
    assert.equal(shortenDir('/home/me/docs//'), '/home/me/docs')
  })

  it('长路径留头留尾、中间省略，结果不超过预算', () => {
    const shown = shortenDir('D:\\very\\long\\nested\\folder\\name\\that\\keeps\\going\\docs')
    assert.ok(shown.length <= 34, `缩短后是 ${shown.length} 字，超了预算`)
    assert.ok(shown.startsWith('D:\\'), `头没留住：${shown}`)
    assert.ok(shown.endsWith('\\docs'), `尾没留住：${shown}`)
    assert.ok(shown.includes('…'), `没有省略号：${shown}`)
  })

  it('不同盘的同名目录缩短之后仍然分得开', () => {
    // 只留尾巴的话这两条在列表里长得一模一样，用户撤销授权就会撤错一个。
    const tail = `${'x'.repeat(40)}\\docs`
    const onD = shortenDir(`D:\\${tail}`)
    const onE = shortenDir(`E:\\${tail}`)
    assert.notEqual(onD, onE)
    assert.ok(onD.startsWith('D:'), onD)
    assert.ok(onE.startsWith('E:'), onE)
  })

  it('任何预算下都不会比原路径更长', () => {
    // slice(-0) 等于 slice(0)，预算小到放不下尾巴时整个路径都会被接回来，越缩越长。
    for (const max of [4, 5, 6, 10, 34]) {
      const dir = 'D:\\some\\deeply\\nested\\directory'
      assert.ok(shortenDir(dir, max).length <= dir.length, `max=${max} 时反而变长了`)
    }
  })
})
