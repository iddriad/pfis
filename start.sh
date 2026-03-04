#!/bin/bash
# ═══════════════════════════════════════════════
#  PFIS — Predictive Fraud Intelligence System
#  Start Script — runs ML service + Node server
# ═══════════════════════════════════════════════
set -e
cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║  Predictive Fraud Intelligence System (PFIS) ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# ── Check dependencies ──────────────────────────
echo "▶ Checking dependencies..."
command -v node    &>/dev/null || { echo "❌ Node.js not found: sudo apt install nodejs"; exit 1; }
command -v python3 &>/dev/null || { echo "❌ Python3 not found: sudo apt install python3"; exit 1; }
command -v pip3    &>/dev/null || { echo "❌ pip3 not found: sudo apt install python3-pip"; exit 1; }

echo "▶ Checking Python packages..."
python3 -c "import sklearn, flask, numpy" 2>/dev/null || {
  echo "▶ Installing Python packages (first run only)..."
  pip3 install scikit-learn flask numpy --break-system-packages -q
}

[ -d "node_modules" ] || { echo "▶ Installing Node packages..."; npm install --silent; }

# ── Clear ports ─────────────────────────────────
echo "▶ Clearing ports 3000 and 5001..."
fuser -k 3000/tcp 2>/dev/null || true
fuser -k 5001/tcp 2>/dev/null || true
sleep 1

# ── Start ML service ─────────────────────────────
echo "▶ Starting ML service on port 5001..."
python3 ml_service.py > ml_service.log 2>&1 &
ML_PID=$!

echo "▶ Waiting for ML models to bootstrap..."
for i in $(seq 1 30); do
  sleep 1
  curl -s http://localhost:5001/health &>/dev/null && { echo "  ✅ ML service ready."; break; }
  echo "  ... ($i/30)"
done

# ── Start Node server ────────────────────────────
echo "▶ Starting Node server on port 3000..."
node server.js &
NODE_PID=$!
sleep 1

echo ""
echo "════════════════════════════════════════════════"
echo "  ✅  PFIS is running!"
echo "  Open:    http://localhost:3000"
echo "  SMS sim: Use 'Sim YES/NO' buttons on monitor"
echo ""
echo "  For real SMS, set env vars before running:"
echo "  AT_API_KEY=your_key AT_USERNAME=your_user bash start.sh"
echo "════════════════════════════════════════════════"
echo ""
echo "  Press Ctrl+C to stop everything."
echo ""

trap "echo ''; echo 'Stopping PFIS...'; kill $ML_PID $NODE_PID 2>/dev/null; exit 0" SIGINT SIGTERM
wait $NODE_PID
