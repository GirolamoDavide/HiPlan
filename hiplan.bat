@echo off
setlocal EnableExtensions
title HiPlan - Console di Gestione
cd /d "%~dp0"
chcp 65001 >nul

set "HIPLAN_BAT=%~f0"
set "HIPLAN_ACTION=%~1"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$f=[System.IO.File]::ReadAllText($env:HIPLAN_BAT,[System.Text.Encoding]::UTF8); $m=':::'+'POWERSHELL_SECTION:::'; $i=$f.LastIndexOf($m); if($i -ge 0){ Invoke-Expression $f.Substring($i+$m.Length) } else { Write-Error 'Blocco PowerShell non trovato.'; pause }"
set "PS_EXIT=%ERRORLEVEL%"

if %PS_EXIT% neq 0 (
    if "%HIPLAN_ACTION%"=="" (
        echo.
        echo   [!] Il launcher ha rilevato un errore (%PS_EXIT%).
        pause
    )
)
exit /b %PS_EXIT%

:::POWERSHELL_SECTION:::
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$RootDir = Split-Path -Parent $env:HIPLAN_BAT
if (-not $RootDir) { $RootDir = (Get-Location).Path }
Set-Location $RootDir

$BackendDir  = Join-Path $RootDir "backend"
$FrontendDir = Join-Path $RootDir "frontend"
$LogsDir     = Join-Path $RootDir "logs"
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

$ESC = [char]27
$C_RESET  = "$ESC[0m"
$C_BOLD   = "$ESC[1m"
$C_DIM    = "$ESC[2m"
$C_RED    = "$ESC[91m"
$C_GREEN  = "$ESC[92m"
$C_YELLOW = "$ESC[93m"
$C_CYAN   = "$ESC[96m"
$C_WHITE  = "$ESC[97m"
$C_GRAY   = "$ESC[90m"

function Header {
    param([string]$Title)
    Write-Host ""
    Write-Host "$C_CYAN------------------------------------------------------------$C_RESET"
    Write-Host "  $C_BOLD${C_WHITE}HIPLAN$C_RESET  $C_GRAY|$C_RESET  $C_WHITE$Title$C_RESET"
    Write-Host "$C_CYAN------------------------------------------------------------$C_RESET"
    Write-Host ""
}

function Draw-Bar {
    param(
        [int]$Pct,
        [string]$Text
    )
    $w = 16
    $f = [math]::Floor($Pct * $w / 100)
    if ($f -lt 0) { $f = 0 }
    if ($f -gt $w) { $f = $w }
    $e = $w - $f
    $f_s = [string]::new([char]0x2588, $f)
    $e_s = [string]::new([char]0x2591, $e)
    $pctStr = "{0,3}%" -f $Pct
    $line = "`r  $C_GRAY[$C_CYAN$f_s$C_GRAY$e_s]$C_RESET $C_WHITE$pctStr$C_RESET  $C_GRAY$Text$C_RESET"
    Write-Host -NoNewline ($line.PadRight(80))
}

function Advance-Bar {
    param(
        [int]$FromPct,
        [int]$ToPct,
        [string]$Text
    )
    $step = 1
    if (($ToPct - $FromPct) -gt 25) { $step = 2 }
    for ($p = $FromPct; $p -le $ToPct; $p += $step) {
        Draw-Bar -Pct $p -Text $Text
        Start-Sleep -Milliseconds 12
    }
    Draw-Bar -Pct $ToPct -Text $Text
}

function Finish-Bar {
    param([string]$Text)
    $w = 16
    $f_s = [string]::new([char]0x2588, $w)
    $line = "`r  $C_GRAY[$C_GREEN$f_s$C_GRAY]$C_RESET $C_BOLD$C_GREEN 100% $C_RESET  $C_BOLD$C_GREEN[OK] $Text$C_RESET"
    Write-Host ($line.PadRight(80))
    Write-Host ""
}

