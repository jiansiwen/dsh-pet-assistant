# Download & install the local SenseVoice ASR stack (fully offline dictation).
#   bin\sherpa-onnx-offline.exe   from sherpa-onnx win-x64 static release
#   model\model.int8.onnx         SenseVoice int8 (zh/en/ja/ko/yue), ~230 MB download
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
$streamUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16.tar.bz2'

if ($Mirror -ne '') {
    $sherpaUrl = $Mirror.TrimEnd('/') + '/' + $sherpaUrl
    $modelUrl = $Mirror.TrimEnd('/') + '/' + $modelUrl
    $streamUrl = $Mirror.TrimEnd('/') + '/' + $streamUrl
}

$exe = Join-Path $Dest 'bin\sherpa-onnx-offline.exe'
$onnx = Join-Path $Dest 'model\model.int8.onnx'
$tokens = Join-Path $Dest 'model\tokens.txt'

if ((Test-Path $exe) -and (Test-Path $onnx) -and (Test-Path $tokens)) {
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
    & curl.exe -L --fail --retry 3 -o $file $url
    if ($LASTEXITCODE -ne 0) { throw "download failed: $url (exit $LASTEXITCODE)`nGitHub 直连不通时加 -Mirror，例如 -Mirror `"https://gh-proxy.com/`"" }
}

$tmp = Join-Path $env:TEMP ('dsh-asr-setup-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    if (-not (Test-Path $exe)) {
        $pack = Join-Path $tmp 'sherpa.tar.bz2'
        Fetch $sherpaUrl $pack
        Write-Output 'extracting sherpa-onnx ...'
        tar -xjf $pack -C $tmp
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
        tar -xjf $pack -C $tmp
        $foundOnnx = Get-ChildItem -Path $tmp -Recurse -Filter 'model.int8.onnx' | Select-Object -First 1
        $foundTokens = Get-ChildItem -Path $tmp -Recurse -Filter 'tokens.txt' | Select-Object -First 1
        if ($null -eq $foundOnnx -or $null -eq $foundTokens) { throw 'model files not found in the archive' }
        Copy-Item $foundOnnx.FullName $onnx -Force
        Copy-Item $foundTokens.FullName $tokens -Force
    }

    # 流式模型（边说边出字）：缺哪个文件就重下整包，约 458MB。
    $streamDir = Join-Path $Dest 'streaming'
    $streamFiles = @('encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt')
    $streamMissing = $streamFiles | Where-Object { -not (Test-Path (Join-Path $streamDir $_)) }
    if ($streamMissing.Count -gt 0) {
        $pack = Join-Path $tmp 'streaming.tar.bz2'
        Fetch $streamUrl $pack
        Write-Output 'extracting streaming model ...'
        tar -xjf $pack -C $tmp
        New-Item -ItemType Directory -Force -Path $streamDir | Out-Null
        Copy-Item (Join-Path $tmp 'sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16\tokens.txt') (Join-Path $streamDir 'tokens.txt') -Force
        foreach ($name in @('encoder', 'decoder', 'joiner')) {
            $src = Get-ChildItem -Path $tmp -Recurse -Filter "$name-epoch-99-avg-1.int8.onnx" | Select-Object -First 1
            if ($null -eq $src) { throw "streaming $name model not found" }
            Copy-Item $src.FullName (Join-Path $streamDir "$name.int8.onnx") -Force
        }
    }

    Write-Output "installed: $Dest"
    Write-Output 'Desktop pet will use local streaming + SenseVoice dictation on next launch.'
} finally {
    try { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}
