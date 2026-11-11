# OmD review — round 1

**Date:** 2026-11-11
**Artifacts:** `design/preview/*.html`, `styles.css`, `app.js`
**DESIGN.md:** `DESIGN.md` (re-read for this round)
**Viewports:** 1440×900 and 390×844 (render-check also 360)
**Tools:** headless Chromium via playwright-core 1.58; `hangul` check, copy-check and render-check; `omd-restraint` audit.mjs; a token-pair contrast script. `omd check contrast` (the pixel-based tool) was not available, so contrast below is nominal token-pair contrast, not measured against rendered pixels.

## Summary

| Check | Result |
|---|---|
| hangul typography (`check.mjs`) | 0 BLOCK · 0 WARN · 0 FYI |
| hangul copy (`copy-check.mjs`) | 0 BLOCK · 0 WARN · 4 FYI (kept, reasons below) |
| hangul rendered breaks (`render-check.mjs`) | 0 broken Korean words on all 9 pages at 360/390/1440 |
| Page-level horizontal scroll | none at 390 or 1440 |
| Console errors | none |
| Slop gates (grep-verifiable) | G6 0 · G7 0 · G10 0 · G28 0 · G39 0 · G48 0 · inline styles 0 |
| Token contrast | all text pairs ≥ 4.5:1; control boundary 3.3:1 after the fix |
| Restraint | app screens are out of scope for R2/R4/R5/R6/R8 (skill scope); R1/R7/R9 findings handled below |

**Verdict:** PASS (BLOCK = 0, WARN = 0 after fixes).

## Issues found and fixed in this round

### [BLOCK → RESOLVED] Control boundary contrast below 3:1
- **Location:** `styles.css` `--line-strong`
- **Rule:** designer-review § Text contrast. Required UI boundaries need at least 3:1.
- **Evidence:** `#BDB9AD` measured 1.80:1 on paper and 1.91:1 on panel.
- **Fix:** `#8C887C` measures 3.25:1 on paper and 3.46:1 on panel. DESIGN.md is updated.

### [BLOCK → RESOLVED] Page scrolled sideways at 390px
- **Location:** `access.html` matrix, `board.html` lanes
- **Evidence:** document scrollWidth was 624 and 734. `.visually-hidden` labels (absolutely positioned) inside horizontal scrollers resolved against the initial containing block.
- **Fix:** `.table-wrap, .board, .graph { position: relative; }`. The document width is now 390.

### [WARN → RESOLVED] Menu button visible on desktop
- **Location:** `styles.css` `.menu-toggle`
- **Evidence:** `.btn` (declared later) overrode `display: none`.
- **Fix:** `.sidebar .menu-toggle` raises specificity.

### [WARN → RESOLVED] Korean words broken across lines
- **Evidence:** render-check found 7 broken words, for example `담당 | 자` and `남았 | 으면`, in table cells, report items and backlog text. Collection IDs also broke mid-word (`tick | ets`).
- **Fix:** `keep-all` + `overflow-wrap: anywhere` per component (HG-10), and no wrapping in row headers. render-check now finds 0.

### [WARN → RESOLVED] Customer screen exposed VM IDs (GS4)
- **Location:** `agent.html`
- **Fix:** `vm-junho-41c2` and `vm-orum-shared` are replaced with "박준호 전용 VM" and "제품팀 공유 VM".

### [WARN · SLOP → RESOLVED] UI-LAYOUT-03: every block in the same card
- **Location:** `qa.html` guarantees, `build.html` follow-up field
- **Fix:** neither block is an entity, so both are now plain sections (`.plain`). Panels stay only for entities and decisions.

### [WARN → RESOLVED] Approve label split by flex gap
- **Location:** `feedback.html` primary button rendered "안건 2 개".
- **Fix:** the label is wrapped in one span.

### [WARN → RESOLVED] Preview index read as a feature list, not a story
- **Location:** `preview/index.html`
- **Evidence:** owner review: "그냥 나열한 것 같다". Eight links were in order, with nothing linking one scene to the next.
- **Fix:** rebuilt as a storyboard:
  - an opening with the "why Kelay" voice-over, a cast of three, three acts and a closing on what Kelay gives up;
  - each scene has a focused 16:10 crop, the person's line, Kelay's answer, and a hand-off line that causes the next scene.
- **Check:** render-check 0 broken words; copy-check 0 findings.

## Restraint audit — applied cuts (round 1)

App screens are dense tools. The skill scopes R2/R4/R5/R6/R8 out for them, so only R1, R7 and R9 were acted on.

| Element | Need (R14) | Verdict | What grows into the space |
|---|---|---|---|
| Sidebar slug `ticket-board` (6 pages) | none, duplicates the app name | cut | the app name stands alone |
| Ship build stamp in mono | a date, not an identifier | demote to meta | — |
| Build: separate "요청한 내용" panel | the builder's own words, context | merge into page header lede | "만든 화면" becomes the first and largest panel |
| QA guarantees panel | explanation, not an entity | un-card | the results table is the only panel below the incident |

Remaining FAILs and the reason each one stays:
- **R1 on access and agent:** the matrix and the simulator, and the two VM areas, are deliberate side-by-side comparisons.
- **R7 on qa, board and feedback:** the second hue is a status color (danger for the incident and overdue dates, warn for waiting). DESIGN.md allows the accent plus one status.
- **R9 on build, access and feedback:** the mono labels are collection names, routes and feedback keys. They are the builder's data and vocabulary, not captions.
- **R3-fold:** app screens use the six type roles in DESIGN.md.

## Copy FYIs kept

- `access.html:195` HW-6: `8개 (내 것 5개, 공유 3개)` is a data value, not a sentence.
- `agent.html:84,89` HW-3: periods inside `<label>`. These are full-sentence descriptions under the option title.
- `app.js:177` HW-1: the string already uses `을(를)` and `(으)로`.

## Feel checks (machine)

- Durations are 150 and 200ms (50ms grid); exit is faster than enter; ease-out on enter.
- `transition: all` is not used. Only color, transform and opacity animate.
- `prefers-reduced-motion` makes every transition instant and turns off pressed scaling.
- Focus is `:focus-visible` only: 2px accent ring with a 2px offset (5.9:1 on paper).
- Targets are 40px controls on fine pointers and 44px on coarse pointers. Tabs are 36px on fine pointers (above the 24px WCAG AA minimum).
- Scrollers use `overscroll-behavior-x: contain`. The listbox follows the APG pattern: arrow keys, Home/End, Enter/Space, Escape returns focus.

## Not covered

- Pixel-measured contrast (`omd check contrast`) was not run; the CLI was not available.
- Dark mode is unresolved in DESIGN.md, so it is not built.
- No screen-reader pass was made with real assistive technology.
