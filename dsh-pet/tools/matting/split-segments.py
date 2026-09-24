#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
通用「从一条长视频里裁多段并装机」工具。

与 split-laptop.py 的差别：本工具支持**段内循环点搜索**，
用于把"挣扎/敲代码"这类周期性段落裁成可无缝循环的素材。

锚定模式：
  · fixed  全局统一缩放+偏移（保留段内垂直位移）—— 适合挣扎/跳跃
  · bottom 每帧按自身高度缩放到目标高 + 脚底对齐 —— 适合脚不离地的动作
  · ground 统一缩放 + 每帧底边对齐落地线 —— **适合坐/站高度不同的动作**
           （统一偏移在这种动作上必然有一端出画）
  · fit    把整段垂直范围装进画布 —— 适合有大落差的一次性动画（掉落）

循环点搜索会**排除"段内几乎静止"的候选** —— 否则最相似的两帧往往来自静止段，
选出来的"循环"其实是一张不动的图。

用法：
  python split-segments.py --dir <帧目录> \
      --seg "grab:16-101:loop:fixed:440" \
      --seg "drop:100-192:once:fit:0"
  段格式： 名字:起-止[:loop|once][:fixed|bottom|fit][:目标高]
"""
import os, io, re, sys, shutil, argparse, time
import numpy as np
from PIL import Image

PET = r"D:\work\dsh-pet\assets\pets"
FRAMES = os.path.join(PET, "frames", "panda")
CANVAS = 512
BOTTOM = CANVAS - 1
BG = np.array([36, 107, 219], dtype=np.int16)
LO, HI = 60, 120
ERODE = 2

from PIL import ImageFilter  # noqa: E402


def robust_copy(src, dst, tries=8):
    last = None
    for k in range(tries):
        try:
            shutil.copy2(src, dst)
            return
        except OSError as e:
            last = e
            time.sleep(0.25 * (k + 1))
    tmp = dst + ".tmp"
    shutil.copy2(src, tmp)
    if os.path.exists(dst):
        os.remove(dst)
    os.replace(tmp, dst)


def key(path):
    arr = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    diff = np.abs(arr - BG).max(axis=2)
    a = np.clip((diff - LO) * 255.0 / (HI - LO), 0, 255).astype(np.uint8)
    a = np.asarray(Image.fromarray(a, "L").filter(ImageFilter.MinFilter(ERODE * 2 + 1)))
    rgb = arr.astype(np.float32)
    mx = np.maximum(rgb[:, :, 0], rgb[:, :, 1])
    over = rgb[:, :, 2] - mx
    m = over > 0
    rgb[:, :, 2][m] = (mx[m] - over[m])
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, a]), "RGBA")


def bbox(im):
    b = im.split()[-1].getbbox()
    return b


def main():
    global CANVAS, BOTTOM, PADX
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="已抠像的帧目录（f####.png）")
    ap.add_argument("--seg", action="append", required=True, help="段规格")
    ap.add_argument("--install", action="store_true")
    ap.add_argument("--outroot", default="", help="输出根目录（默认源目录同级）")
    ap.add_argument("--fps", type=float, default=10.0,
                    help="输入帧序列的帧率（引擎按 10fps 播放，默认 10）。"
                         "只影响日志里的时长换算，不影响装机结果")
    ap.add_argument("--global-align", action="store_true",
                    help="所有段共用同一裁切框 / 缩放 / 偏移。"
                         "从一条长视频裁多个动作时必须开 —— 否则每段各自归一化，"
                         "角色在不同动作之间会一大一小")
    ap.add_argument("--global-ref", type=int, default=1,
                    help="全局参考帧号(1基)，用它的高度定全局缩放。默认第 1 帧")
    ap.add_argument("--global-h", type=float, default=505,
                    help="全局参考帧的目标高度（默认 505 = 站立满高）")
    ap.add_argument("--canvas", type=int, default=512, help="透明画布边长")
    ap.add_argument("--pad-x", type=int, default=0,
                    help="左右各加多少透明像素；横躺等宽姿势用它容纳，避免为塞进方形画布而缩小角色")
    args = ap.parse_args()
    if args.canvas < 512 or args.canvas > 2048:
        ap.error("画布边长必须在 512–2048 之间")
    if args.pad_x < 0 or args.pad_x > 512:
        ap.error("侧边距必须在 0–512 之间")
    CANVAS = args.canvas
    BOTTOM = CANVAS - 1
    PADX = args.pad_x

    WORK = args.outroot or os.path.join(os.path.dirname(args.dir.rstrip("\\/")), "_seg")
    os.makedirs(WORK, exist_ok=True)
    LOG = os.path.join(WORK, "_log.txt")
    _log = []

    def say(m):
        _log.append(str(m))
        with io.open(LOG, "w", encoding="utf-8") as f:
            f.write("\n".join(_log) + "\n")

    try:
        fs = sorted(f for f in os.listdir(args.dir) if re.match(r"^f\d+\.png$", f))
        if not fs:
            raise SystemExit("目录里没有 f####.png")
        say("源 %d 帧：%s" % (len(fs), args.dir))

        # 一次性抠像 + 缓存
        keyed = [key(os.path.join(args.dir, f)) for f in fs]
        say("已抠像 %d 帧" % len(keyed))

        # 全局对齐：所有段共用同一裁切框 / 缩放 / 偏移
        G = None
        if args.global_align:
            gmnx = gmny = 10 ** 9
            gmxx = gmxy = -1
            for im in keyed:
                b = bbox(im)
                if b:
                    gmnx = min(gmnx, b[0]); gmny = min(gmny, b[1])
                    gmxx = max(gmxx, b[2]); gmxy = max(gmxy, b[3])
            gbox = (max(0, gmnx - 2), max(0, gmny - 2), gmxx + 3, gmxy + 3)
            gref = keyed[min(args.global_ref - 1, len(keyed) - 1)].crop(gbox)
            grb = bbox(gref)
            gs = args.global_h / float(grb[3] - grb[1] + 1)
            gcx = (grb[0] + grb[2]) / 2.0
            gpx = int(round(CANVAS / 2.0 - gcx * gs))
            gpy = int(round(BOTTOM - grb[3] * gs))
            G = (gbox, gs, gpx, gpy)
            say("")
            say("★ 全局对齐开启")
            say("  并集裁切框 %dx%d（覆盖全部帧）" % (gbox[2] - gbox[0], gbox[3] - gbox[1]))
            say("  参考帧 #%d 高 %d → 目标 %.0f px → 缩放 %.4f" % (
                args.global_ref, grb[3] - grb[1] + 1, args.global_h, gs))
            say("  统一偏移 (%d, %d)" % (gpx, gpy))
            say("  → 各段角色大小一致，跨动作切换不会一大一小")

        for spec in args.seg:
            parts = spec.split(":")
            name = parts[0]
            rng = parts[1]
            mode = parts[2] if len(parts) > 2 else "once"
            anchor = parts[3] if len(parts) > 3 else "fixed"
            target_h = int(parts[4]) if len(parts) > 4 and parts[4] else 440

            a0, a1 = [int(x) for x in rng.split("-")]
            a0 = max(0, a0 - 1)
            a1 = min(len(fs) - 1, a1 - 1)
            seg = keyed[a0:a1 + 1]
            n = len(seg)
            say("")
            say("═══ [%s] f%03d~f%03d（%d 帧 / %.2f 秒 @%.0ffps）mode=%s anchor=%s" % (
                name, a0 + 1, a1 + 1, n, n / args.fps, args.fps, mode, anchor))

            # 全局对齐时跳过段内独立归一化
            if G:
                box = G[0]
                gs = G[1]
                uw, uh = box[2] - box[0], box[3] - box[1]
                tw = max(1, int(round(uw * gs)))
                th = max(1, int(round(uh * gs)))
                if anchor == "ground":
                    # 统一缩放 + 每帧底边对齐落地线。
                    # 用于"坐着/站着高度不同"的动作：坐着时屁股贴地、站起时脚贴地。
                    # 统一偏移在这种动作上必然有一端出画，所以不能用。
                    places = []
                    for im in seg:
                        c = im.crop(box).resize((tw, th), Image.LANCZOS)
                        b = bbox(c)
                        if not b:
                            places.append((c, 0, 0)); continue
                        px = int(round(CANVAS / 2.0 - (b[0] + b[2]) / 2.0))
                        py = int(round(BOTTOM - b[3]))
                        places.append((c, px, py))
                    say("  全局+ground：裁切 %dx%d，缩放 %.4f，每帧底边对齐落地线" % (
                        uw, uh, gs))
                else:
                    s, px, py = gs, G[2], G[3]
                    places = [(im.crop(box).resize((tw, th), Image.LANCZOS), px, py)
                              for im in seg]
                    say("  全局参数：裁切 %dx%d，缩放 %.4f，偏移 (%d, %d)" % (
                        uw, uh, s, px, py))
            else:
                # 统一裁切框（该段共用）
                mnx = mny = 10 ** 9
                mxx = mxy = -1
                for im in seg:
                    b = bbox(im)
                    if b:
                        mnx = min(mnx, b[0]); mny = min(mny, b[1])
                        mxx = max(mxx, b[2]); mxy = max(mxy, b[3])
                box = (max(0, mnx - 2), max(0, mny - 2), mxx + 3, mxy + 3)
                uw, uh = box[2] - box[0], box[3] - box[1]
                say("  统一裁切 %dx%d" % (uw, uh))

            if G:
                pass
            elif anchor == "bottom":
                hs = [bbox(im.crop(box)) for im in seg]
                hs = [b[3] - b[1] + 1 for b in hs if b]
                med = int(np.median(hs)) if hs else 400
                s = target_h / float(med)
                places = []
                for im in seg:
                    c = im.crop(box)
                    b = bbox(c)
                    if not b:
                        places.append((c, 0, 0)); continue
                    tw = max(1, int(round((b[2] - b[0] + 1) * s)))
                    th = max(1, int(round((b[3] - b[1] + 1) * s)))
                    sub = c.crop((b[0], b[1], b[2] + 1, b[3] + 1)).resize((tw, th), Image.LANCZOS)
                    places.append((sub, (CANVAS - tw) // 2, max(0, BOTTOM - th + 1)))
                say("  bottom：各帧高中位 %d → 缩放 %.4f" % (med, s))

            elif anchor == "fit":
                ctop = 10 ** 9; cbot = -1
                for im in seg:
                    b = bbox(im.crop(box))
                    if b:
                        ctop = min(ctop, b[1]); cbot = max(cbot, b[3])
                span = cbot - ctop + 1
                MARGIN = 0.05
                avail = CANVAS * (1 - MARGIN * 2)
                s = avail / float(span)
                ref = seg[0].crop(box); rb = bbox(ref)
                ref_cx = (rb[0] + rb[2]) / 2.0
                top_y = (CANVAS - span * s) / 2.0
                px = int(round(CANVAS / 2.0 - ref_cx * s))
                py = int(round(top_y - ctop * s))
                tw = max(1, int(round(uw * s))); th = max(1, int(round(uh * s)))
                places = [(im.crop(box).resize((tw, th), Image.LANCZOS), px, py) for im in seg]
                say("  fit：纵向跨度 %d → 缩放 %.4f，偏移 (%d, %d)" % (span, s, px, py))

            else:  # fixed
                ref = seg[0].crop(box); rb = bbox(ref)
                s = target_h / float(rb[3] - rb[1] + 1)
                ref_cx = (rb[0] + rb[2]) / 2.0
                px = int(round(CANVAS / 2.0 - ref_cx * s))
                py = int(round(BOTTOM - rb[3] * s))
                tw = max(1, int(round(uw * s))); th = max(1, int(round(uh * s)))
                places = [(im.crop(box).resize((tw, th), Image.LANCZOS), px, py) for im in seg]
                say("  fixed：参考帧高 %d → 缩放 %.4f，偏移 (%d, %d)" % (
                    rb[3] - rb[1] + 1, s, px, py))

            # 渲染到临时序列
            tmp = os.path.join(WORK, "%s_pre" % name)
            os.makedirs(tmp, exist_ok=True)
            for f in os.listdir(tmp):
                if f.endswith(".png"):
                    os.remove(os.path.join(tmp, f))
            for i, (img, px, py) in enumerate(places, 1):
                # 横躺等宽姿势靠透明侧边距容纳，而不是缩小角色 —— 缩小会在动作切换时看出闪一下。
                cv = Image.new("RGBA", (CANVAS + 2 * PADX, CANVAS), (0, 0, 0, 0))
                cv.alpha_composite(img, (px + PADX, py))
                cv.save(os.path.join(tmp, "f%03d.png" % i))

            if mode == "loop":
                # 段内循环点搜索
                pre = sorted(f for f in os.listdir(tmp) if f.endswith(".png"))
                A = [np.asarray(Image.open(os.path.join(tmp, f)).convert("RGBA")).astype(np.int16)
                     for f in pre]
                S = [np.asarray(Image.open(os.path.join(tmp, f)).convert("RGBA")
                                .resize((128, 128), Image.LANCZOS)).astype(np.int16) for f in pre]
                m = len(A)
                minlen = max(8, int(m * 0.35))

                def psnr_of(i, j):
                    x, y = A[i], A[j]
                    vis = (x[:, :, 3] > 40) | (y[:, :, 3] > 40)
                    if not vis.any():
                        return 0.0, 0
                    d = np.abs(x[:, :, :3] - y[:, :, :3]).max(axis=2)
                    big = int(((d > 20) & vis).sum())
                    mse = float((d[vis] ** 2).mean())
                    return (10 * np.log10(255.0 ** 2 / mse) if mse > 0 else 999), big

                def sad(x, y):
                    return float(np.abs(x[:, :, :3] - y[:, :, :3]).mean()
                                 + np.abs(x[:, :, 3] - y[:, :, 3]).mean() * 1.2)

                # 段内逐帧动态强度 —— 用来排除"静止段"当循环
                dyns = []
                for _i in range(1, m):
                    _vis = (A[_i][:, :, 3] > 40) | (A[_i - 1][:, :, 3] > 40)
                    if _vis.any():
                        _d = np.abs(A[_i][:, :, :3] - A[_i - 1][:, :, :3]).max(axis=2)
                        dyns.append(float(((_d > 35) & _vis).sum()))
                    else:
                        dyns.append(0.0)
                dyn_ref = float(np.median(dyns)) if dyns else 0.0
                if dyn_ref > 0:
                    say("  段内动态强度中位 %.0f（低于 30%% 的候选会被跳过）" % dyn_ref)

                cands = []
                for i in range(m):
                    for j in range(i + minlen, m):
                        cands.append((sad(S[i], S[j]), i, j))
                cands.sort(key=lambda t: t[0])
                say("  循环点候选：")
                best = None
                for d, i, j in cands[:14]:
                    ps, big = psnr_of(i, j)
                    seg_dyn = float(np.mean(dyns[i:j])) if j > i and dyns else 0.0
                    if dyn_ref > 0 and seg_dyn < 0.30 * dyn_ref:
                        say("    f%03d→f%03d  %d 帧  PSNR %.2f  ✗跳过（段内几乎静止，动态 %.0f）" % (
                            i + 1, j + 1, j - i + 1, ps, seg_dyn))
                        continue
                    say("    f%03d→f%03d  %d 帧  PSNR %.2f  动态 %.0f" % (
                        i + 1, j + 1, j - i + 1, ps, seg_dyn))
                    if best is None or ps > best[0]:
                        best = (ps, i, j)
                if best is None:
                    # 全部被判为静止：退回动态最高的候选
                    cands2 = sorted(cands, key=lambda t: -float(np.mean(dyns[t[1]:t[2]] or [0])))
                    _, i, j = cands2[0]
                    ps, _b = psnr_of(i, j)
                    best = (ps, i, j)
                    say("    ⚠️ 无候选通过动态门槛，退回动态最高的 f%03d→f%03d" % (i + 1, j + 1))
                say("  ★ 最优 f%03d→f%03d，%d 帧，PSNR %.2f" % (
                    best[1] + 1, best[2] + 1, best[2] - best[1] + 1, best[0]))

                final = os.path.join(WORK, "%s_final" % name)
                os.makedirs(final, exist_ok=True)
                for f in os.listdir(final):
                    if f.endswith(".png"):
                        os.remove(os.path.join(final, f))
                for k in range(best[1], best[2] + 1):
                    robust_copy(os.path.join(tmp, pre[k]),
                                os.path.join(final, "f%03d.png" % (k - best[1] + 1)))
                use = best[2] - best[1] + 1
                say("  循环段 %d 帧（%.2f 秒 @%.0ffps）" % (
                    use, use / args.fps, args.fps))
            else:
                final = os.path.join(WORK, "%s_final" % name)
                os.makedirs(final, exist_ok=True)
                for f in os.listdir(final):
                    if f.endswith(".png"):
                        os.remove(os.path.join(final, f))
                for i, f in enumerate(sorted(x for x in os.listdir(tmp) if x.endswith(".png")), 1):
                    robust_copy(os.path.join(tmp, f), os.path.join(final, "f%03d.png" % i))
                use = n
                say("  一次性段 %d 帧（%.2f 秒 @%.0ffps）" % (use, use / args.fps, args.fps))

            # 复核
            ff = sorted(f for f in os.listdir(final) if f.endswith(".png"))
            ws, hh, bots, tops = [], [], [], []
            for f in ff:
                im = Image.open(os.path.join(final, f)).convert("RGBA")
                b = bbox(im)
                if b:
                    ws.append(b[2] - b[0] + 1); hh.append(b[3] - b[1] + 1)
                    bots.append(b[3]); tops.append(b[1])
            if ws:
                say("  复核：宽 %d~%d（%.1f%%）高 %d~%d（%.1f%%）底边 %d~%d 顶边 %d~%d" % (
                    min(ws), max(ws), 100.0 * (max(ws) - min(ws)) / min(ws),
                    min(hh), max(hh), 100.0 * (max(hh) - min(hh)) / min(hh),
                    min(bots), max(bots), min(tops), max(tops)))

            if args.install:
                dest = os.path.join(FRAMES, name)
                old = sorted(f for f in os.listdir(dest) if f.lower().endswith(".png")) \
                    if os.path.isdir(dest) else []
                if old:
                    ad = os.path.join(FRAMES, "_archived-%s-%s" % (
                        name, time.strftime("%m%d-%H%M%S")))
                    os.makedirs(ad, exist_ok=True)
                    for f in old:
                        robust_copy(os.path.join(dest, f), os.path.join(ad, f))
                    say("  归档旧素材 %d 帧 → %s" % (len(old), os.path.basename(ad)))
                    keep = len(ff)
                    for f in os.listdir(dest):
                        mm = re.match(r"^f(\d+)\.png$", f)
                        if mm and int(mm.group(1)) > keep:
                            os.remove(os.path.join(dest, f))
                os.makedirs(dest, exist_ok=True)
                for i, f in enumerate(ff, 1):
                    robust_copy(os.path.join(final, f), os.path.join(dest, "f%03d.png" % i))
                say("  ✅ 已装入 %d 帧 → frames/panda/%s" % (len(ff), name))
            else:
                say("  产物：%s（未装机）" % final)
    except SystemExit as e:
        say("中止: %s" % e)
    except Exception:
        import traceback
        say("异常:\n" + traceback.format_exc())

    print("\n".join(_log[-40:]))


if __name__ == "__main__":
    main()
