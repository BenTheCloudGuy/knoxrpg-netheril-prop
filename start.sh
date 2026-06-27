#!/bin/bash
# Start Netheril App — launches server + Firefox kiosk on monitor

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
URL="http://localhost:3000"
PID_FILE="/tmp/netheril-app.pid"

# Check if already running via PID file
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Netheril app is already running (PID $(cat "$PID_FILE"))"
  exit 1
fi

# Pre-flight: ensure ports 3000/3001 are free (clear stale orphans)
if ss -lnt 2>/dev/null | grep -qE ':(3000|3001)\b'; then
  echo "Port 3000 or 3001 is in use by another process. Attempting to clear..."
  sudo pkill -f "node src/server.js" 2>/dev/null || true
  sleep 1
  if ss -lnt 2>/dev/null | grep -qE ':(3000|3001)\b'; then
    echo "ERROR: ports 3000/3001 still in use. Run ./stop.sh or kill the process manually."
    exit 1
  fi
fi

# Start the server
cd "$APP_DIR"
sudo node src/server.js &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for server to be ready
for i in {1..30}; do
  if curl -s -o /dev/null "$URL" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

# Launch Firefox in kiosk mode
DISPLAY=:0 firefox --kiosk "$URL" --new-instance --no-remote 2>/dev/null &
FIREFOX_PID=$!

echo "Netheril app started"
echo "  Server PID: $SERVER_PID"
echo "  Firefox PID: $FIREFOX_PID"
echo ""
echo "  Player (kiosk): http://localhost:3000"
echo "  GM Console:     http://localhost:3001"
echo ""
echo "Run ./stop.sh to quit"
