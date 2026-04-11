# Netheril App

## Background Colors

The page uses a layered clay/sandstone texture:

| Layer | Value | Description |
|-------|-------|-------------|
| Base color | `#9a7b4a` | Golden-brown clay base |
| Linear gradient | `#b89968` → `#a0824e` → `#8b6f3c` → `#a08050` | 160° warm gradient |
| Radial highlight | `#c4a87a` at 30% 20% | Light sandy hotspot |
| Radial shadow | `#a08055` at 70% 80% | Darker clay shadow |
| Noise texture | `rgba(0,0,0,0.02)` repeating-conic-gradient 4×4px | Subtle grain |

## Crystal Glow Colors

| Crystal | Glow Color | CSS rgba |
|---------|-----------|----------|
| Blue | Light blue | `rgba(79, 195, 247, 0.5)` |
| Purple | Light purple | `rgba(206, 147, 216, 0.5)` |
| Green | Light green | `rgba(129, 199, 132, 0.5)` |
| Red | Red | `rgba(239, 83, 80, 0.5)` |

## Glyph Text Colors

| State | Color | Value |
|-------|-------|-------|
| Inactive | Transparent | `color: transparent` |
| Active | Dark brown | `rgba(60, 42, 20, 0.9)` |
| Wrong answer | Dark red | `rgba(180, 40, 30, 0.8)` with `rgba(239, 83, 80, 0.8)` glow |

## LED Ring Colors (server.js)

| Crystal | Hex | Color |
|---------|-----|-------|
| Blue | `0x0000FF` | Blue |
| Purple | `0x8000FF` | Purple |
| Green | `0x00FF00` | Green |
| Red | `0xFF0000` | Red |
| Unknown | `0x333333` | Dim white/grey |
