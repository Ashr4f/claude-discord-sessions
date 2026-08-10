# Show or hide the hidden console window of a background Claude session.
# Usage: show-console.ps1 -ClaudePid <pid> -Action show|hide
param(
    [Parameter(Mandatory = $true)][int]$ClaudePid,
    [Parameter(Mandatory = $true)][ValidateSet('show', 'hide')][string]$Action
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinFind {
    delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public static List<IntPtr> ForPids(HashSet<uint> targets) {
        var r = new List<IntPtr>();
        EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (targets.Contains(p)) r.Add(h); return true; }, IntPtr.Zero);
        return r;
    }
}
"@

# The console window belongs to the claude pid itself, its conhost child, or
# (Windows Terminal as default host) an openconsole/terminal process tied to it.
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
[void]$pids.Add([uint32]$ClaudePid)
Get-CimInstance Win32_Process -Filter "ParentProcessId=$ClaudePid" | ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }

$handles = [WinFind]::ForPids($pids)
if ($handles.Count -eq 0) { Write-Output "no-window"; exit 1 }

$sw = if ($Action -eq 'show') { 9 } else { 0 }  # SW_RESTORE / SW_HIDE
$shown = 0
foreach ($h in $handles) {
    [void][WinFind]::ShowWindow($h, $sw)
    if ($Action -eq 'show') { [void][WinFind]::SetForegroundWindow($h) }
    if ([WinFind]::IsWindowVisible($h) -eq ($Action -eq 'show')) { $shown++ }
}
Write-Output "$Action $shown/$($handles.Count)"
