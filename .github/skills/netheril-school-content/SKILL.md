---
name: netheril-school-content
description: "Create, edit, audit, or reorganize Netheril school-of-magic clue pages. Use for crystal content, D&D clues, the 32 directional Markdown files, GM school editor content, titles, or Markdown renderer compatibility."
argument-hint: "Name the school, direction, encounter, clue, or content goal"
user-invocable: true
---

# Netheril School Content

Use this workflow for player-facing clue content in `src/public/pages/`.

## Content Matrix

Every school has exactly four locations: `top`, `bottom`, `left`, and `right`.

| School | Crystal color |
| --- | --- |
| abjuration | white |
| conjuration | blue |
| divination | yellow |
| enchantment | pink |
| evocation | red |
| illusion | orange |
| necromancy | black |
| transmutation | green |

Files are named `<school>_<location>.md`. Preserve all 32 combinations even when a page is intentionally brief.

## Procedure

1. Read the requested page, the other three pages for that school, and one nearby school page to learn the current voice and structure.
2. Inspect `renderMarkdown()` in `src/public/index.html` before using syntax not already present. This is a local subset renderer, not full CommonMark.
3. Write concise, table-readable clues. Favor scannable headings, short paragraphs, and short lists over long lore dumps.
4. Keep clues actionable for live play: reveal a weakness, warning, command word, pattern, location, cost, or tradeoff without accidentally giving away unrelated encounters.
5. Keep the content below the GM API's 50,000-character cap and avoid raw HTML or scripts.
6. Run the inline-script syntax check only if renderer code changed. For content-only edits, fetch the page in simulation mode or inspect it through the player UI.
7. Check the rendered page at 1920x1080 and a narrow viewport for overflow, unsupported markup, and overly long unbroken words.

## Boundaries

- `config/{blue,green,purple,red,translation}.md`, `5eItems.md`, and `notes.md` are references, not live school pages.
- Do not change a crystal's color/school assignment to make content fit; update `config/config.yaml` only when the crystal registry itself is part of the request.
- Do not invent mini-game runtime behavior while editing clue prose. A clue may describe a puzzle only if the requested experience is content-driven.

## Reporting

List the school/location pages changed, summarize player-facing information revealed, and identify any content that requires DM confirmation.