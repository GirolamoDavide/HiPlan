#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"

BACKEND_PID=""
FRONTEND_PID=""

# Colori e Stili ANSI (look moderno e minimale)
C_RESET=$'\033[0m'
C_BOLD=$'\033[1m'
C_DIM=$'\033[2m'
C_RED=$'\033[91m'
C_GREEN=$'\033[92m'
C_YELLOW=$'\033[93m'
C_CYAN=$'\033[96m'
C_WHITE=$'\033[97m'
C_GRAY=$'\033[90m'

unset DEBUG

# Rilevazione percorso python nel virtualenv (compatibile macOS, Linux e Windows/Git Bash)
get_venv_python() {
  if [[ -x "$BACKEND_DIR/venv/Scripts/python.exe" || -f "$BACKEND_DIR/venv/Scripts/python.exe" ]]; then
    echo "$BACKEND_DIR/venv/Scripts/python.exe"
  elif [[ -x "$BACKEND_DIR/venv/Scripts/python" || -f "$BACKEND_DIR/venv/Scripts/python" ]]; then
    echo "$BACKEND_DIR/venv/Scripts/python"
  elif [[ -x "$BACKEND_DIR/venv/bin/python" || -f "$BACKEND_DIR/venv/bin/python" ]]; then
    echo "$BACKEND_DIR/venv/bin/python"
  elif [[ -x "$BACKEND_DIR/venv/bin/python3" || -f "$BACKEND_DIR/venv/bin/python3" ]]; then
    echo "$BACKEND_DIR/venv/bin/python3"
  else
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" || -n "${WINDIR:-}" ]]; then
      echo "$BACKEND_DIR/venv/Scripts/python.exe"
    else
      echo "$BACKEND_DIR/venv/bin/python"
    fi
  fi
}

venv_python_valid() {
  local py
  py="$(get_venv_python)"
  if [[ -f "$py" || -x "$py" ]]; then
    "$py" -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >/dev/null 2>&1
  else
    return 1
  fi
}

# Rilevazione interprete Python di sistema per creare venv
get_sys_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo "python3"
  elif command -v python >/dev/null 2>&1; then
    echo "python"
  elif command -v py >/dev/null 2>&1; then
    echo "py -3"
  else
    echo "python3"
  fi
}

# Barra di caricamento moderna, compatta
draw_bar() {
  local pct="$1"
  local text="$2"
  local w=16
  local f=$(( pct * w / 100 ))
  local e=$(( w - f ))
  local f_s=""
  local e_s=""
  for ((i=0; i<f; i++)); do f_s+="█"; done
  for ((i=0; i<e; i++)); do e_s+="░"; done
  printf "\r\033[K  ${C_GRAY}[${C_CYAN}%s${C_GRAY}%s]${C_RESET} ${C_WHITE}%3d%%${C_RESET}  ${C_GRAY}%-26s${C_RESET}" \
    "$f_s" "$e_s" "$pct" "$text"
}

advance_bar() {
  local from_pct="$1"
  local to_pct="$2"
  local text="$3"
  local step=1
  if (( to_pct - from_pct > 25 )); then step=2; fi
  for ((p=from_pct; p<=to_pct; p+=step)); do
    draw_bar "$p" "$text"
    sleep 0.012
  done
  draw_bar "$to_pct" "$text"
}

run_with_progress() {
  local start_pct="$1"
  local target_pct="$2"
  local text="$3"
  local log_file="$4"
  shift 4

  rm -f "$log_file" 2>/dev/null || true

  ("$@" > "$log_file" 2>&1) &
  local pid=$!
  local cur=$start_pct

  draw_bar "$cur" "$text"
  while kill -0 "$pid" 2>/dev/null; do
    if (( cur < target_pct - 1 )); then
      cur=$(( cur + 1 ))
      draw_bar "$cur" "$text"
    fi
    sleep 0.15
  done

  wait "$pid"
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    fail_bar "$cur" "$text (errore)"
    echo "  ${C_YELLOW}Dettagli errore da log:${C_RESET}"
    if [[ -f "$log_file" ]]; then
      tail -n 12 "$log_file" | sed 's/^/    /' || true
    fi
    echo
    return $rc
  fi
  draw_bar "$target_pct" "$text"
  return 0
}

finish_bar() {
  local text="$1"
  local w=16
  local f_s=""
  for ((i=0; i<w; i++)); do f_s+="█"; done
  printf "\r\033[K  ${C_GRAY}[${C_GREEN}%s${C_GRAY}]${C_RESET} ${C_BOLD}${C_GREEN}100%%${C_RESET}  ${C_BOLD}${C_GREEN}[OK] %s${C_RESET}\n\n" \
    "$f_s" "$text"
}

