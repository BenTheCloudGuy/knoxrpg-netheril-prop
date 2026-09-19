---
name: netheril-pi-deployment
description: "Review, install, troubleshoot, or update the Netheril Raspberry Pi deployment. Use for systemd services, Firefox kiosk boot, serial/GPIO permissions, install-service.sh, start/stop scripts, journalctl logs, hardcoded paths, updates, restart, or Pi operations."
argument-hint: "Describe the deployment symptom or intended Pi operation"
user-invocable: true
---

# Netheril Raspberry Pi Deployment

Use this workflow for deliberate on-device operations. Production actions can interrupt a live prop or power off the host.

## Known Deployment Shape

- `netheril.service` runs `/usr/bin/node src/server.js` as root and restarts on failure.
- `netheril-kiosk.service` runs Firefox as `benthebuilder` on `DISPLAY=:0`, waits for port 3000, requires the server, and is part of its lifecycle.
- `install-service.sh` copies both units to `/etc/systemd/system`, reloads systemd, and enables them.
- GM logs stream `journalctl -u netheril`; GM update runs `git pull` then `npm install --production`.

## Critical Preflight

1. Confirm the actual repository path with `pwd`.
2. Compare it with `WorkingDirectory` in `netheril.service`. This checkout is named `knoxrpg-netheril-dungeon-runner`, but the committed unit currently points to `/home/benthebuilder/knoxrpg-netheril-prop`.
3. Confirm `/usr/bin/node`, `/usr/bin/firefox`, user `benthebuilder`, and `DISPLAY=:0` are correct for the target Pi.
4. Confirm `/dev/serial0`, optional `/dev/ttyACM0`, and GPIO 18 are connected as expected.
5. Run `node --check src/server.js` and simulation validation before touching the installed service.

## Procedure

1. Read all of `netheril.service`, `netheril-kiosk.service`, `install-service.sh`, `start.sh`, and `stop.sh`; keep their two different launch models distinct.
2. For a service edit, validate unit syntax with `systemd-analyze verify` when available before installation.
3. Explain the exact elevated commands and impact before running `sudo`, systemctl, reboot, shutdown, or overwriting installed units.
4. After installation/restart, check both service statuses and `journalctl -u netheril -n 100 --no-pager`.
5. Verify HTTP readiness on ports 3000 and 3001, then verify the Firefox kiosk on the physical display.
6. Test RFID insertion/removal and LED cleanup. Test the motion sensor separately because the player UI no longer depends on hand events.
7. On failure, diagnose from the first concrete error: path, executable, dependency install, port conflict, serial permission/device, GPIO initialization, display/session, or network readiness.

## Safety Boundaries

- Never assume the committed hardcoded path is correct for another installation.
- Do not run elevated or power-control commands without explicit user approval.
- Do not weaken service isolation or change the service user casually; root currently provides hardware access.
- Do not report a successful deployment from simulation alone.

## Reporting

Include the installed path, service status, port checks, kiosk result, RFID/LED/motion results, log errors, and any action still requiring physical access.