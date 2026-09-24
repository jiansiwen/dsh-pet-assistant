"""从彩色熊猫图生成 macOS 托盘用的 Template Image。

macOS 的托盘图标要「Template Image」：系统把它当单色蒙版，跟随浅色/深色菜单栏自动反色。
彩色 PNG 在深色菜单栏上会是一块不协调的亮斑。规则（Electron 官方文档）：

  - 文件名必须以 `Template` 结尾（`pandaTemplate.png`）
  - 需要 16×16（@1x，72dpi）+ 32×32（@2x，144dpi），且**两个文件同名**（靠 @2x 后缀区分）
  - 只需要 alpha 通道的形状，颜色由系统决定 → 这里统一涂成黑色 + 保留原 alpha

本脚本只读不删：已存在的目标会被覆盖，源文件不动。
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow：python -m pip install Pillow", file=sys.stderr)
    raise SystemExit(2)

# 本文件在 dsh-pet/tools/ 下：parents[0] = tools，parents[1] = dsh-pet（项目根）。
ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "pets" / "panda.png"
OUT_DIR = ROOT / "assets" / "tray"


def silhouette(img: Image.Image, size: int) -> Image.Image:
    """把彩色图压成「黑色 + 原 alpha」的蒙版，并缩到目标边长。"""
    rgba = img.convert("RGBA")
    # 先缩放再取 alpha：直接缩小原图能让边缘抗锯齿更自然（alpha 也是插值出来的）。
    resized = rgba.resize((size, size), Image.LANCZOS)
    alpha = resized.getchannel("A")
    # 全黑 + 原 alpha。系统会按菜单栏主题给这个形状上色。
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.putalpha(alpha)
    return out


def main() -> int:
    if not SRC.exists():
        print(f"找不到源图：{SRC}", file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img = Image.open(SRC)
    print(f"源图 {SRC.name}: {img.size} {img.mode}")

    targets = [
        (OUT_DIR / "pandaTemplate.png", 16),
        (OUT_DIR / "pandaTemplate@2x.png", 32),
    ]
    for path, size in targets:
        silhouette(img, size).save(path)
        print(f"写出 {path.relative_to(ROOT)}  {size}x{size}")

    # 顺带核对 alpha 真的留下了内容：全透明或全不透明都说明取 alpha 那步错了。
    for path, _ in targets:
        with Image.open(path) as check:
            a = check.getchannel("A")
            lo, hi = a.getextrema()
            total = check.size[0] * check.size[1]
            opaque = sum(1 for v in a.tobytes() if v > 8)
            print(f"  {path.name}: alpha 范围 {lo}~{hi}，不透明像素 {opaque}/{total} ({opaque * 100 // total}%)")
            if opaque == 0:
                print("  ⚠️ 全透明 —— 取 alpha 那步有问题，托盘上会看不见", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
