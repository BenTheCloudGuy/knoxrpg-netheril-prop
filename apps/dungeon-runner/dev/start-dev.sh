#!/bin/bash
# Start Netheril in simulation mode (no hardware required)
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

export SIM_MODE=true

echo "Starting Netheril in simulation mode..."
node src/server.js
