param([int]$Port = 21128)

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (!$listeners) {
  Write-Host "No server is listening on port $Port."
  exit 0
}

foreach ($listener in $listeners) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
  if ($process.ProcessName -ne "node") {
    throw "Refusing to stop non-Node process $($process.ProcessName) on port $Port."
  }
  Stop-Process -Id $process.Id -Force
  Write-Host "Stopped 9Router Contributor on port $Port (PID $($process.Id))."
}
