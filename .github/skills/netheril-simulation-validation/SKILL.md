---
name: netheril-simulation-validation
description: "Safely validate Netheril server, WebSocket, API, crystal lifecycle, player kiosk, and GM console changes without Raspberry Pi hardware. Use for SIM_MODE testing, regression checks, browser verification, or pre-deployment validation."
argument-hint: "Describe the changed behavior or files to validate"
user-invocable: true
---

# Netheril Simulation Validation

Use this workflow for development checks that must not initialize serial devices or GPIO.

## Safety Rules

- Run all commands from the repository root.
- Always set `SIM_MODE=true` before starting `src/server.js`.
- Do not use `npm start` or `start.sh`; both enter production hardware mode and use `sudo`.
- Do not call `/api/restart`, `/api/reboot`, `/api/shutdown`, or `/api/update` during validation.
- If ports 3000 or 3001 are occupied, identify the existing process instead of killing it blindly.

## Procedure

1. Run focused static checks:

   ```bash
   node --check src/server.js
   node -e 'const fs=require("fs"),vm=require("vm"); for (const file of ["src/public/index.html","src/public-gm/index.html","dev/index.html"]) { const html=fs.readFileSync(file,"utf8"); for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1],{filename:file}); } console.log("Inline scripts parse");'
   ```

2. Check whether `3000` or `3001` is already listening. Reuse a known simulation server or ask before disturbing an unknown process.

3. Start `SIM_MODE=true node src/server.js` from the repository root. Confirm logs identify simulation mode and both URLs.

4. Confirm `GET http://localhost:3001/api/sim/status` returns `simMode: true` and the configured crystal list.

5. Exercise a known crystal lifecycle:

   ```bash
   curl -s -H 'Content-Type: application/json' -d '{"hex":"00000C0E"}' http://localhost:3001/api/sim/crystal
   curl -s http://localhost:3000/api/page/conjuration/top
   curl -s -X POST http://localhost:3001/api/sim/crystal-remove
   ```

6. For player changes, use a browser to verify: landing visible before insert; direct cross menu after insert; page open/close; return to landing after removal; no console errors; reconnect restores current crystal state.

7. For GM changes, verify the touched CRUD or SSE behavior on port 3001. Avoid writes to real content/config unless the change specifically concerns persistence; restore only test data created during this workflow.

8. Stop only the simulation process started for this check.

## Reporting

State separately which checks passed:

- JavaScript syntax
- HTTP API behavior
- WebSocket/state transitions
- Desktop and narrow browser rendering
- Physical RFID, motion sensor, LEDs, systemd, and kiosk boot (normally not tested here)