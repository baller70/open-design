---
name: visual-validation
description: Render the current HTML artifact, compare it with project reference screenshots, and feed a conservative visual-quality score into the devloop.
od:
  scenario: new-generation
  mode: critique
---

# Visual validation

This atom gives the critique loop one piece of evidence the code-only path
cannot: what the generated artifact actually looks like when rendered in a
browser.

## Inputs

- The project's current HTML entry file (`index.html` when present, otherwise
  the first root HTML file).
- One or more project-local reference screenshots. The daemon auto-detects
  PNG screenshots with common names such as `reference*.png`,
  `spec*.png`, `baseline*.png`, and images under `reference/`,
  `references/`, or `spec/`.

## Output

```text
project-cwd/
└── critique/
    └── visual-validation/
        ├── report.json   # structured result with similarity %, diff ratio, regions, and suggestions
        ├── summary.md    # short human-readable summary
        ├── *.actual.png  # rendered artifact screenshot(s)
        └── *.diff.png    # highlighted pixel-diff overlay(s)
```

## Signals

- `critique.score` — conservative visual score derived from similarity:
  - `5` for >= 98%
  - `4` for >= 95%
  - `3` for >= 88%
  - `2` for >= 78%
  - `1` otherwise
- `preview.ok` — `true` when the page rendered successfully, `false` when the
  browser render failed.

Because the stage runner merges scores pessimistically, a weak visual match can
hold the critique loop open even when the language-model critique is satisfied.

## Guidance

- Use the diff images and highlighted regions as concrete evidence. Do not hand
  wave about "maybe the spacing is off" when the overlay already shows where it
  drifted.
- Fix global breakpoint, spacing, and token mismatches before micro-polish.
- If no reference screenshot exists, the atom skips cleanly instead of inventing
  a baseline.
