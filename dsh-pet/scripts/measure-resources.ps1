# Resource measurement for design.md section 11.2 acceptance.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-resources.ps1 -Minutes 10
# Run while the pet is on the desk (stage visible, characters wandering).
# CPU is reported both per-core and machine-wide; the design doc does not fix the caliber,
# so both numbers are printed and the caller decides which caliber was meant.

param(
  [int]$Minutes = 10,
  [string]$ProcessName = 'electron'
)

$cores = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$points = [int]($Minutes * 60 / 60)

Write-Host ("Logical cores: " + $cores)
Write-Host ("Sampling " + $points + " points, 60s apart. Keep the window on screen and hands off the keyboard.")

$first = $null
$last = $null
$memSamples = @()
for ($i = 0; $i -le $points; $i++) {
  $procs = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
  if (-not $procs) { Write-Host "process gone, aborting"; exit 1 }
  $cpu = ($procs | Measure-Object CPU -Sum).Sum
  $mem = [math]::Round((($procs | Measure-Object PrivateMemorySize64 -Sum).Sum)/1MB, 1)
  if ($null -eq $first) { $first = @{ Cpu = $cpu; Mem = $mem } }
  $last = @{ Cpu = $cpu; Mem = $mem }
  $memSamples += $mem
  # 最后一个点之后不再等：-Minutes 0 时两点相邻，测的是瞬时不均值。
  if ($i -lt $points) { Start-Sleep -Seconds 60 }
}

$wall = $points * 60
$cpuSeconds = [math]::Round($last.Cpu - $first.Cpu, 1)
if ($wall -le 0) { $wall = 1 }
$perCore = [math]::Round($cpuSeconds / $wall * 100, 2)
$machine = [math]::Round($perCore / $cores, 2)
$memAvg = [math]::Round(($memSamples | Measure-Object -Average).Average, 1)
$memMax = ($memSamples | Measure-Object -Maximum).Maximum

Write-Host ""
Write-Host ("Wall clock: " + $wall + "s, CPU seconds: " + $cpuSeconds)
Write-Host ("CPU average: " + $perCore + "% of one core = " + $machine + "% machine-wide (" + $cores + " cores)")
Write-Host ("Private memory: avg " + $memAvg + "MB, max " + $memMax + "MB")
Write-Host ""
Write-Host ("Design target (section 11.2, five characters): CPU <= 5% and private memory <= 600MB over 10 minutes.")
Write-Host ("Per-core caliber:  " + $(if ($perCore -le 5) { 'PASS' } else { 'OVER' }))
Write-Host ("Machine caliber:   " + $(if ($machine -le 5) { 'PASS' } else { 'OVER' }))
Write-Host ("Memory caliber:    " + $(if ($memMax -le 600) { 'PASS' } else { 'OVER' }))
Write-Host "GPU usage is not scriptable here - read it once from Task Manager during the run and write it down."
