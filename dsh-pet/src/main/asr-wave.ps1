# Offline fallback: recognize an existing wav file with the legacy Windows
# engine (System.Speech). Used when the local SenseVoice model is not installed.
# Output: {"ok":true,"text":"..."} or {"ok":false,"error":"empty"} (nothing heard).
#
# Deliberately synchronous (Recognize on a finite wav returns when it ends).
# The async event API crashes PowerShell 5.1 - see wake.ps1.

param([string]$Path)

$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Speech

try {
    $installed = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
    $zh = $installed | Where-Object { $_.Culture.Name -like 'zh*' } | Select-Object -First 1
    if ($zh) {
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($zh.Id)
    } else {
        $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    }
    $engine.SetInputToWaveFile($Path)
} catch {
    Write-Output '{"ok":false,"error":"init-failed"}'
    exit 0
}

try {
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
} catch {
    Write-Output '{"ok":false,"error":"grammar-failed"}'
    exit 0
}

try {
    # 朗读 wav 是有限长的：识别到文件尾就返回，超时只兜底防挂。
    $reco = $engine.Recognize([TimeSpan]::FromSeconds(60))
} catch {
    Write-Output '{"ok":false,"error":"recognize-failed"}'
    exit 0
}

try { $engine.Dispose() } catch { }

if ($reco -and $reco.Text) {
    $result = @{ ok = $true; text = $reco.Text } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($result)
} else {
    Write-Output '{"ok":false,"error":"timeout-empty"}'
}
