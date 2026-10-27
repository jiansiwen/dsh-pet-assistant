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
STREAM_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2"
# 会议按音色分人：pyannote 分段（MIT）+ 3D-Speaker 声纹嵌入（上游 Apache-2.0），本地推理，不上传音频。
SEG_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
EMB_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
# 本地唤醒（M1-02，macOS 唯一的本地唤醒方案）：sherpa-onnx 官方 kws-models 发布里的 WenetSpeech 中文 KWS 小模型
#（zipformer，约 3.3M 参数，建模单元为拼音声母 + 带调韵母），许可证 Apache-2.0（见模型 README）。
# 包大小 15,292,881 字节；sha256 取自该发布的 checksum.txt，解压前校验。
KWS_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile.tar.bz2"
KWS_SHA256="b812a043aef628a6915f89cb9a94e55f8e87e89ff904b516f822d7e0a3e6de2b"

if [ -n "$MIRROR" ]; then
  MODEL_URL="${MIRROR%/}/$MODEL_URL"
  STREAM_URL="${MIRROR%/}/$STREAM_URL"
  SEG_URL="${MIRROR%/}/$SEG_URL"
  EMB_URL="${MIRROR%/}/$EMB_URL"
  KWS_URL="${MIRROR%/}/$KWS_URL"
fi

MODEL_DIR="$DEST/model"
STREAM_DIR="$DEST/streaming-zh-14m"
DIAR_DIR="$DEST/diarization"
KWS_DIR="$DEST/kws"

echo "安装位置：$DEST"

# 三组模型齐了就直接退出（与 Windows 版同样的幂等语义）。
if [ -f "$MODEL_DIR/model.int8.onnx" ] && [ -f "$MODEL_DIR/tokens.txt" ] \
   && [ -f "$STREAM_DIR/encoder.int8.onnx" ] && [ -f "$STREAM_DIR/decoder.int8.onnx" ] \
   && [ -f "$STREAM_DIR/joiner.int8.onnx" ] && [ -f "$STREAM_DIR/tokens.txt" ] \
   && [ -f "$DIAR_DIR/segmentation.onnx" ] && [ -f "$DIAR_DIR/embedding.onnx" ]    && [ -f "$KWS_DIR/encoder.int8.onnx" ] && [ -f "$KWS_DIR/decoder.onnx" ]    && [ -f "$KWS_DIR/joiner.int8.onnx" ] && [ -f "$KWS_DIR/tokens.txt" ]; then
  echo "已经装好了，无需重复下载。"
  exit 0
fi

for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "缺少 $tool，请先安装它" >&2; exit 1; }
done

mkdir -p "$MODEL_DIR" "$STREAM_DIR" "$DIAR_DIR"

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
  STREAM_TOKENS="$(find "$TMP" -path '*zipformer-zh-14M*' -name 'tokens.txt' -type f | head -1)"
  [ -n "$STREAM_TOKENS" ] || STREAM_TOKENS="$(find "$TMP" -name 'tokens.txt' -type f | head -1)"
  [ -n "$STREAM_TOKENS" ] || { echo "压缩包里没找到流式 tokens.txt" >&2; exit 1; }
  cp "$STREAM_TOKENS" "$STREAM_DIR/tokens.txt"
fi

# ── 说话人分离（会议按音色分人）──
if [ ! -f "$DIAR_DIR/segmentation.onnx" ]; then
  PACK="$TMP/segmentation.tar.bz2"
  fetch "$SEG_URL" "$PACK"
  tar -xjf "$PACK" -C "$TMP"
  SEG="$(find "$TMP" -path '*pyannote-segmentation*' -name 'model.onnx' -type f | head -1)"
  [ -n "$SEG" ] || { echo "压缩包里没找到分段模型 model.onnx" >&2; exit 1; }
  LICENSE_FILE="$(find "$(dirname "$SEG")" -maxdepth 1 -name 'LICENSE*' -type f | head -1)"
  [ -z "$LICENSE_FILE" ] || cp "$LICENSE_FILE" "$DIAR_DIR/LICENSE.segmentation.txt"
  cp "$SEG" "$DIAR_DIR/segmentation.onnx"
fi
if [ ! -f "$DIAR_DIR/embedding.onnx" ]; then
  fetch "$EMB_URL" "$TMP/embedding.onnx"
  [ "$(wc -c < "$TMP/embedding.onnx")" -gt 1048576 ] || { echo "声纹嵌入模型大小异常，可能下载不完整" >&2; exit 1; }
  cp "$TMP/embedding.onnx" "$DIAR_DIR/embedding.onnx"
fi

# ── 本地唤醒词模型（KWS）：只装模型文件，keywords 文件由应用按唤醒词常量生成 ──
if [ ! -f "$KWS_DIR/encoder.int8.onnx" ] || [ ! -f "$KWS_DIR/decoder.onnx" ]    || [ ! -f "$KWS_DIR/joiner.int8.onnx" ] || [ ! -f "$KWS_DIR/tokens.txt" ]; then
  PACK="$TMP/kws.tar.bz2"
  fetch "$KWS_URL" "$PACK"
  if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$PACK" | cut -d' ' -f1)"; else ACTUAL="$(sha256sum "$PACK" | cut -d' ' -f1)"; fi
  [ "$ACTUAL" = "$KWS_SHA256" ] || { echo "唤醒模型 sha256 不符：期望 $KWS_SHA256，实际 $ACTUAL" >&2; exit 1; }
  echo "解压唤醒词模型..."
  tar -xjf "$PACK" -C "$TMP"
  mkdir -p "$KWS_DIR"
  for pair in "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx:encoder.int8.onnx"               "decoder-epoch-12-avg-2-chunk-16-left-64.onnx:decoder.onnx"               "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx:joiner.int8.onnx"; do
    SRC="$(find "$TMP" -name "${pair%%:*}" -type f | head -1)"
    [ -n "$SRC" ] || { echo "压缩包里没找到 ${pair%%:*}" >&2; exit 1; }
    cp "$SRC" "$KWS_DIR/${pair##*:}"
  done
  KWS_TOKENS="$(find "$TMP" -path '*kws*' -name 'tokens.txt' -type f | head -1)"
  [ -n "$KWS_TOKENS" ] || { echo "压缩包里没找到唤醒模型 tokens.txt" >&2; exit 1; }
  cp "$KWS_TOKENS" "$KWS_DIR/tokens.txt"
  KWS_README="$(dirname "$KWS_TOKENS")/README.md"
  [ ! -f "$KWS_README" ] || cp "$KWS_README" "$KWS_DIR/README.model.md"
fi

# ── 收尾核对：报告实际落盘的文件，而不是只说"完成" ──
echo
echo "装好了：$DEST"
find "$DEST" -type f | sort | while read -r f; do
  printf '  %s  %s\n' "$(du -h "$f" | cut -f1)" "${f#"$DEST"/}"
done
echo
echo "重启桌面宠物后生效（听写与唤醒都将完全离线）。"
