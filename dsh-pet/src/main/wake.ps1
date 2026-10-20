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
    # Wake word "Xiao Pan Tong Xue" (U+5C0F U+6F58 U+540C U+5B66).
    #
    # Four syllables, and unlike the old "Xiao Pan Xiao Pan" the tail ("tong xue") is a
    # distinct word pair rather than a repeat: the recognizer matches whole phrases, so a
    # repeated two-syllable word is far more likely to be produced by ambient speech than
    # this one. It also reads like a name people actually say out loud.
    #
    # The grammar itself lives in wake-grammar.ps1 so the offline probe
    # (_verify/wake-grammar-probe.ps1) exercises the exact same builder -- otherwise a
    # probe result would only be evidence about a copy that may have drifted.
    . (Join-Path $PSScriptRoot 'wake-grammar.ps1')
    # U+5C0F U+6F58 U+540C U+5B66 (Xiao Pan Tong Xue) -- keep this line ASCII-only:
    # PowerShell 5.1 parses BOM-less UTF-8 as GBK, so a literal here would corrupt the script.
    $wakeCodepoints = @(0x5C0F, 0x6F58, 0x540C, 0x5B66)
    $built = New-WakeGrammar -WakeCodepoints $wakeCodepoints -WithVariants
    $engine.LoadGrammar($built.Grammar)
} catch {
    Write-Output '{"ok":false,"error":"grammar-failed"}'
    exit 0
}

Write-Output '{"ready":true}'
[Console]::Out.Flush()

# Transient recognize errors must not end the listener.
#
# The old loop broke out on the first exception, which killed the process; the supervisor
# restarts it three seconds later, so short glitches were survivable -- but a persistent
# error turned into a restart storm while the user heard nothing. A single failed
# Recognize() almost always means "no speech in this window" or a device hiccup, so retry
# instead: give up only after a long run of consecutive failures, which is when the
# process really is wedged and the supervisor should take over.
$consecutiveFailures = 0
$maxConsecutiveFailures = 30

while ($true) {
    try {
        $reco = $engine.Recognize([TimeSpan]::FromSeconds(3))
        $consecutiveFailures = 0
    } catch {
        $consecutiveFailures++
        if ($consecutiveFailures -ge $maxConsecutiveFailures) {
            Write-Output '{"ok":false,"error":"recognize-failed"}'
            break
        }
        Start-Sleep -Milliseconds 200
        continue
    }

    if ($reco -and $reco.Text) {
        $result = @{ wake = $true; text = $reco.Text } | ConvertTo-Json -Compress
        [Console]::Out.WriteLine($result)
        [Console]::Out.Flush()
    }
}

try { $engine.Dispose() } catch { }
