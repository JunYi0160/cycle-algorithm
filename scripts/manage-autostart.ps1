# Manage Autostart and Desktop Shortcut for Cycle Algorithm Daemon
param(
    [ValidateSet("Status", "Enable", "Disable", "UpdateDesktop", "Help")]
    [string]$Action = "Status"
)

$ErrorActionPreference = "Stop"
$root = (Get-Item $PSScriptRoot).Parent.FullName
$vbsPath = Join-Path $PSScriptRoot "start-daemon.vbs"
$icoPath = Join-Path $root "public\icon.ico"
$wscriptExe = Join-Path $env:SystemRoot "System32\wscript.exe"

$startupDir = [Environment]::GetFolderPath("Startup")
$startupLnk = Join-Path $startupDir "Cycle Algorithm 守护进程.lnk"

# Detect desktop paths
$desktopDirs = @(
    [Environment]::GetFolderPath("Desktop"),
    (Join-Path $env:USERPROFILE "OneDrive\Desktop"),
    (Join-Path $env:USERPROFILE "Desktop")
) | Select-Object -Unique | Where-Object { Test-Path $_ }

$sh = New-Object -ComObject WScript.Shell

function Set-DesktopShortcut {
    foreach ($dir in $desktopDirs) {
        $desktopLnk = Join-Path $dir "Cycle Algorithm 守护进程.lnk"
        $shortcut = $sh.CreateShortcut($desktopLnk)
        $shortcut.TargetPath = $wscriptExe
        $shortcut.Arguments = "`"$vbsPath`""
        $shortcut.WorkingDirectory = $root
        $shortcut.Description = "Cycle Algorithm Local Helper"
        $shortcut.WindowStyle = 7
        if (Test-Path $icoPath) {
            $shortcut.IconLocation = $icoPath + ",0"
        }
        $shortcut.Save()
        Write-Host "Updated desktop shortcut: $desktopLnk"
    }
}

function Enable-Autostart {
    $shortcut = $sh.CreateShortcut($startupLnk)
    $shortcut.TargetPath = $wscriptExe
    $shortcut.Arguments = "`"$vbsPath`" /autostart"
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = "Cycle Algorithm Silent Daemon Autostart"
    $shortcut.WindowStyle = 7
    if (Test-Path $icoPath) {
        $shortcut.IconLocation = $icoPath + ",0"
    }
    $shortcut.Save()
    Write-Host "Enabled autostart: $startupLnk"
}

function Disable-Autostart {
    if (Test-Path $startupLnk) {
        Remove-Item -Force $startupLnk
        Write-Host "Disabled autostart (removed startup shortcut)"
    } else {
        Write-Host "Autostart is not currently enabled"
    }
}

function Get-Status {
    $isAutostart = Test-Path $startupLnk
    $isListening = Test-NetConnection -ComputerName 127.0.0.1 -Port 8789 -InformationLevel Quiet -WarningAction SilentlyContinue
    [PSCustomObject]@{
        AutostartEnabled = $isAutostart
        StartupPath      = $startupLnk
        DaemonRunning    = $isListening
        Port             = 8789
    } | Format-List
}

switch ($Action) {
    "Status"        { Get-Status }
    "Enable"        { Enable-Autostart; Set-DesktopShortcut; Get-Status }
    "Disable"       { Disable-Autostart; Get-Status }
    "UpdateDesktop" { Set-DesktopShortcut }
    "Help"          { Write-Host "Usage: powershell -File scripts/manage-autostart.ps1 -Action [Status|Enable|Disable|UpdateDesktop]" }
}
