# Audio capability probe (stage A of docs/desktop-expert-team).
#
# Why this exists: continuous speech and document narration need both recognition and
# synthesis, and the plan says to ship exactly one provider of each. Picking one cannot be
# guesswork -- Windows offline speech comes in two generations (SAPI5 and OneCore), and
# System.Speech only sees the former, where Chinese voice quality varies a lot.
#
# This file is pure ASCII on purpose. Windows PowerShell 5.1 reads a .ps1 without a BOM as
# ANSI (GBK on this machine), and a UTF-8 Chinese literal can swallow its own closing quote
# during that misdecode -- the script then fails to parse at all. wake.ps1 and asr-wave.ps1 follow
# the same rule; build any non-ASCII string from [char] code points instead.
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-audio.ps1
# Read-only. Changes no system setting, records no audio, makes no sound.

$ErrorActionPreference = 'Continue'

function Write-Section([string]$title) {
  Write-Output ''
  Write-Output ('=== ' + $title + ' ===')
}

function Describe-Culture([string]$name) {
  if ($name -like 'zh*') { return 'CHINESE' }
  return $name
}

Write-Section 'Synthesis voices visible to System.Speech'
try {
  Add-Type -AssemblyName System.Speech
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $voices = @($synth.GetInstalledVoices())
  if ($voices.Count -eq 0) {
    Write-Output 'none installed: System.Speech synthesis is unavailable'
  }
  foreach ($item in $voices) {
    $info = $item.VoiceInfo
    Write-Output ($info.Name + ' | ' + (Describe-Culture $info.Culture.Name) + ' | ' + $info.Gender + ' | enabled=' + $item.Enabled)
  }
  $default = $synth.Voice
  if ($default) {
    Write-Output ('default voice: ' + $default.Name + ' | ' + (Describe-Culture $default.Culture.Name))
  }
  $zh = @($voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' -and $_.Enabled })
  Write-Output ('chinese synthesis voices: ' + $zh.Count)
} catch {
  Write-Output ('probe failed: ' + $_.Exception.Message)
}

Write-Section 'Recognizers visible to System.Speech'
try {
  $recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
  if ($recognizers.Count -eq 0) {
    Write-Output 'none installed: offline recognition is unavailable'
  }
  foreach ($item in $recognizers) {
    Write-Output ($item.Id + ' | ' + (Describe-Culture $item.Culture.Name) + ' | ' + $item.Description)
  }
  $zhRec = @($recognizers | Where-Object { $_.Culture.Name -like 'zh*' })
  Write-Output ('chinese recognizers: ' + $zhRec.Count)
} catch {
  Write-Output ('probe failed: ' + $_.Exception.Message)
}

# OneCore is the Windows 10 generation: much more natural voices, but System.Speech does not
# expose them. Reaching them means WinRT (Windows.Media.SpeechSynthesizer). Counting the
# registry keys here is what tells us whether that detour is worth taking.
Write-Section 'OneCore voices in the registry (invisible to System.Speech)'
$hives = @(
  'HKLM:\SOFTWARE\Microsoft\Speech_OneCore\Voices\Tokens',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Speech_OneCore\Voices\Tokens',
  'HKLM:\SOFTWARE\Microsoft\Speech\Voices\Tokens',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Speech\Voices\Tokens'
)
foreach ($hive in $hives) {
  Write-Output $hive
  if (-not (Test-Path $hive)) {
    Write-Output '  (absent)'
    continue
  }
  foreach ($token in Get-ChildItem $hive) {
    $props = Get-ItemProperty $token.PSPath
    $label = $props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | Select-Object -First 1
    Write-Output ('  ' + $token.PSChildName + ' | ' + $label.Value)
  }
}

Write-Section 'Sound devices'
try {
  foreach ($device in Get-CimInstance Win32_SoundDevice) {
    Write-Output ($device.Name + ' | status=' + $device.Status)
  }
} catch {
  Write-Output ('probe failed: ' + $_.Exception.Message)
}

Write-Section 'How to read this'
Write-Output 'chinese synthesis voices = 0  ->  System.Speech cannot speak Chinese here; use WinRT or an external provider.'
Write-Output 'OneCore has Chinese but SAPI5 does not  ->  the WinRT detour buys a much better voice.'
Write-Output 'chinese recognizers = 0  ->  neither the wake word nor push-to-talk dictation can work; install the Chinese language pack first.'
