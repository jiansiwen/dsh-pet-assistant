#!/usr/bin/env bash
#
# 下载并安装本地语音识别模型（离线听写用）。macOS / Linux 版。
#
# 与 Windows 的 `setup-local-asr.ps1` 的关键差别：**这里不下载任何可执行文件**。
#
# 旧实现（Windows）会拉一份 `sherpa-onnx-offline.exe` 来跑识别；macOS 上没有这个 `.exe`，
# 所以那一版脚本在 Mac 上永远装不成。而识别本身早就改成了**进程内解码**
# （`src/main/asr.ts` 调 sherpa-onnx-node 的 Node API），需要的只是**模型文件**——
# `.onnx` 与 `tokens.txt` 是纯数据，三个平台完全一样。
#
# 所以这个脚本只干一件事：把模型放到对的位置。
# 原生模块由 `pnpm install` 按平台装好（`sherpa-onnx-darwin-arm64` 等 optionalDependencies）。
#
# 用法：
#   bash scripts/setup-local-asr.sh                    # 装到默认位置
#   DSH_ASR_DEST=/some/path bash scripts/setup-local-asr.sh
#   MIRROR=https://gh-proxy.com/ bash scripts/setup-local-asr.sh   # GitHub 直连不通时
#
# 重复运行安全：已完成的文件会跳过。

set -euo pipefail

DEST="${DSH_ASR_DEST:-$HOME/Library/Application Support/dsh-pet/local-asr}"
# Linux 上没有 Library/Application Support —— Electron 的 userData 在那里是 ~/.config。
if [ "$(uname -s)" != "Darwin" ]; then
  DEST="${DSH_ASR_DEST:-${XDG_CONFIG_HOME:-$HOME/.config}/dsh-pet/local-asr}"
fi
MIRROR="${MIRROR:-}"

SHERPA_VER="v1.13.7"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2"
STREAM_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2"

if [ -n "$MIRROR" ]; then
  MODEL_URL="${MIRROR%/}/$MODEL_URL"
  STREAM_URL="${MIRROR%/}/$STREAM_URL"
fi

MODEL_DIR="$DEST/model"
STREAM_DIR="$DEST/streaming"

echo "安装位置：$DEST"

# 两个模型齐了就直接退出（与 Windows 版同样的幂等语义）。
if [ -f "$MODEL_DIR/model.int8.onnx" ] && [ -f "$MODEL_DIR/tokens.txt" ] \
   && [ -f "$STREAM_DIR/encoder.int8.onnx" ] && [ -f "$STREAM_DIR/joiner.int8.onnx" ]; then
  echo "已经装好了，无需重复下载。"
  exit 0
fi

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少 $tool，请先安装它" >&2; exit 1; }
done

mkdir -p "$MODEL_DIR" "$STREAM_DIR"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-asr-setup-XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

fetch() {
  local url="$1" out="$2"
  if [ -f "$out" ]; then
    echo "已有，跳过：$out"
    return
  fi
  echo "下载 $url"
  # --fail 让 HTTP 错误码变成非零退出：否则 curl 会把一段 HTML 错误页存成 .tar.bz2，
  # 后面 tar 报"不是 bz2 文件"，而真正的原因（404 / 被墙）已经看不到了。
  curl -L --fail --retry 3 -o "$out" "$url" || {
    echo "下载失败：$url" >&2
    echo "GitHub 直连不通时试试：MIRROR=https://gh-proxy.com/ bash $0" >&2
    exit 1
  }
}

# ── SenseVoice（整句识别，说完整句再转）──
if [ ! -f "$MODEL_DIR/model.int8.onnx" ] || [ ! -f "$MODEL_DIR/tokens.txt" ]; then
  PACK="$TMP/model.tar.bz2"
  fetch "$MODEL_URL" "$PACK"
  echo "解压 SenseVoice 模型（比较大，请稍等）..."
  tar -xjf "$PACK" -C "$TMP"
  ONNX="$(find "$TMP" -name 'model.int8.onnx' -type f | head -1)"
  TOKENS="$(find "$TMP" -name 'tokens.txt' -type f | head -1)"
  [ -n "$ONNX" ] || { echo "压缩包里没找到 model.int8.onnx" >&2; exit 1; }
  [ -n "$TOKENS" ] || { echo "压缩包里没找到 tokens.txt" >&2; exit 1; }
  cp "$ONNX" "$MODEL_DIR/model.int8.onnx"
  cp "$TOKENS" "$MODEL_DIR/tokens.txt"
fi

# ── 流式 Zipformer（边说边出字）──
if [ ! -f "$STREAM_DIR/encoder.int8.onnx" ] || [ ! -f "$STREAM_DIR/decoder.int8.onnx" ] \
   || [ ! -f "$STREAM_DIR/joiner.int8.onnx" ] || [ ! -f "$STREAM_DIR/tokens.txt" ]; then
  PACK="$TMP/streaming.tar.bz2"
  fetch "$STREAM_URL" "$PACK"
  echo "解压流式模型..."
  tar -xjf "$PACK" -C "$TMP"
  for name in encoder decoder joiner; do
    SRC="$(find "$TMP" -name "$name-epoch-99-avg-1.int8.onnx" -type f | head -1)"
    [ -n "$SRC" ] || { echo "压缩包里没找到 $name 模型" >&2; exit 1; }
    cp "$SRC" "$STREAM_DIR/$name.int8.onnx"
  done
  STREAM_TOKENS="$(find "$TMP" -path '*streaming*' -name 'tokens.txt' -type f | head -1)"
  [ -n "$STREAM_TOKENS" ] || STREAM_TOKENS="$(find "$TMP" -name 'tokens.txt' -type f | head -1)"
  [ -n "$STREAM_TOKENS" ] || { echo "压缩包里没找到流式 tokens.txt" >&2; exit 1; }
  cp "$STREAM_TOKENS" "$STREAM_DIR/tokens.txt"
fi

# ── 收尾核对：报告实际落盘的文件，而不是只说"完成" ──
echo
echo "装好了：$DEST"
find "$DEST" -type f | sort | while read -r f; do
  printf '  %s  %s\n' "$(du -h "$f" | cut -f1)" "${f#"$DEST"/}"
done
echo
echo "重启桌面宠物后生效（听写与唤醒都将完全离线）。"
