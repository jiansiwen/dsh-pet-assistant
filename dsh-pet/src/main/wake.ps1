# Resident wake-word listener (Windows System.Speech, offline).
# Emits one JSON object per line:
#   {"ready":true}                  listener initialized and hearing
#   {"wake":true,"text":"<heard>"}  wake word recognized
#   {"ok":false,"error":"<code>"}   fatal listener error, process exits
# Error codes: init-failed | grammar-failed | recognize-failed
#
# NOTE: PowerShell 5.1 parses BOM-less UTF-8 as GBK, so this file must stay
# pure ASCII. The Chinese wake word is built from [char] code points below.
# RecognizeAsync event handlers run on engine threads and can crash the
# PowerShell 5.1 runspace. Keep recognition synchronous on the main thread.

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
    $engine.SetInputToDefaultAudioDevice()
} catch {
    Write-Output '{"ok":false,"error":"init-failed"}'
    exit 0
}

try {
    # Wake word "Xiao Pan" (U+5C0F U+6F58) plus homophone variants to raise recall:
    $xiao = [char]0x5C0F   # xiao3 (small)
    $pan  = [char]0x6F58   # Pan (surname)
    $variants = @(
        "$xiao$pan",                 # primary
        ($xiao + [char]0x76FC),      # homophone variant 1 (U+76FC)
        ($xiao + [char]0x76D8),      # homophone variant 2 (U+76D8)
        ($xiao + [char]0x78D0),      # homophone variant 3 (U+78D0)
        ($xiao + [char]0x7554),      # homophone variant 4 (U+7554)
        ($xiao + [char]0x87E0),      # homophone variant 5 (U+87E0)
        ([char]0x6653 + $pan),       # different first syllable (U+6653)
        ($pan + [char]0x554A)        # trailing particle variant (U+554A)
    )
    $choices = New-Object System.Speech.Recognition.Choices($variants)
    $grammar = New-Object System.Speech.Recognition.Grammar($choices)
    $engine.LoadGrammar($grammar)
} catch {
    Write-Output '{"ok":false,"error":"grammar-failed"}'
    exit 0
}

Write-Output '{"ready":true}'
[Console]::Out.Flush()

while ($true) {
    try {
        $reco = $engine.Recognize([TimeSpan]::FromSeconds(3))
    } catch {
        Write-Output '{"ok":false,"error":"recognize-failed"}'
        break
    }

    if ($reco -and $reco.Text) {
        $result = @{ wake = $true; text = $reco.Text } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($result)
        [Console]::Out.Flush()
    }
}

try { $engine.Dispose() } catch { }