function Fail-Bar {
    param(
        [int]$Pct,
        [string]$Text
    )
    $w = 16
    $f = [math]::Floor($Pct * $w / 100)
    if ($f -lt 0) { $f = 0 }
    if ($f -gt $w) { $f = $w }
    $e = $w - $f
    $f_s = [string]::new([char]0x2588, $f)
    $e_s = [string]::new([char]0x2591, $e)
    $pctStr = "{0,3}%" -f $Pct
    $line = "`r  $C_GRAY[$C_RED$f_s$C_GRAY$e_s]$C_RESET $C_BOLD$C_RED$pctStr$C_RESET  $C_BOLD$C_RED[ERRORE] $Text$C_RESET"
    Write-Host ($line.PadRight(80))
    Write-Host ""
}

function Run-WithProgress {
    param(
        [int]$StartPct,
        [int]$TargetPct,
        [string]$Text,
        [string]$LogFile,
        [string]$CommandLine,
        [string]$WorkingDir = $RootDir
    )
    if (-not (Test-Path $LogsDir)) { New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null }

    # Rimuove il vecchio log prima di eseguire per evitare di mostrare errori obsoleti
    if (Test-Path $LogFile) {
        Remove-Item $LogFile -Force -ErrorAction SilentlyContinue
    }

    # Creiamo un file batch temporaneo per isolare completamente l'esecuzione
    # ed evitare i problemi di interpretazione/quote-stripping di cmd /c
    $taskUid = [System.Guid]::NewGuid().ToString('N').Substring(0, 8)
    $tempBat = Join-Path $LogsDir "_task_$taskUid.bat"
    $batScript = "@echo off`r`ncd /d `"$WorkingDir`"`r`ncall $CommandLine > `"$LogFile`" 2>&1`r`nexit /b %ERRORLEVEL%"
    [System.IO.File]::WriteAllText($tempBat, $batScript, [System.Text.Encoding]::ASCII)

    $proc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c `"$tempBat`"" `
        -WorkingDirectory $WorkingDir `
        -WindowStyle Hidden `
        -PassThru

    $cur = $StartPct
    Draw-Bar -Pct $cur -Text $Text

    while (-not $proc.HasExited) {
        if ($cur -lt ($TargetPct - 1)) {
            $cur++
            Draw-Bar -Pct $cur -Text $Text
        }
        Start-Sleep -Milliseconds 180
    }

    $exitCode = $proc.ExitCode
    Remove-Item $tempBat -Force -ErrorAction SilentlyContinue

    if ($exitCode -ne 0) {
        Fail-Bar -Pct $cur -Text "$Text"
        Write-Host "  $C_YELLOW`Dettagli errore da log ($LogFile):$C_RESET"
        if (Test-Path $LogFile) {
            $logLines = Get-Content -Path $LogFile -Tail 15 -ErrorAction SilentlyContinue
            if ($logLines) {
                foreach ($line in $logLines) {
                    Write-Host "    $line" -ForegroundColor DarkYellow
                }
            } else {
                Write-Host "    (Nessun output salvato nel log. Codice uscita comando: $exitCode)" -ForegroundColor DarkYellow
            }
        } else {
            Write-Host "    (File di log non generato. Codice uscita comando: $exitCode)" -ForegroundColor DarkYellow
        }
        Write-Host ""
        return $false
    }

    Draw-Bar -Pct $TargetPct -Text $Text
    return $true
}

function Test-PortBusy {
    param([int]$Port)
    try {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($conn) { return $true }
    } catch {}

    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $iar = $tcp.BeginConnect("127.0.0.1", $Port, $null, $null)
        $wait = $iar.AsyncWaitHandle.WaitOne(300, $false)
        if ($wait -and $tcp.Connected) {
            $tcp.EndConnect($iar)
            $tcp.Close()
            return $true
        }
        $tcp.Close()
    } catch {}

    return $false
}

