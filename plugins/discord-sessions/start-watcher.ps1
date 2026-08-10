# Keeps the Discord wake-on-message watcher alive. Registered as a logon
# scheduled task (ClaudeDiscordWatcher); run manually to start it by hand.
$dir = Join-Path $env:USERPROFILE ".claude\channels\discord"
$console = Join-Path $dir "watcher-console.txt"
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) { $bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe" }

while ($true) {
    if ((Test-Path $console) -and ((Get-Item $console).Length -gt 5MB)) {
        Remove-Item $console -Force
    }
    & $bun (Join-Path $dir "watcher.mjs") *>> $console
    Start-Sleep -Seconds 5
}
