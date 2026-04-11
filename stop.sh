#!/bin/bash
# Stop Netheril App — kills server + Firefox

PID_FILE="/tmp/netheril-app.pid"

# Kill the server
if [[ -f "$PID_FILE" ]]; then
  SERVER_PID=$(cat "$PID_FILE")
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    sudo kill "$SERVER_PID" 2>/dev/null
    echo "Server stopped (PID $SERVER_PID)"
  else
    echo "Server was not running"
  fi
  rm -f "$PID_FILE"
else
  # Fallback: kill by name
  sudo pkill -f "node src/server.js" 2>/dev/null
  echo "Server stopped"
fi

# Kill Firefox kiosk
pkill -f "firefox.*--kiosk" 2>/dev/null
echo "Firefox stopped"
echo "Netheril app closed"