function Stop-Port {
    param([int]$Port)
    try {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            foreach ($c in $conns) {
                if ($c.OwningProcess -gt 0) {
                    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {}

    try {
        $lines = netstat -ano 2>$null | Select-String ":$Port\s+.*LISTENING"
        foreach ($line in $lines) {
            $parts = $line.ToString().Trim() -split '\s+'
            $pidToKill = $parts[-1]
            if ($pidToKill -match '^\d+$' -and [int]$pidToKill -gt 0) {
                Stop-Process -Id [int]$pidToKill -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}

function Stop-HiPlanProcesses {
    Stop-Port 8000
    Stop-Port 5173
    try {
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like '*app.main:app*' -or
            $_.CommandLine -like '*vite*' -or
            $_.CommandLine -like '*npm run dev*'
        } | ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {}
    try {
        Stop-Process -Name "uvicorn" -Force -ErrorAction SilentlyContinue
    } catch {}
}

function Find-Python {
    $cmd = Get-Command "python.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
        $check = & $cmd.Source -c "import sys; print(1 if sys.version_info >= (3, 9) else 0)" 2>$null
        if ($check -and $check.Trim() -eq "1") {
            return "`"$($cmd.Source)`""
        }
    }

    $cmdPy = Get-Command "py.exe" -ErrorAction SilentlyContinue
    if ($cmdPy) {
        $check = & $cmdPy.Source -3 -c "import sys; print(1 if sys.version_info >= (3, 9) else 0)" 2>$null
        if ($check -and $check.Trim() -eq "1") {
            return "py -3"
        }
    }

    $patterns = @(
        "$env:LocalAppData\Programs\Python\Python3*\python.exe",
        "$env:ProgramFiles\Python3*\python.exe",
        "${env:ProgramFiles(x86)}\Python3*\python.exe",
        "C:\Python3*\python.exe"
    )
    foreach ($p in $patterns) {
        $matches = Resolve-Path $p -ErrorAction SilentlyContinue
        if ($matches) {
            foreach ($m in $matches) {
                $check = & $m.Path -c "import sys; print(1 if sys.version_info >= (3, 9) else 0)" 2>$null
                if ($check -and $check.Trim() -eq "1") {
                    return "`"$($m.Path)`""
                }
            }
        }
    }
    return $null
}

function Find-Node {
    $cmd = Get-Command "node.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
        return "`"$($cmd.Source)`""
    }
    $paths = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) {
            $nodeDir = Split-Path -Parent $p
            if ($env:Path -notlike "*$nodeDir*") {
                $env:Path = "$nodeDir;$env:Path"
            }
            return "`"$p`""
        }
    }
    return $null
}

function Test-PythonEnv {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $false }
    try {
        $res = & $Path -c "import sys; print(1 if sys.version_info >= (3, 9) else 0)" 2>$null
        return ($res -and $res.Trim() -eq "1")
    } catch {
        return $false
    }
}

function Get-LocalIp {
    try {
        $ip = (Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {
            $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up'
        } | ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1)
        if ($ip) { return $ip }
    } catch {}

    try {
        $ip = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) | Where-Object {
            $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
            -not [System.Net.IPAddress]::IsLoopback($_) -and
            -not $_.IPAddressToString.StartsWith("169.254.")
        } | Select-Object -First 1 -ExpandProperty IPAddressToString
        if ($ip) { return $ip }
    } catch {}

    return $null
}

