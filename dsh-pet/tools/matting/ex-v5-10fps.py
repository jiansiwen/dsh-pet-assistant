#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从 grab-v5 按 **10fps** 抽帧（引擎的播放帧率），供拆分。

⚠️ 引擎统一按 10fps 播放帧序列（`usePetImage.ts`:
   "提高到 96 后可容纳 9.6 秒 @10fps"）。
   若用 24fps 原生帧直接装机，动作会被放慢 2.4 倍。
"""
import os, subprocess

FF = (r"D:\work\dsh-pet\tools\matting\node_modules\.pnpm"
      r"\ffmpeg-static@5.3.0\node_modules\ffmpeg-static\ffmpeg.exe")
C = r"D:\work\dsh-pet\assets\pets\_clips\raw"
src = os.path.join(C, "panda-grab-v5.mp4")
d = os.path.join(C, "_v5g10")
os.makedirs(d, exist_ok=True)
for f in os.listdir(d):
    if f.endswith(".png"):
        os.remove(os.path.join(d, f))
subprocess.run([FF, "-y", "-i", src, "-vf", "fps=10,scale=760:-2", "-vsync", "0",
                os.path.join(d, "f%04d.png")], capture_output=True)
n = len([f for f in os.listdir(d) if f.endswith(".png")])
print("10fps frames:", n, "=> %.2f s" % (n / 10.0))
