# Download & install the local SenseVoice ASR stack (fully offline dictation).
#   bin\sherpa-onnx-offline.exe   from sherpa-onnx win-x64 static release
#   streaming-zh-14m\             Zipformer 14M Chinese streaming model (int8)
#   model\tokens.txt
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-local-asr.ps1
#         [-Dest "$env:APPDATA\dsh-pet\local-asr"] [-Mirror "https://ghproxy.net/"]
#
# -Mirror prefixes both download URLs (GitHub can be unreachable from CN networks).
# Re-running is safe: finished parts are skipped.

param(
    [string]$Dest = (Join-Path $env:APPDATA 'dsh-pet\local-asr'),
    [string]$Mirror = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$sherpaUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-v1.13.7-win-x64-static-MD-Release-no-tts.tar.bz2'
$modelUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2'
$streamUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2'
# Speaker diarization for meetings (pyannote segmentation + 3D-Speaker embedding); runs locally, audio never uploaded.
$segUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
$embUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'
# Wake word ("xiao pan xiao pan") keyword spotter for local wake (M1-02): sherpa-onnx official kws-models release,
# zipformer trained on WenetSpeech, ~3.3M params, pinyin initials/finals as tokens. License: Apache-2.0 (model README).
# 15,292,881 bytes; sha256 from the release's checksum.txt (verified below before extracting).
$kwsUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01-mobile.tar.bz2'
$kwsSha256 = 'b812a043aef628a6915f89cb9a94e55f8e87e89ff904b516f822d7e0a3e6de2b'

if ($Mirror -ne '') {
    $sherpaUrl = $Mirror.TrimEnd('/') + '/' + $sherpaUrl
    $modelUrl = $Mirror.TrimEnd('/') + '/' + $modelUrl
    $streamUrl = $Mirror.TrimEnd('/') + '/' + $streamUrl
    $segUrl = $Mirror.TrimEnd('/') + '/' + $segUrl
    $embUrl = $Mirror.TrimEnd('/') + '/' + $embUrl
    $kwsUrl = $Mirror.TrimEnd('/') + '/' + $kwsUrl
}

$exe = Join-Path $Dest 'bin\sherpa-onnx-offline.exe'
$onnx = Join-Path $Dest 'model\model.int8.onnx'
$tokens = Join-Path $Dest 'model\tokens.txt'
$streamDir = Join-Path $Dest 'streaming-zh-14m'
$streamFiles = @('encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt')
$diarDir = Join-Path $Dest 'diarization'
$segOnnx = Join-Path $diarDir 'segmentation.onnx'
$embOnnx = Join-Path $diarDir 'embedding.onnx'
$kwsDir = Join-Path $Dest 'kws'
$kwsFiles = @('encoder.int8.onnx', 'decoder.onnx', 'joiner.int8.onnx', 'tokens.txt')
$kwsReady = @($kwsFiles | Where-Object { -not (Test-Path (Join-Path $kwsDir $_)) }).Count -eq 0

$streamReady = @($streamFiles | Where-Object { -not (Test-Path (Join-Path $streamDir $_)) }).Count -eq 0
if ((Test-Path $exe) -and (Test-Path $onnx) -and (Test-Path $tokens) -and $streamReady -and (Test-Path $segOnnx) -and (Test-Path $embOnnx) -and $kwsReady) {
    Write-Output "already installed: $Dest"
    exit 0
}

New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'bin') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'model') | Out-Null

function Fetch([string]$url, [string]$file) {
    if (Test-Path $file) {
        Write-Output "keep existing: $file"
        return
    }
    Write-Output "downloading $url"
    # curl（Win10+ 自带）流式写盘、可观察进度。Invoke-WebRequest 在 PS 5.1 上下载
    # 大文件会整块缓冲且实测经常长时间 0 字节，不要改回去。
    # Native stderr must not become a terminating error under $ErrorActionPreference = 'Stop'.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & curl.exe -L --fail --retry 3 -sS -o $file $url
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) {
        Remove-Item $file -Force -ErrorAction SilentlyContinue
        throw "download failed: $url (exit $code)`nGitHub 直连不通时加 -Mirror，例如 -Mirror `"https://gh-proxy.com/`""
    }
}

