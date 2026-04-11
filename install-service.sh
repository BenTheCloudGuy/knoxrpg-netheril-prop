#!/bin/bash
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Netheril Prop — Service Installer ==="
echo ""

# Copy service files
sudo cp "$APP_DIR/netheril.service" /etc/systemd/system/netheril.service
sudo cp "$APP_DIR/netheril-kiosk.service" /etc/systemd/system/netheril-kiosk.service

# Reload systemd
sudo systemctl daemon-reload

# Enable on boot
sudo systemctl enable netheril.service
sudo systemctl enable netheril-kiosk.service

echo ""
echo "Services installed and enabled."
echo ""
echo "Commands:"
echo "  sudo systemctl start netheril        # Start server"
echo "  sudo systemctl start netheril-kiosk   # Start kiosk"
echo "  sudo systemctl stop netheril          # Stop server + kiosk"
echo "  sudo systemctl restart netheril       # Restart server"
echo "  sudo systemctl status netheril        # Check status"
echo "  journalctl -u netheril -f             # View logs"
echo ""
echo "Both services will auto-start on boot."
echo "The server will auto-restart if it crashes."