function Start-HiPlan {
    Header "Avvio Sistema"

    $pythonExe = Join-Path $BackendDir "venv\Scripts\python.exe"
    $nodeModules = Join-Path $FrontendDir "node_modules"

    if ((-not (Test-PythonEnv $pythonExe)) -or (-not (Test-Path $nodeModules))) {
        Write-Host "  $C_YELLOW[i] Installazione incompleta o ambiente da configurare: avvio setup...$C_RESET"
        Write-Host ""
        $ok = Setup-HiPlan -IsNested
        if (-not $ok) { return }
        Write-Host ""
    }

    Advance-Bar -FromPct 0 -ToPct 15 -Text "Controllo porte di rete..."
    if ((Test-PortBusy 8000) -or (Test-PortBusy 5173)) {
        Advance-Bar -FromPct 15 -ToPct 25 -Text "Rilascio porte occupate..."
        Stop-HiPlanProcesses
        Start-Sleep -Seconds 1
        if ((Test-PortBusy 8000) -or (Test-PortBusy 5173)) {
            Fail-Bar -Pct 25 -Text "Porta 8000 o 5173 occupata da altra applicazione"
            return
        }
    }
    Advance-Bar -FromPct 25 -ToPct 35 -Text "Porte 8000 e 5173 pronte"

    Draw-Bar -Pct 45 -Text "Avvio Backend API..."
    $backendLog = Join-Path $LogsDir "backend_app.log"
    $bBat = Join-Path $LogsDir "_start_backend.bat"
    [System.IO.File]::WriteAllText($bBat, "@echo off`r`ncd /d `"$BackendDir`"`r`n`"$pythonExe`" -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --log-level info > `"$backendLog`" 2>&1", [System.Text.Encoding]::ASCII)
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$bBat`"" -WorkingDirectory $BackendDir -WindowStyle Hidden

    Draw-Bar -Pct 60 -Text "Avvio Frontend Vite..."
    $frontendLog = Join-Path $LogsDir "frontend_app.log"
    $fBat = Join-Path $LogsDir "_start_frontend.bat"
    [System.IO.File]::WriteAllText($fBat, "@echo off`r`ncd /d `"$FrontendDir`"`r`ncall npm run dev -- --host 0.0.0.0 --port 5173 > `"$frontendLog`" 2>&1", [System.Text.Encoding]::ASCII)
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$fBat`"" -WorkingDirectory $FrontendDir -WindowStyle Hidden

    $ready = $false
    for ($i = 1; $i -le 40; $i++) {
        $pct = [int](65 + ($i * 30 / 40))
        Draw-Bar -Pct $pct -Text "Attesa risposta HTTP (${i}s)..."

        try {
            $h1 = (Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop).StatusCode
            $h2 = (Invoke-WebRequest -Uri "http://127.0.0.1:5173" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop).StatusCode
            if ($h1 -eq 200 -and $h2 -eq 200) {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Seconds 1
    }

    if (-not $ready) {
        Fail-Bar -Pct 75 -Text "I servizi non rispondono in tempo"
        Write-Host "  $C_YELLOW`Dettagli log:$C_RESET"
        Write-Host "    - $backendLog"
        Write-Host "    - $frontendLog"
        Stop-HiPlanProcesses
        return
    }

    Finish-Bar "Server avviato e sincronizzato!"

    $myIp = Get-LocalIp
    try {
        Start-Process "http://localhost:5173"
    } catch {}

    Write-Host "$C_GREEN------------------------------------------------------------$C_RESET"
    Write-Host "  $C_BOLD${C_WHITE}PUNTI DI ACCESSO HIPLAN$C_RESET"
    Write-Host "$C_GREEN------------------------------------------------------------$C_RESET"
    Write-Host "  $C_GREEN>$C_RESET  Questo PC:       $C_CYAN$C_BOLD`http://localhost:5173$C_RESET"
    if ($myIp) {
        Write-Host "  $C_GREEN>$C_RESET  Rete Locale:     $C_CYAN$C_BOLD`http://${myIp}:5173$C_RESET"
    }
    Write-Host "  $C_GREEN>$C_RESET  Documentazione:  $C_GRAY`http://localhost:8000/docs$C_RESET"
    Write-Host "$C_GREEN------------------------------------------------------------$C_RESET"
    Write-Host "  ${C_GRAY}I servizi sono attivi in background.$C_RESET"
    Write-Host ""
}

function Stop-HiPlan {
    Header "Arresto Servizi"
    Advance-Bar -FromPct 0 -ToPct 30 -Text "Chiusura Backend API..."
    Stop-Port 8000
    Advance-Bar -FromPct 30 -ToPct 65 -Text "Chiusura Frontend Web..."
    Stop-Port 5173
    Advance-Bar -FromPct 65 -ToPct 90 -Text "Pulizia processi residui..."
    Stop-HiPlanProcesses
    Finish-Bar "Tutti i servizi HiPlan sono stati arrestati!"
}