fail_bar() {
  local pct="$1"
  local text="$2"
  local w=16
  local f=$(( pct * w / 100 ))
  local e=$(( w - f ))
  local f_s=""
  local e_s=""
  for ((i=0; i<f; i++)); do f_s+="█"; done
  for ((i=0; i<e; i++)); do e_s+="░"; done
  printf "\r\033[K  ${C_GRAY}[${C_RED}%s${C_GRAY}%s]${C_RESET} ${C_BOLD}${C_RED}%3d%%${C_RESET}  ${C_BOLD}${C_RED}[ERRORE] %s${C_RESET}\n\n" \
    "$f_s" "$e_s" "$pct" "$text"
}

local_ip() {
  local ip=""
  if command -v ipconfig >/dev/null 2>&1; then
    local iface
    iface="$(route get default 2>/dev/null | awk '/interface:/{print $2; exit}')" || true
    if [[ -n "$iface" ]]; then
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null)" || true
    fi
  fi
  if [[ -z "$ip" ]] && command -v powershell.exe >/dev/null 2>&1; then
    ip="$(powershell.exe -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { \$_.IPv4DefaultGateway -and \$_.NetAdapter.Status -eq 'Up' } | ForEach-Object { \$_.IPv4Address.IPAddress } | Select-Object -First 1)" 2>/dev/null | tr -d '\r')" || true
  fi
  if [[ -z "$ip" ]] && command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')" || true
  fi
  echo "$ip"
}

port_is_busy() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ano 2>/dev/null | grep -E ":$port\s+.*LISTENING" >/dev/null 2>&1
  else
    return 1
  fi
}

cleanup_processes() {
  [[ -n "$BACKEND_PID" ]] && kill "$BACKEND_PID" 2>/dev/null || true
  [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null || true

  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:8000 2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null || true
  fi

  if command -v pkill >/dev/null 2>&1; then
    pkill -9 -f "uvicorn app.main:app" 2>/dev/null || true
    pkill -9 -f "vite.*5173" 2>/dev/null || true
  fi

  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //IM uvicorn.exe 2>/dev/null || true
    local pids
    pids=$(netstat -ano 2>/dev/null | awk '/:8000.*LISTENING|:5173.*LISTENING/{print $NF}' | tr -d '\r')
    for pid in $pids; do
      if [[ -n "$pid" && "$pid" =~ ^[0-9]+$ && "$pid" -gt 0 ]]; then
        taskkill //F //PID "$pid" 2>/dev/null || true
      fi
    done
  fi
}

open_browser() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url" 2>/dev/null || true
  elif command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "$url" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" 2>/dev/null || true
  elif command -v start >/dev/null 2>&1; then
    start "$url" 2>/dev/null || true
  fi
}

pause_return() {
  echo
  read -rp "Premi INVIO per tornare al menu principale..." dummy || true
}

header() {
  local title="$1"
  echo
  echo "${C_CYAN}------------------------------------------------------------${C_RESET}"
  echo "  ${C_BOLD}${C_WHITE}HIPLAN${C_RESET}  ${C_GRAY}|${C_RESET}  ${C_WHITE}${title}${C_RESET}"
  echo "${C_CYAN}------------------------------------------------------------${C_RESET}"
  echo
}

