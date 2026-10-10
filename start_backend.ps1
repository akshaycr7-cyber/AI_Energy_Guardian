[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8001
)

$projectRoot = $PSScriptRoot
$workspaceRoot = Split-Path -Parent $projectRoot
$python = Join-Path $workspaceRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $python)) {
    throw "Python virtual environment was not found at $python."
}

$listenerPattern = "^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):${Port}\s+.*\s+LISTENING\s+\d+\s*$"
$listener = netstat -ano | Where-Object { $_ -match $listenerPattern }
if ($listener) {
    throw "Port $Port is already in use. This script will not stop existing processes; use another port or stop the intended backend yourself."
}

Push-Location $projectRoot
try {
    & $python -m uvicorn backend.main:app --host 127.0.0.1 --port $Port --reload
}
finally {
    Pop-Location
}