function Update-HiPlan {
    Header "Aggiornamento HiPlan"

    $pythonExe = Join-Path $BackendDir "venv\Scripts\python.exe"
    $nodeModules = Join-Path $FrontendDir "node_modules"

    if ((-not (Test-PythonEnv $pythonExe)) -or (-not (Test-Path $nodeModules))) {
        Write-Host "  $C_YELLOW[i] Ambiente non ancora configurato o non valido: avvio setup...$C_RESET"
        Write-Host ""
        $ok = Setup-HiPlan -IsNested
        if (-not $ok) { return }
        Write-Host ""
    }

    if (-not (Test-Path "$BackendDir\.env")) {
        if (Test-Path "$BackendDir\.env.example") {
            Copy-Item "$BackendDir\.env.example" "$BackendDir\.env"
        }
    }

    Advance-Bar -FromPct 0 -ToPct 15 -Text "Arresto servizi attivi..."
    Stop-HiPlanProcesses

    Advance-Bar -FromPct 15 -ToPct 25 -Text "Backup di sicurezza database..."
    $backupLog = Join-Path $LogsDir "backup.log"
    $bkBat = Join-Path $LogsDir "_task_backup.bat"
    [System.IO.File]::WriteAllText($bkBat, "@echo off`r`ncd /d `"$RootDir`"`r`n`"$pythonExe`" -c `"import sys; sys.path.append('backend'); from app.services.backup_service import run_backup; run_backup()`" > `"$backupLog`" 2>&1", [System.Text.Encoding]::ASCII)
    $procBk = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$bkBat`"" -WorkingDirectory $RootDir -WindowStyle Hidden -Wait -PassThru
    Remove-Item $bkBat -Force -ErrorAction SilentlyContinue
    if ($procBk.ExitCode -ne 0) {
        Write-Host "  $C_YELLOW[!] Nota: Backup preventivo non completato o database non presente.$C_RESET"
    }

    $pipLog = Join-Path $LogsDir "update_pip.log"
    $ok = Run-WithProgress -StartPct 25 -TargetPct 40 -Text "Aggiornamento pip e wheel..." -LogFile $pipLog -CommandLine "`"$pythonExe`" -m pip install --quiet --upgrade pip setuptools wheel"
    if (-not $ok) { return }

    $ok = Run-WithProgress -StartPct 40 -TargetPct 60 -Text "Aggiornamento librerie Python..." -LogFile $pipLog -CommandLine "`"$pythonExe`" -m pip install --quiet -r `"$BackendDir\requirements.txt`""
    if (-not $ok) { return }

    $npmLog = Join-Path $LogsDir "update_npm.log"
    $ok = Run-WithProgress -StartPct 60 -TargetPct 80 -Text "Installazione moduli npm..." -LogFile $npmLog -CommandLine "npm --prefix `"$FrontendDir`" install --prefer-offline --no-audit --no-fund"
    if (-not $ok) { return }

    $buildLog = Join-Path $LogsDir "update_build.log"
    $ok = Run-WithProgress -StartPct 80 -TargetPct 92 -Text "Compilazione bundle frontend..." -LogFile $buildLog -CommandLine "npm --prefix `"$FrontendDir`" run build"
    if (-not $ok) { return }

    Draw-Bar -Pct 96 -Text "Verifica integrita' backend..."
    $chkLog = Join-Path $LogsDir "update_check.log"
    $chkBat = Join-Path $LogsDir "_task_chk.bat"
    [System.IO.File]::WriteAllText($chkBat, "@echo off`r`ncd /d `"$RootDir`"`r`n`"$pythonExe`" -c `"import sys; sys.path.append('backend'); import app.main`" > `"$chkLog`" 2>&1", [System.Text.Encoding]::ASCII)
    $procChk = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$chkBat`"" -WorkingDirectory $RootDir -WindowStyle Hidden -Wait -PassThru
    Remove-Item $chkBat -Force -ErrorAction SilentlyContinue

    if ($procChk.ExitCode -ne 0) {
        Fail-Bar -Pct 96 -Text "Errore verifica integrita' backend"
        Write-Host "  $C_YELLOW`Dettagli errore da log ($chkLog):$C_RESET"
        if (Test-Path $chkLog) {
            Get-Content -Path $chkLog -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
        }
        Write-Host ""
        return
    }

    Finish-Bar "HiPlan aggiornato con successo!"
    Write-Host "  $C_GRAY`Per riavviare il server: seleziona 1 dal menu (start)$C_RESET"
    Write-Host ""
}

function Setup-HiPlan {
    param([switch]$IsNested)

    if (-not $IsNested) {
        Header "Configurazione Ambiente"
    }

    Advance-Bar -FromPct 0 -ToPct 15 -Text "Verifica Python 3 e Node.js..."
    $py = Find-Python
    if (-not $py) {
        Fail-Bar -Pct 15 -Text "Python 3.9+ non trovato nel sistema"
        Write-Host "  $C_YELLOW`Installa Python 3.9+ da python.org spuntando 'Add python.exe to PATH'.$C_RESET"
        return $false
    }
    $node = Find-Node
    if (-not $node) {
        Fail-Bar -Pct 15 -Text "Node.js non trovato nel sistema"
        Write-Host "  $C_YELLOW`Installa Node.js LTS da nodejs.org.$C_RESET"
        return $false
    }

    if (-not (Test-Path "$BackendDir\.env")) {
        if (Test-Path "$BackendDir\.env.example") {
            Copy-Item "$BackendDir\.env.example" "$BackendDir\.env"
        }
    }

    $pythonExe = Join-Path $BackendDir "venv\Scripts\python.exe"
    $setupLog = Join-Path $LogsDir "setup.log"

    Advance-Bar -FromPct 15 -ToPct 30 -Text "Creazione virtualenv Python..."
    if (-not (Test-PythonEnv $pythonExe)) {
        # Se esiste una cartella venv corrotta o parziale, la puliamo
        $venvDir = Join-Path $BackendDir "venv"
        if (Test-Path $venvDir) {
            Remove-Item $venvDir -Recurse -Force -ErrorAction SilentlyContinue
        }

        $vBat = Join-Path $LogsDir "_task_venv.bat"
        [System.IO.File]::WriteAllText($vBat, "@echo off`r`ncd /d `"$RootDir`"`r`n$py -m venv `"$BackendDir\venv`" > `"$setupLog`" 2>&1", [System.Text.Encoding]::ASCII)
        $procVenv = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$vBat`"" -WorkingDirectory $RootDir -WindowStyle Hidden -Wait -PassThru
        Remove-Item $vBat -Force -ErrorAction SilentlyContinue

        if ($procVenv.ExitCode -ne 0) {
            Fail-Bar -Pct 30 -Text "Errore creazione virtualenv Python"
            Write-Host "  $C_YELLOW`Dettagli errore da log ($setupLog):$C_RESET"
            if (Test-Path $setupLog) {
                Get-Content -Path $setupLog -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
            }
            Write-Host ""
            return $false
        }
    }

    $ok = Run-WithProgress -StartPct 30 -TargetPct 50 -Text "Aggiornamento pip e wheel..." -LogFile $setupLog -CommandLine "`"$pythonExe`" -m pip install --quiet --upgrade pip setuptools wheel"
    if (-not $ok) { return $false }

    $ok = Run-WithProgress -StartPct 50 -TargetPct 75 -Text "Installazione librerie Python..." -LogFile $setupLog -CommandLine "`"$pythonExe`" -m pip install --quiet -r `"$BackendDir\requirements.txt`""
    if (-not $ok) { return $false }

    $ok = Run-WithProgress -StartPct 75 -TargetPct 90 -Text "Installazione moduli npm..." -LogFile $setupLog -CommandLine "npm --prefix `"$FrontendDir`" install --prefer-offline --no-audit --no-fund"
    if (-not $ok) { return $false }

    $ok = Run-WithProgress -StartPct 90 -TargetPct 98 -Text "Compilazione bundle frontend..." -LogFile $setupLog -CommandLine "npm --prefix `"$FrontendDir`" run build"
    if (-not $ok) { return $false }

    Finish-Bar "Configurazione iniziale completata!"
    Write-Host "  $C_GRAY`Puoi avviare il server eseguendo l'opzione 1 dal menu (start)$C_RESET"
    Write-Host ""
    return $true
}

function Pause-Return {
    Write-Host ""
    Write-Host "Premi INVIO per tornare al menu principale..." -ForegroundColor DarkGray
    [void][Console]::ReadLine()
}

function Show-Help {
    Write-Host "Uso: hiplan.bat [start | stop | update | setup]"
    Write-Host ""
}

function Show-Menu {
    while ($true) {
        Clear-Host
        Write-Host ""
        Write-Host "$C_CYAN------------------------------------------------------------$C_RESET"
        Write-Host "  $C_BOLD${C_WHITE}HIPLAN$C_RESET  $C_GRAY|$C_RESET  $C_DIM`Pannello di Controllo$C_RESET"
        Write-Host "$C_CYAN------------------------------------------------------------$C_RESET"
        Write-Host ""
        Write-Host "  $C_CYAN 1$C_RESET)  $C_WHITE`Avvia Server$C_RESET       $C_GRAY(start)$C_RESET"
        Write-Host "  $C_CYAN 2$C_RESET)  $C_WHITE`Arresta Server$C_RESET     $C_GRAY(stop)$C_RESET"
        Write-Host "  $C_CYAN 3$C_RESET)  $C_WHITE`Aggiorna Sistema$C_RESET   $C_GRAY(update)$C_RESET"
        Write-Host "  $C_CYAN 4$C_RESET)  $C_WHITE`Configurazione$C_RESET     $C_GRAY(setup)$C_RESET"
        Write-Host "  $C_GRAY 0$C_RESET)  $C_GRAY`Esci$C_RESET"
        Write-Host ""
        Write-Host "$C_CYAN------------------------------------------------------------$C_RESET"
        Write-Host -NoNewline "  Scegli un'opzione [0-4]: "
        $choice = [Console]::ReadLine()
        if ($choice -ne $null) { $choice = $choice.Trim() } else { $choice = "" }

        switch ($choice.ToLower()) {
            "1"      { Start-HiPlan; Pause-Return }
            "start"  { Start-HiPlan; Pause-Return }
            "2"      { Stop-HiPlan; Pause-Return }
            "stop"   { Stop-HiPlan; Pause-Return }
            "3"      { Update-HiPlan; Pause-Return }
            "update" { Update-HiPlan; Pause-Return }
            "4"      { Setup-HiPlan; Pause-Return }
            "setup"  { Setup-HiPlan; Pause-Return }
            "0"      { exit 0 }
            "q"      { exit 0 }
            "exit"   { exit 0 }
            default  {
                Write-Host ""
                Write-Host "  $C_RED[!] Scelta non valida.$C_RESET"
                Start-Sleep -Seconds 1
            }
        }
    }
}

# Main Execution Dispatcher
try {
    $action = if ($env:HIPLAN_ACTION) { $env:HIPLAN_ACTION.Trim().ToLower().TrimStart('-') } else { "" }
    switch ($action) {
        "start"  { Start-HiPlan }
        "stop"   { Stop-HiPlan }
        "update" { Update-HiPlan }
        "setup"  { Setup-HiPlan }
        "help"   { Show-Help }
        "h"      { Show-Help }
        ""       { Show-Menu }
        default  {
            Write-Host "Opzione non riconosciuta: $action" -ForegroundColor Red
            Write-Host "Uso: hiplan.bat [start | stop | update | setup]"
            exit 1
        }
    }
} catch {
    Write-Host ""
    Write-Host "  $C_RED[!] Errore imprevisto durante l'esecuzione:$C_RESET"
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "Premi INVIO per uscire..." -ForegroundColor DarkGray
    [void][Console]::ReadLine()
    exit 1
}
