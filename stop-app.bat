@echo off
rem Tat VN Stock Advisor dang chay ngam (tien trinh node giu cong 3000).
rem Database va Tailscale van giu nguyen; muon tat ca database: stop-app.bat db
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -Command "$ids = (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique; $n = 0; foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $id -Force; $n++; Write-Host ('Da tat app (PID ' + $id + ')') } }; if (-not $n) { Write-Host 'App khong chay.' }"

if /i "%~1"=="db" (
  echo Tat database...
  docker compose stop
)
timeout /t 5 >nul
