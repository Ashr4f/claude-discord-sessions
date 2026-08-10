' Invisible launcher for the Discord wake-on-message watcher.
' powershell.exe -WindowStyle Hidden still flashes/keeps a console when run
' from Task Scheduler; WScript.Shell.Run with window style 0 does not.
Dim shell, ps
Set shell = CreateObject("WScript.Shell")
ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & _
     shell.ExpandEnvironmentStrings("%USERPROFILE%") & _
     "\.claude\channels\discord\start-watcher.ps1"""
shell.Run ps, 0, False
