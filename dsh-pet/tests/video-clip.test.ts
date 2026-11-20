/**
 * 视频裁动作的钉子用例。
 *
 * 钉的是"别把素材问题伪装成程序成功"：
 * 1. 起止时间不合法就不该跑到 ffmpeg（跑进去只会产出空文件或卡住）；
 * 2. 滤镜顺序必须是**先裁、再抠、后缩放**（反了会让边缘插值污染抠像）；
 * 3. 失败必须给出人能照着做的提示，而不是一个红叉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractClip, MAX_CLIP_SECONDS, planClipArgs, validatePlan } from '../src/main/video-clip.ts'

void test('计划：起止时间不合法一律拒绝', () => {
  assert.equal(validatePlan({ from: 2, to: 1, matte: 'none' }).ok, false, '倒序')
  assert.equal(validatePlan({ from: 1, to: 1, matte: 'none' }).ok, false, '零长度')
  assert.equal(validatePlan({ from: 0, to: 0.05, matte: 'none' }).ok, false, '太短')
  assert.equal(validatePlan({ from: 0, to: MAX_CLIP_SECONDS + 1, matte: 'none' }).ok, false, '太长')
  assert.equal(validatePlan({ from: Number.NaN, to: 2, matte: 'none' }).ok, false, '非数字')
  assert.equal(validatePlan({ from: 0, to: 1, matte: 'chroma', size: 32 }).ok, false, '尺寸太小')
})

void test('计划：合法输入被归一（颜色统一成 0x 写法）', () => {
  const ok = validatePlan({ from: 1, to: 2.5, matte: 'chroma', keyColor: '#00FF00' })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.plan.keyColor, '0x00FF00')
    assert.equal(ok.plan.size, 320, '默认 320')
  }
})

void test('滤镜顺序：先裁、再抠、后缩放补边', () => {
  const args = planClipArgs('in.mp4', 'out.webm', { from: 1, to: 3, matte: 'background' })
  const vf = args[args.indexOf('-vf') + 1]
  const matteAt = vf.indexOf('backgroundkey')
  const scaleAt = vf.indexOf('scale=')
  assert.ok(matteAt >= 0, '应有抠像')
  assert.ok(scaleAt > matteAt, '抠像必须在缩放之前')
  // 裁剪走的是 -ss / -t 而不是 -vf 里的 trim，避免长视频整段解码
  assert.equal(args[args.indexOf('-ss') + 1], '1.000')
  assert.equal(args[args.indexOf('-t') + 1], '2.000')
})

void test('输出规格：透明 WebM + 24fps + 不要音轨', () => {
  const args = planClipArgs('in.mp4', 'out.webm', { from: 0, to: 1, matte: 'none' })
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-c:v') + 3), ['-c:v', 'libvpx-vp9', '-pix_fmt'])
  assert.ok(args.includes('yuva420p'), '必须是带 alpha 的像素格式')
  assert.ok(args.includes('-an'), '宠物动作不需要音轨')
  assert.ok(args[args.indexOf('-vf') + 1].includes('fps=24'), '与现有素材同帧率')
})

void test('执行：没有 ffmpeg 时如实说，而不是静默失败', async () => {
  const result = await extractClip({ ffmpeg: null, spawn: async () => ({ code: 0, stderr: '' }) }, 'in.mp4', 'out.webm', { from: 0, to: 1, matte: 'none' })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /ffmpeg/u)
  assert.ok((result.hint ?? '') !== '', '要给下一步怎么办')
})

void test('执行：文件不存在时不调用 ffmpeg', async () => {
  let called = 0
  const result = await extractClip({ ffmpeg: 'ffmpeg', spawn: async () => { called += 1; return { code: 0, stderr: '' } } },
    'definitely-not-here.mp4', 'out.webm', { from: 0, to: 1, matte: 'none' })
  assert.equal(result.ok, false)
  assert.equal(called, 0, '源文件都没有，不该白跑一次转码')
})

void test('执行：镜头在动导致抠坏时，提示要指向"换固定机位或绿幕"', async () => {
  const result = await extractClip({
    ffmpeg: 'ffmpeg',
    spawn: async () => ({ code: 1, stderr: 'Conversion failed!' }),
  }, new URL(import.meta.url).pathname.slice(1), 'out.webm', { from: 0, to: 1, matte: 'background' })
  // 用一个确实存在的文件路径（本测试文件自身）只是为了越过"文件不存在"这道闸
  assert.equal(result.ok, false)
  assert.match(result.hint ?? '', /镜头|绿幕/u)
})
