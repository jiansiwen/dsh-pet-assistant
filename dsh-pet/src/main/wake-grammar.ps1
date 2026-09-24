# Wake-word grammar construction, shared by the resident listener and the offline probe.
#
# WHY THIS FILE EXISTS ON ITS OWN:
# The wake word used to be spelled out inside wake.ps1. That made it impossible to verify
# the grammar without speaking into a microphone, and the same word was duplicated across
# eight places (docs, tray label, comments) with no single source of truth. Extracting the
# grammar here means every consumer -- the listener, the probe, any future test -- builds
# the word from ONE definition instead of copies that drift.
#
# HOW TO VERIFY A CHANGE TO THE WAKE WORD:
#   1. `node _verify/wake-listener-load.mjs dist/main/wake.ps1 8`
#      Runs the real listener 8 times and checks each one prints {"ready":true}.
#      **This is the reliable check** -- it exercises the production load path.
#   2. Confirm the phrase list: `_verify/wake-grammar-probe.ps1` prints the exact list
#      built from a codepoint set (its EmulateRecognize results are NOT reliable here --
#      see the warning at the top of that file, it once reported 7/8 failures on a
#      known-good grammar).
#   3. Whether saying the word actually wakes the pet is a microphone-in-the-room check.
#      No emulation can settle that; the recognition path needs real audio.
#
# IMPORTANT: this file must stay pure ASCII. PowerShell 5.1 parses BOM-less UTF-8 as GBK,
# so any Chinese literal here would be mangled. The wake word is built from code points.
#
# Dot-source it, then call New-WakeGrammar:
#   . "$PSScriptRoot/wake-grammar.ps1"
#   $grammar = New-WakeGrammar -WakeCodepoints @(0x5C0F, 0x6F58, 0x5C0F, 0x6F58)

Add-Type -AssemblyName System.Speech

# Homophone substitutions for 'Pan' (U+6F58). System.Speech's zh-CN recognizer frequently
# returns a same-sound character with a different tone or a near-homophone, so accepting
# those spellings raises recall without accepting genuinely different words.
#   0x6F58 Pan (surname)      0x76FC pan (to look)      0x76D8 pan (plate/tray)
#   0x78D0 pan (boulder)      0x7554 pan (to break off) 0x87E0 pan (to coil)
$script:PanHomophones = @(0x6F58, 0x76FC, 0x76D8, 0x78D0, 0x7554, 0x87E0)

# Codepoint of 'Pan', used to know which positions are substitutable.
$script:PanCodepoint = 0x6F58

<#
.SYNOPSIS
    Builds the wake-word grammar from a codepoint list.

.DESCRIPTION
    Returns a System.Speech.Recognition.Grammar containing the wake word, plus one variant
    per 'Pan' position for each homophone when -WithVariants is set.

    A repeated wake word ("Xiao Pan Xiao Pan") is deliberately built as a single phrase
    rather than as "the word, optionally repeated": the recognizer matches whole phrases,
    and two short separate words are far more likely to be emitted by ambient speech than
    one four-syllable phrase.

.PARAMETER WakeCodepoints
    The wake word as Unicode codepoints, e.g. @(0x5C0F, 0x6F58, 0x5C0F, 0x6F58).

.PARAMETER WithVariants
    Also accept homophone spellings of every 'Pan' position.
#>
function New-WakeGrammar {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][int[]]$WakeCodepoints,
        [switch]$WithVariants
    )

    if ($WakeCodepoints.Count -lt 2) {
        throw 'WakeCodepoints must contain at least two characters'
    }

    $primary = -join ($WakeCodepoints | ForEach-Object { [char]$_ })
    $variants = New-Object System.Collections.Generic.List[string]
    $variants.Add($primary)

    if ($WithVariants) {
        # Replace every Pan position one at a time (and only one at a time): all-at-once
        # combinations explode into thousands of phrases, which both slows recognition and
        # widens what counts as a hit -- the opposite of what a longer wake word is for.
        for ($i = 0; $i -lt $WakeCodepoints.Count; $i++) {
            if ($WakeCodepoints[$i] -ne $script:PanCodepoint) { continue }
            foreach ($pan in $script:PanHomophones) {
                if ($pan -eq $script:PanCodepoint) { continue }
                $altered = [int[]]::new($WakeCodepoints.Count)
                [Array]::Copy($WakeCodepoints, $altered, $WakeCodepoints.Count)
                $altered[$i] = $pan
                $alt = -join ($altered | ForEach-Object { [char]$_ })
                if (-not $variants.Contains($alt)) { $variants.Add($alt) }
            }
        }
    }

    $choices = New-Object System.Speech.Recognition.Choices($variants.ToArray())
    return [pscustomobject]@{
        Grammar      = New-Object System.Speech.Recognition.Grammar($choices)
        Phrases      = $variants.ToArray()
        PrimaryText  = $primary
    }
}
