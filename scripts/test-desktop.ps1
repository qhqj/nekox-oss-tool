param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $workspace.StartsWith('D:\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Desktop test requires D-drive workspace' }
$runRoot = Join-Path $workspace ('test-results\desktop-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $runRoot 'tmp') -Force | Out-Null
$env:TEMP = Join-Path $runRoot 'tmp'
$env:TMP = $env:TEMP
$env:NEKOX_DESKTOP_TEST_ROOT = $runRoot
Set-Location -LiteralPath $workspace
if (-not $SkipBuild) {
  & node node_modules/vite/bin/vite.js build --config tests/desktop/vite.config.ts
  if ($LASTEXITCODE -ne 0) { throw 'Offline frontend build failed' }
  $build = Start-Process -FilePath (Get-Command cargo).Source -ArgumentList @('test','--locked','--offline','--manifest-path','src-tauri/Cargo.toml','--features','desktop-integration','--test','desktop_offline','--no-run','--message-format=json') -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runRoot 'build.jsonl') -RedirectStandardError (Join-Path $runRoot 'build.log')
  $null = $build.Handle
  $build.WaitForExit()
  if ($build.ExitCode -ne 0) { throw "Native test build failed; see $runRoot\build.log" }
  $artifacts = Get-Content -LiteralPath (Join-Path $runRoot 'build.jsonl') | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'desktop_offline' -and $_.executable }
  $binary = @($artifacts)[-1].executable
} else {
  $binary = (Get-ChildItem -LiteralPath (Join-Path $workspace 'src-tauri\target\debug\deps') -Filter 'desktop_offline-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
if (-not $binary) { throw 'Test binary not found' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OfflineTestWindows {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern bool SetWindowTextW(IntPtr h, string text);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  delegate bool Enumerate(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Enumerate callback, IntPtr p);
  public static IntPtr Control(IntPtr parent,int id) {
    IntPtr result=IntPtr.Zero;EnumChildWindows(parent,(h,p)=>{if(GetDlgCtrlID(h)==id){result=h;return false;}return true;},IntPtr.Zero);return result;
  }
}
'@
$process = Start-Process -FilePath $binary -WorkingDirectory $workspace -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runRoot 'stdout.log') -RedirectStandardError (Join-Path $runRoot 'stderr.log')
$null = $process.Handle
$deadline = [DateTime]::UtcNow.AddMinutes(4)
$stageName = ''
$actions = [Collections.Generic.HashSet[string]]::new()
try {
  while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    $stagePath = Join-Path $runRoot 'stage.json'
    if (Test-Path -LiteralPath $stagePath) {
      try { $stageName = (Get-Content -LiteralPath $stagePath -Raw | ConvertFrom-Json).name } catch { }
    }
    $owned = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$process.Id)
    $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$owned)
    foreach ($window in $windows) {
      if ($stageName -eq 'upload-view' -and $window.Current.Name -eq 'Nekox Offline Desktop Test' -and $actions.Add('upload-view')) {
        [OfflineTestWindows]::ShowWindow([IntPtr]$window.Current.NativeWindowHandle,0) | Out-Null
      }
      if ($window.Current.ClassName -ne '#32770') { continue }
      $handle = [IntPtr]$window.Current.NativeWindowHandle
      $children = $window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
      $buttons = @($children | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button })
      # Native overwrite confirmation is allowed only for our own existing.bin fixture.
      $yes = $buttons | Where-Object { $_.Current.AutomationId -in @('6','CommandButton_6') } | Select-Object -First 1
      if ($stageName -eq 'existing' -and $yes -and $yes.Current.IsEnabled -and -not $yes.Current.IsOffscreen) {
        $yes.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
        continue
      }
      if (-not [OfflineTestWindows]::IsWindowVisible($handle)) { continue }
      if ($stageName -eq 'cancel-save' -and -not $actions.Contains($stageName)) {
        $cancelHandle = [OfflineTestWindows]::Control($handle,2)
        if ($cancelHandle -ne [IntPtr]::Zero) { [OfflineTestWindows]::SendMessageW($cancelHandle,0xF5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null; $actions.Add($stageName) | Out-Null }
      } elseif ($stageName -in @('stream-save','stream-fail','stream-cancel','existing','raced') -and -not $actions.Contains($stageName)) {
        $editHandle = [OfflineTestWindows]::Control($handle,1001)
        $saveHandle = [OfflineTestWindows]::Control($handle,1)
        if ($editHandle -ne [IntPtr]::Zero -and $saveHandle -ne [IntPtr]::Zero) {
          [OfflineTestWindows]::SetWindowTextW($editHandle,(Join-Path $runRoot ('downloads\'+$stageName+'.bin'))) | Out-Null
          [OfflineTestWindows]::SendMessageW($saveHandle,0xF5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
          $actions.Add($stageName) | Out-Null
        }
      }
    }
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }
  if (-not $process.HasExited) { throw "Desktop suite timed out at $stageName; root: $runRoot" }
  if (-not (Test-Path -LiteralPath (Join-Path $runRoot 'results.jsonl'))) { throw "Desktop process exited before its first case (exit $($process.ExitCode)); root: $runRoot" }
  $cases = @(Get-Content -LiteralPath (Join-Path $runRoot 'results.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
  if ($stageName -ne 'done') { $stageName = (Get-Content -LiteralPath (Join-Path $runRoot 'stage.json') -Raw | ConvertFrom-Json).name }
  if ($process.ExitCode -ne 0 -or $stageName -ne 'done' -or @($cases | Where-Object { -not $_.passed }).Count) { throw "Desktop suite failed; root: $runRoot" }
  Write-Output ("PASS: {0} desktop cases; evidence: {1}" -f $cases.Count,$runRoot)
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id }
}