$tmp = Join-Path $env:TEMP ('dsh-asr-setup-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
# Git for Windows' GNU tar treats "C:\..." as a remote host unless --force-local is given;
# Windows bsdtar may shell out to an external bzip2 and hang, so stay on the tar found in PATH.
$tarExe = 'tar'
$tarArgs = @()
$tarVersion = (& $tarExe --version 2>$null | Select-Object -First 1)
if ("$tarVersion" -match 'GNU tar') { $tarArgs = @('--force-local') }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    if (-not (Test-Path $exe)) {
        $pack = Join-Path $tmp 'sherpa.tar.bz2'
        Fetch $sherpaUrl $pack
        Write-Output 'extracting sherpa-onnx ...'
        & $tarExe @tarArgs -xjf $pack -C $tmp
        $found = Get-ChildItem -Path $tmp -Recurse -Filter 'sherpa-onnx-offline.exe' | Select-Object -First 1
        if ($null -eq $found) { throw 'sherpa-onnx-offline.exe not found in the archive' }
        $runtimeDlls = Get-ChildItem -Path $found.Directory.FullName -Filter '*.dll'
        Copy-Item $found.FullName $exe -Force
        foreach ($dll in $runtimeDlls) { Copy-Item $dll.FullName (Join-Path $Dest 'bin') -Force }
    }

    if (-not (Test-Path $onnx) -or -not (Test-Path $tokens)) {
        $pack = Join-Path $tmp 'model.tar.bz2'
        Fetch $modelUrl $pack
        Write-Output 'extracting SenseVoice model (this takes a while) ...'
        & $tarExe @tarArgs -xjf $pack -C $tmp
        $foundOnnx = Get-ChildItem -Path $tmp -Recurse -Filter 'model.int8.onnx' | Select-Object -First 1
        $foundTokens = Get-ChildItem -Path $tmp -Recurse -Filter 'tokens.txt' | Select-Object -First 1
        if ($null -eq $foundOnnx -or $null -eq $foundTokens) { throw 'model files not found in the archive' }
        Copy-Item $foundOnnx.FullName $onnx -Force
        Copy-Item $foundTokens.FullName $tokens -Force
    }

    # 流式模型（边说边出字）：纯中文 14M，缺哪个文件就重下整包，约 74MB。
    $streamMissing = $streamFiles | Where-Object { -not (Test-Path (Join-Path $streamDir $_)) }
    if ($streamMissing.Count -gt 0) {
        $pack = Join-Path $tmp 'streaming.tar.bz2'
        Fetch $streamUrl $pack
        Write-Output 'extracting streaming model ...'
        & $tarExe @tarArgs -xjf $pack -C $tmp
        New-Item -ItemType Directory -Force -Path $streamDir | Out-Null
        $streamRoot = 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23'
        Copy-Item (Join-Path $tmp "$streamRoot\tokens.txt") (Join-Path $streamDir 'tokens.txt') -Force
        foreach ($name in @('encoder', 'decoder', 'joiner')) {
            $src = Get-ChildItem -Path (Join-Path $tmp $streamRoot) -Filter "$name-epoch-99-avg-1.int8.onnx" | Select-Object -First 1
            if ($null -eq $src) { throw "streaming $name model not found" }
            Copy-Item $src.FullName (Join-Path $streamDir "$name.int8.onnx") -Force
        }
    }

    if (-not (Test-Path $segOnnx) -or -not (Test-Path $embOnnx)) {
        New-Item -ItemType Directory -Force -Path $diarDir | Out-Null
        if (-not (Test-Path $segOnnx)) {
            $pack = Join-Path $tmp 'segmentation.tar.bz2'
            Fetch $segUrl $pack
            & $tarExe @tarArgs -xjf $pack -C $tmp
            $foundSeg = Get-ChildItem -Path $tmp -Recurse -Filter 'model.onnx' |
                Where-Object { $_.Directory.Name -like '*pyannote-segmentation*' } | Select-Object -First 1
            if ($null -eq $foundSeg) { throw 'speaker segmentation model.onnx not found in the archive' }
            $license = Get-ChildItem -Path $foundSeg.Directory.FullName -Filter 'LICENSE*' | Select-Object -First 1
            if ($null -ne $license) { Copy-Item $license.FullName (Join-Path $diarDir 'LICENSE.segmentation.txt') -Force }
            Copy-Item $foundSeg.FullName $segOnnx -Force
        }
        if (-not (Test-Path $embOnnx)) {
            $file = Join-Path $tmp 'embedding.onnx'
            Fetch $embUrl $file
            if ((Get-Item $file).Length -lt 1MB) { throw 'speaker embedding model looks truncated' }
            Copy-Item $file $embOnnx -Force
        }
    }

    # Local wake-word model (keyword spotter). Only model files; the keywords file is generated by the app.
    if (-not $kwsReady) {
        $pack = Join-Path $tmp 'kws.tar.bz2'
        Fetch $kwsUrl $pack
        $actual = (Get-FileHash -Algorithm SHA256 -Path $pack).Hash.ToLowerInvariant()
        if ($actual -ne $kwsSha256) {
            Remove-Item $pack -Force -ErrorAction SilentlyContinue
            throw "kws model sha256 mismatch: expected $kwsSha256, got $actual"
        }
        Write-Output 'extracting wake-word model ...'
        & $tarExe @tarArgs -xjf $pack -C $tmp
        New-Item -ItemType Directory -Force -Path $kwsDir | Out-Null
        $kwsMap = @{
            'encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx' = 'encoder.int8.onnx'
            'decoder-epoch-12-avg-2-chunk-16-left-64.onnx' = 'decoder.onnx'
            'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx' = 'joiner.int8.onnx'
        }
        foreach ($name in $kwsMap.Keys) {
            $src = Get-ChildItem -Path $tmp -Recurse -Filter $name | Select-Object -First 1
            if ($null -eq $src) { throw "wake-word model file not found: $name" }
            Copy-Item $src.FullName (Join-Path $kwsDir $kwsMap[$name]) -Force
        }
        $kwsTokens = Get-ChildItem -Path $tmp -Recurse -Filter 'tokens.txt' | Where-Object { $_.Directory.Name -like '*kws*' } | Select-Object -First 1
        if ($null -eq $kwsTokens) { throw 'wake-word tokens.txt not found' }
        Copy-Item $kwsTokens.FullName (Join-Path $kwsDir 'tokens.txt') -Force
        $kwsReadme = Get-ChildItem -Path $kwsTokens.Directory.FullName -Filter 'README.md' | Select-Object -First 1
        if ($null -ne $kwsReadme) { Copy-Item $kwsReadme.FullName (Join-Path $kwsDir 'README.model.md') -Force }
    }

    Write-Output "installed: $Dest"
    Write-Output 'Desktop pet will use local streaming + SenseVoice dictation on next launch.'
} finally {
    try { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