# ============================================================
# AZIONE: START
# ============================================================
do_start() {
  header "Avvio Sistema"

  if ! venv_python_valid || [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    echo "  ${C_YELLOW}[i] Installazione incompleta o virtualenv da aggiornare: avvio setup...${C_RESET}"
    echo
    do_setup
  fi

  local py_bin
  py_bin="$(get_venv_python)"

  advance_bar 0 15 "Controllo porte di rete..."
  if port_is_busy 8000 || port_is_busy 5173; then
    advance_bar 15 25 "Rilascio porte occupate..."
    cleanup_processes
    sleep 1
    if port_is_busy 8000 || port_is_busy 5173; then
      fail_bar 25 "Porta 8000 o 5173 occupata da altra app"
      exit 1
    fi
  fi
  advance_bar 25 35 "Porte 8000 e 5173 pronte"

  trap cleanup_processes EXIT INT TERM

  draw_bar 40 "Avvio Backend API..."
  (
    cd "$BACKEND_DIR"
    exec "$py_bin" -m uvicorn app.main:app \
      --host 0.0.0.0 --port 8000 --log-level info --reload --reload-dir "$BACKEND_DIR/app"
  ) >"$LOG_DIR/backend_app.log" 2>&1 &
  BACKEND_PID=$!
  advance_bar 40 50 "Backend API avviato"

  draw_bar 55 "Avvio Frontend Vite..."
  (
    cd "$FRONTEND_DIR"
    exec npm run dev -- --host 0.0.0.0 --port 5173
  ) >"$LOG_DIR/frontend_app.log" 2>&1 &
  FRONTEND_PID=$!
  advance_bar 55 65 "Frontend Web avviato"

  local ready=0
  for ((i=1; i<=40; i++)); do
    local pct=$(( 65 + (i * 30 / 40) ))
    draw_bar "$pct" "Attesa risposta HTTP ($i s)..."
    if curl -fsS "http://127.0.0.1:8000/api/health" >/dev/null 2>&1 &&
       curl -fsS "http://127.0.0.1:5173" >/dev/null 2>&1; then
      ready=1
      break
    fi
    if ! kill -0 "$BACKEND_PID" 2>/dev/null || ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if [[ "$ready" -ne 1 ]]; then
    fail_bar 75 "I servizi non rispondono in tempo"
    echo "  ${C_YELLOW}Dettagli log:${C_RESET}"
    echo "    - $LOG_DIR/backend_app.log"
    echo "    - $LOG_DIR/frontend_app.log"
    exit 1
  fi

  finish_bar "Server avviato e sincronizzato!"

  local ip
  ip="$(local_ip)"
  open_browser "http://localhost:5173"

  echo "${C_GREEN}------------------------------------------------------------${C_RESET}"
  echo "  ${C_BOLD}${C_WHITE}PUNTI DI ACCESSO HIPLAN${C_RESET}"
  echo "${C_GREEN}------------------------------------------------------------${C_RESET}"
  echo "  ${C_GREEN}>${C_RESET}  Questo PC/Mac:   ${C_CYAN}${C_BOLD}http://localhost:5173${C_RESET}"
  if [[ -n "$ip" ]]; then
    echo "  ${C_GREEN}>${C_RESET}  Rete Locale:     ${C_CYAN}${C_BOLD}http://${ip}:5173${C_RESET}"
  fi
  echo "  ${C_GREEN}>${C_RESET}  Documentazione:  ${C_GRAY}http://localhost:8000/docs${C_RESET}"
  echo "${C_GREEN}------------------------------------------------------------${C_RESET}"
  echo "  ${C_GRAY}I servizi sono attivi. Premi CTRL+C per arrestarli.${C_RESET}"
  echo

  wait "$BACKEND_PID" "$FRONTEND_PID"
}

# ============================================================
# AZIONE: STOP
# ============================================================
do_stop() {
  header "Arresto Servizi"
  advance_bar 0 30 "Chiusura Backend API..."
  cleanup_processes
  advance_bar 30 70 "Chiusura Frontend Web..."
  advance_bar 70 95 "Pulizia processi residui..."
  finish_bar "Tutti i servizi HiPlan sono stati arrestati!"
}

# ============================================================
# AZIONE: UPDATE
# ============================================================
do_update() {
  header "Aggiornamento HiPlan"

  if ! venv_python_valid || [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    echo "  ${C_YELLOW}[i] Ambiente non configurato o non valido: avvio setup...${C_RESET}"
    echo
    do_setup
    return 0
  fi

  local py_bin
  py_bin="$(get_venv_python)"

  if [[ ! -f "$BACKEND_DIR/.env" && -f "$BACKEND_DIR/.env.example" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
  fi

  advance_bar 0 15 "Arresto servizi attivi..."
  cleanup_processes

  advance_bar 15 25 "Backup di sicurezza database..."
  "$py_bin" -c "import sys; sys.path.append('backend'); from app.services.backup_service import run_backup; run_backup()" > "$LOG_DIR/backup.log" 2>&1 || {
    echo "  ${C_YELLOW}[!] Nota: Backup preventivo non eseguito o database non ancora presente.${C_RESET}"
  }

  run_with_progress 25 40 "Aggiornamento pip e wheel..." "$LOG_DIR/update_pip.log" \
    "$py_bin" -m pip install --quiet --upgrade pip setuptools wheel

  run_with_progress 40 60 "Aggiornamento librerie Python..." "$LOG_DIR/update_pip.log" \
    "$py_bin" -m pip install --quiet -r "$BACKEND_DIR/requirements.txt"

  run_with_progress 60 80 "Installazione moduli npm..." "$LOG_DIR/update_npm.log" \
    npm --prefix "$FRONTEND_DIR" install --prefer-offline --no-audit --no-fund

  run_with_progress 80 92 "Compilazione bundle frontend..." "$LOG_DIR/update_build.log" \
    npm --prefix "$FRONTEND_DIR" run build

  draw_bar 96 "Verifica integrita' backend..."
  "$py_bin" -c "import sys; sys.path.append('backend'); import app.main" > "$LOG_DIR/update_check.log" 2>&1

  finish_bar "HiPlan aggiornato con successo!"
  echo "  ${C_GRAY}Per riavviare il server: seleziona 1 dal menu (start)${C_RESET}"
  echo
}

# ============================================================
# AZIONE: SETUP
# ============================================================
do_setup() {
  header "Configurazione Ambiente"

  advance_bar 0 15 "Verifica Python 3 e Node.js..."
  local sys_py
  sys_py="$(get_sys_python)"
  if ! command -v "$sys_py" >/dev/null 2>&1; then
    fail_bar 15 "Python 3 non trovato nel sistema"
    exit 1
  fi
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    fail_bar 15 "Node.js o npm non trovati"
    exit 1
  fi

  if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
  fi

  advance_bar 15 30 "Creazione virtualenv Python..."
  if ! venv_python_valid; then
    rm -rf "$BACKEND_DIR/venv" 2>/dev/null || true
    "$sys_py" -m venv "$BACKEND_DIR/venv" > "$LOG_DIR/setup.log" 2>&1
  fi

  local py_bin
  py_bin="$(get_venv_python)"

  run_with_progress 30 45 "Aggiornamento pip e wheel..." "$LOG_DIR/setup.log" \
    "$py_bin" -m pip install --quiet --upgrade pip setuptools wheel

  run_with_progress 45 70 "Installazione librerie Python..." "$LOG_DIR/setup.log" \
    "$py_bin" -m pip install --quiet -r "$BACKEND_DIR/requirements.txt"

  run_with_progress 70 85 "Installazione pacchetti npm..." "$LOG_DIR/setup.log" \
    npm --prefix "$FRONTEND_DIR" install --prefer-offline --no-audit --no-fund

  run_with_progress 85 95 "Compilazione frontend Vite..." "$LOG_DIR/setup.log" \
    npm --prefix "$FRONTEND_DIR" run build

  finish_bar "Configurazione iniziale completata!"
  echo "  ${C_GRAY}Puoi avviare il server eseguendo l'opzione 1 (start)${C_RESET}"
  echo
}

# ============================================================
# MENU INTERATTIVO
# ============================================================
show_menu() {
  while true; do
    clear 2>/dev/null || true
    echo
    echo "${C_CYAN}------------------------------------------------------------${C_RESET}"
    echo "  ${C_BOLD}${C_WHITE}HIPLAN${C_RESET}  ${C_GRAY}|${C_RESET}  ${C_DIM}Pannello di Controllo${C_RESET}"
    echo "${C_CYAN}------------------------------------------------------------${C_RESET}"
    echo
    echo "  ${C_CYAN}1${C_RESET})  ${C_WHITE}Avvia Server${C_RESET}       ${C_GRAY}(start)${C_RESET}"
    echo "  ${C_CYAN}2${C_RESET})  ${C_WHITE}Arresta Server${C_RESET}     ${C_GRAY}(stop)${C_RESET}"
    echo "  ${C_CYAN}3${C_RESET})  ${C_WHITE}Aggiorna Sistema${C_RESET}   ${C_GRAY}(update)${C_RESET}"
    echo "  ${C_CYAN}4${C_RESET})  ${C_WHITE}Configurazione${C_RESET}     ${C_GRAY}(setup)${C_RESET}"
    echo "  ${C_GRAY}0${C_RESET})  ${C_GRAY}Esci${C_RESET}"
    echo
    echo "${C_CYAN}------------------------------------------------------------${C_RESET}"
    printf "  Scegli un'opzione [0-4]: "
    read -r choice || break
    echo
    case "$choice" in
      1|start|START)   do_start ;;
      2|stop|STOP)     do_stop; pause_return ;;
      3|update|UPDATE) do_update; pause_return ;;
      4|setup|SETUP)   do_setup; pause_return ;;
      0|q|Q|exit|EXIT) exit 0 ;;
      *) echo "  ${C_RED}[!] Scelta non valida.${C_RESET}"; sleep 1 ;;
    esac
  done
}

# Dispatcher argomenti o menu
CMD="${1:-}"
case "$CMD" in
  start|--start)   do_start ;;
  stop|--stop)     do_stop ;;
  update|--update) do_update ;;
  setup|--setup)   do_setup ;;
  help|--help|-h)
    echo "Uso: ./hiplan.sh [start | stop | update | setup]"
    exit 0
    ;;
  "") show_menu ;;
  *)
    echo "Opzione non riconosciuta: $CMD"
    echo "Uso: ./hiplan.sh [start | stop | update | setup]"
    exit 1
    ;;
esac
