#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
同步 assets/pets → dist/assets/pets，并处理「多余帧」。

⚠️ 本脚本**不删除任何文件**。多余帧改名为 `fNNN.png.stale` ——
   引擎按 `fNNN.png` 精确探测，改名后就探不到，等价于清掉，
   但文件还在，随时可改回来。

为什么需要：动作素材是逐帧探测的（FRAME_MAX = 96，遇到第一个缺失才停）。
旧素材多出来的尾巴会让引擎多探到几十帧，播起来是「先播新版、再播旧版」。

用法：
  python sync-frames.py --dry    只看会做什么
  python sync-frames.py          执行
"""
import os, io, re, shutil, argparse, time

PET = r"D:\work\dsh-pet"
A = os.path.join(PET, "assets", "pets")
D = os.path.join(PET, "dist", "assets", "pets")
RES = os.path.join(PET, "_sync.txt")

ap = argparse.ArgumentParser()
ap.add_argument("--dry", action="store_true")
ARGS = ap.parse_args()

_log = []


def say(m=""):
    _log.append(str(m))
    print(m)


def mb(n):
    if n >= 1048576:
        return "%.1f MB" % (n / 1048576.0)
    return "%.0f KB" % (n / 1024.0)


def nframes(d):
    if not os.path.isdir(d):
        return []
    return sorted(int(re.match(r"^f(\d+)\.png$", f).group(1))
                  for f in os.listdir(d) if re.match(r"^f\d+\.png$", f))


say("=" * 80)
say("同步 assets → dist   %s" % ("【预演】" if ARGS.dry else "【执行】"))
say("=" * 80)

if not os.path.isdir(D):
    say("dist/assets/pets 不存在 —— 请先跑一次 node scripts/build.mjs")
    raise SystemExit(0)

# ─── ① 静态图 ───
say()
say("① 静态皮肤图（拷贝覆盖）")
say("-" * 80)
n_static = 0
for f in sorted(os.listdir(A)):
    p = os.path.join(A, f)
    if not (os.path.isfile(p) and f.lower().endswith(".png")):
        continue
    q = os.path.join(D, f)
    if ARGS.dry:
        say("   会拷 %s" % f)
    else:
        shutil.copy2(p, q)
    n_static += 1
say("   共 %d 张" % n_static)

# ─── ② 动作帧 ───
say()
say("② 动作序列帧（拷贝 + 多余帧改名）")
say("-" * 80)
say("%-13s %8s %8s %8s %s" % ("动作", "assets", "dist前", "dist后", "处理"))
say("-" * 80)

n_copied = 0
n_stale = 0
report = []
A_FR = os.path.join(A, "frames", "panda")
D_FR = os.path.join(D, "frames", "panda")
if not os.path.isdir(A_FR):
    say("assets 下没有 frames/panda")
else:
    for act in sorted(os.listdir(A_FR)):
        sa = os.path.join(A_FR, act)
        if not os.path.isdir(sa):
            continue
        sd = os.path.join(D_FR, act)
        na = nframes(sa)
        nd_before = nframes(sd)
        if not na:
            continue
        os.makedirs(sd, exist_ok=True)
        # 拷贝（覆盖）
        for f in sorted(os.listdir(sa)):
            if f.lower().endswith(".png"):
                if not ARGS.dry:
                    shutil.copy2(os.path.join(sa, f), os.path.join(sd, f))
                n_copied += 1
        # 多余帧改名
        top = max(na)
        stale = []
        for f in sorted(os.listdir(sd)):
            m = re.match(r"^f(\d+)\.png$", f)
            if m and int(m.group(1)) > top:
                if not ARGS.dry:
                    os.rename(os.path.join(sd, f), os.path.join(sd, f + ".stale"))
                stale.append(f)
                n_stale += 1
        nd_after = nframes(sd)
        note = "%d 帧" % len(na)
        if stale:
            note += "，多余 %d 个已改名 .stale（编号 >%d）" % (len(stale), top)
        report.append((act, len(na), len(nd_before), len(nd_after), note))

    for act, ca, cb, cc, note in report:
        flag = "✅" if cb == cc else "⚠️"
        say("%-13s %8d %8d %8d %s %s" % (act, ca, cb, cc, flag, note))

say()
say("   拷贝 %d 个帧文件，改名 %d 个多余帧" % (n_copied, n_stale))

# ─── ③ 复核 ───
say()
say("③ 复核：dist 与 assets 帧数是否一致")
say("-" * 80)
bad = []
for act in sorted(os.listdir(A_FR)):
    sa = os.path.join(A_FR, act)
    if not os.path.isdir(sa):
        continue
    na = len(nframes(sa))
    nd = len(nframes(os.path.join(D_FR, act)))
    if na != nd:
        bad.append((act, na, nd))
if bad:
    say("   ⚠️ 仍不一致：")
    for act, na, nd in bad:
        say("      %-13s assets %d  dist %d" % (act, na, nd))
else:
    say("   ✅ 全部一致")

# ─── ④ 残留的 .stale ───
say()
say("④ 已改名的 .stale 文件（未删除，可随时改回）")
say("-" * 80)
total = 0
cnt = 0
for r, ds, fs in os.walk(D_FR):
    for f in fs:
        if f.endswith(".stale"):
            cnt += 1
            try:
                total += os.path.getsize(os.path.join(r, f))
            except OSError:
                pass
say("   共 %d 个，%s（位于 dist/assets/pets/frames/panda/<动作>/）" % (cnt, mb(total)))

with io.open(RES, "w", encoding="utf-8") as f:
    f.write("\n".join(_log) + "\n")
