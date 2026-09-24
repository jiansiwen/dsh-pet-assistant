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
    # Wake word "Xiao Pan Xiao Pan" (U+5C0F U+6F58 U+5C0F U+6F58).
    #
    # Doubled on purpose: a single "Xiao Pan" is only two syllables and gets fired by
    # ambient conversation ("...small...plate..."). Four syllables is long enough that
    # ordinary speech rarely produces it, while still being quick to say.
    #
    # The grammar itself lives in wake-grammar.ps1 so the offline probe
    # (_verify/wake-grammar-probe.ps1) exercises the exact same builder -- otherwise a
    # probe result would only be evidence about a copy that may have drifted.
    . (Join-Path $PSScriptRoot 'wake-grammar.ps1')
    $wakeCodepoints = @(0x5C0F, 0x6F58, 0x5C0F, 0x6F58)
    $built = New-WakeGrammar -WakeCodepoints $wakeCodepoints -WithVariants
    $engine.LoadGrammar($built.Grammar)
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
