# Move WSL Ubuntu to D: and clear safe caches
# Run in PowerShell as Administrator

$ErrorActionPreference = "Stop"

Write-Host "=== WSL Ubuntu Move + Cache Cleanup ===" -ForegroundColor Cyan

# Phase 1: Shut down WSL
Write-Host "`n[1/4] Shutting down WSL..." -ForegroundColor Yellow
wsl.exe --shutdown
Start-Sleep -Seconds 2

# Phase 2: Export Ubuntu from C: to temp location
Write-Host "[2/4] Exporting Ubuntu distro (this may take 2-3 min)..." -ForegroundColor Yellow
$exportPath = "D:\wsl-backup\Ubuntu.tar"
$exportDir = "D:\wsl-backup"

if (-not (Test-Path $exportDir)) {
    New-Item -ItemType Directory -Path $exportDir -Force | Out-Null
}

wsl.exe --export Ubuntu $exportPath
if (-not (Test-Path $exportPath)) {
    Write-Host "Export failed!" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Ubuntu exported to $exportPath" -ForegroundColor Green

# Phase 3: Unregister old Ubuntu (from C:)
Write-Host "[3/4] Unregistering Ubuntu from C: (this deletes C: copy)..." -ForegroundColor Yellow
wsl.exe --unregister Ubuntu
Start-Sleep -Seconds 1

# Phase 4: Reimport Ubuntu to D:
Write-Host "[4/4] Importing Ubuntu to D:\wsl\Ubuntu (this may take 2-3 min)..." -ForegroundColor Yellow
$importPath = "D:\wsl\Ubuntu"
if (-not (Test-Path "D:\wsl")) {
    New-Item -ItemType Directory -Path "D:\wsl" -Force | Out-Null
}

wsl.exe --import Ubuntu $importPath $exportPath --version 2
if ($LASTEXITCODE -ne 0) {
    Write-Host "Import failed!" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Ubuntu imported to $importPath" -ForegroundColor Green

# Clean up export tarball
Write-Host "`nCleaning up export tarball..." -ForegroundColor Yellow
Remove-Item $exportPath -Force
Write-Host "✓ Removed $exportPath" -ForegroundColor Green

# Clear safe caches
Write-Host "`n=== Clearing Safe Caches ===" -ForegroundColor Cyan

$cachePaths = @(
    @{ Path = "$env:TEMP"; Name = "Temp folder" },
    @{ Path = "$env:LOCALAPPDATA\Temp"; Name = "AppData\Temp" },
    @{ Path = "$env:LOCALAPPDATA\.cache"; Name = ".cache" },
    @{ Path = "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Cache"; Name = "Chrome cache" },
    @{ Path = "$env:USERPROFILE\Downloads"; Name = "Downloads (review before delete)" }
)

foreach ($cache in $cachePaths) {
    if (Test-Path $cache.Path) {
        $sz = (Get-ChildItem $cache.Path -Recurse -Force -ErrorAction SilentlyContinue |
               Measure-Object -Property Length -Sum).Sum
        if ($sz -gt 0) {
            Write-Host "  Clearing $($cache.Name): $(([math]::Round($sz/1GB, 2))) GB" -ForegroundColor Yellow
            Get-ChildItem $cache.Path -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "  ✓ Cleared" -ForegroundColor Green
        }
    }
}

# Empty Recycle Bin
Write-Host "`nEmptying Recycle Bin..." -ForegroundColor Yellow
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
Write-Host "✓ Recycle bin emptied" -ForegroundColor Green

Write-Host "`n=== Complete ===" -ForegroundColor Green
Write-Host "Ubuntu is now on D:\wsl\Ubuntu" -ForegroundColor Cyan
Write-Host "Free up space on C: by verifying: Get-PSDrive C" -ForegroundColor Cyan
Write-Host "`nStart WSL: wsl.exe" -ForegroundColor Cyan
