# Kelay Design System

<!-- design-md:section experience -->
## 1. Experience

<!-- design-md:claim scope kind=product-surface lang=en -->
Kelay is a cloud for small software. This document covers two web surfaces: the builder console, and the screens the Kelay SDK puts inside every app a builder ships (the board-style app UI, `/feedback`, and the personal agent page). The marketing site is out of scope.
<!-- design-md:claim-end -->

<!-- design-md:claim primary-tasks kind=user-outcomes count=6 lang=en -->
- A builder describes an app in one paragraph and gets working screens and collections.
- A builder sets, per role and collection, how far people can read and change rows, and sees what a given person would see.
- A builder shares a version with a customer team in one step, behind a QA gate that runs screens and actions per role.
- A customer team member uses the app, sends `/feedback` without leaving it, and gets replies in the same thread.
- A customer team member connects their own Claude to a personal VM, and uses the app as an agent within their own permissions.
- A builder reads the daily report of improvement items grouped from feedback, approves the ones to apply, and connects their apps over MCP and A2A.
<!-- design-md:claim-end -->

### Stance

The builder should be able to focus on one niche customer, so every screen asks for one decision.

### Principles

- **P1 · One screen, one decision.** Each screen asks the builder for one decision: share, apply, approve, allow. We gain decision speed and screens that read in one second on video; we give up dashboard-style overviews with many metrics side by side.
- **P2 · Status in words, color as a single dot.** Shared, failed and waiting are said in a sentence next to an 8px dot; whole cards are never tinted. We gain a small color budget and status that survives color-vision deficiency; we give up the color-board glance.
- **P3 · The customer's words outrank system detail.** Feedback quotes and customer team names are the heaviest content. VM IDs, routes and commit stamps drop to small mono text. We gain the product's focus on one customer; we give up reading infrastructure detail at a glance.

### Avoid

- Overview screens built from rows of stat tiles; three equal icon-over-heading cards
- Gradients, glass, decorative grid backgrounds, eyebrow labels
- Tables that separate states by color alone; thick colored stripes on one side of a card
- Numbers with no source ("10× faster"), celebration toasts
- Wrapping every block in a card: a block that is not an entity sits on the page as a plain section

<!-- design-md:section foundations -->
## 2. Foundations

<!-- design-md:claim foundations kind=rules-or-constraints lang=en -->
### Color

Contrast values were computed from the token pairs (WCAG relative luminance), not from rendered pixels.

| Token | Value | Use | Decision |
|---|---|---|---|
| `color.paper` | `#F6F5F1` | Page background, a warm-tinted paper | D-P2-2 |
| `color.panel` | `#FDFCFA` | Panels, inputs, ticket cards | D-P2-2 |
| `color.ink` | `#1C1B18` | Body and headings (15.8:1 on paper) | D-P3-1 |
| `color.ink-2` | `#4A4840` | Secondary text (8.4:1 on paper) | D-P3-1 |
| `color.ink-3` | `#68655C` | Meta and mono identifiers (5.3:1 on paper, 4.9:1 on accent-soft) | D-P3-1 |
| `color.line` | `#E3E0D7` | 1px dividers for tables, panels and lists | D-P2-2 |
| `color.line-strong` | `#8C887C` | Control boundaries: inputs, selects, cards you can choose (3.3:1 on paper, 3.5:1 on panel) | D-P2-2 |
| `color.accent` | `#1D6B47` | Primary button, focus ring, selected state, the "done / connected" dot (5.9:1 on paper; panel text on it 6.3:1) | D-P1-2 |
| `color.accent-soft` | `#E4EFE8` | Selected nav item, proposed cell, identity node | D-P1-2 |
| `color.danger` | `#B3261E` | Error sentences, overdue dates, the "failed" dot (6.0:1 on paper) | D-P2-3 |
| `color.danger-soft` | `#F8E7E4` | Error banner background (danger text on it 5.5:1). No other surface gets a tint | D-P2-3 |
| `color.warn` | `#8A5A00` | Waiting dot and sentence (5.4:1 on paper) | D-P2-1 |

- Accent covers at most 5% of the viewport. One primary button per screen (D-P1-1, D-P1-2).
- A status dot always comes with its sentence; a dot alone is not a status (D-P2-1).
- **D-P2-6 · State layers.** Hover mixes 8% ink into the surface, pressed mixes 12% (`color-mix(in srgb, <surface>, ink N%)`). No separate hover hex values.

### Spacing

An 8px scale with a 4px half step: `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64`. Gaps inside a group are smaller than gaps between groups. List rows are 52px tall; table cells at least 44px (D-P1-5).

### Shape

| Token | Value | Use | Decision |
|---|---|---|---|
| `radius.small` | `4px` | Checkbox | D-P2-4 |
| `radius.control` | `6px` | Buttons, inputs, listbox triggers | D-P2-4 |
| `radius.panel` | `10px` | Panels, ticket cards, popovers (6 + a 4px inset) | D-P2-4 |
| `radius.pill` | `999px` | Status dots, count badge, identity node | D-P2-4 |

### Elevation

Panels separate from the page by the panel tone and a 1px `color.line`, never by shadow. Two shadows exist (D-P2-2):

- `shadow.raise` `0 1px 2px rgb(28 27 24 / 6%)`: the selected tab only.
- `shadow.float` `0 1px 2px rgb(28 27 24 / 6%), 0 4px 12px rgb(28 27 24 / 8%), 0 12px 32px rgb(28 27 24 / 10%)`: popovers and listboxes.

### Motion

- Hover 150ms; popover open 200ms, close 150ms; `cubic-bezier(0, 0, 0.2, 1)`. Only transform, opacity and colors animate (D-P2-5).
- Pressed buttons scale to 0.97 over 150ms.
- The focus ring appears instantly: 2px `color.accent`, 2px offset, `:focus-visible` only.
- Under `prefers-reduced-motion: reduce`, every transition is instant and pressed scaling is off.
<!-- design-md:claim-end -->

<!-- design-md:section typography-assets -->
## 3. Typography & Assets

### Faces

- Text and headings: **Pretendard Variable** (SIL OFL 1.1), loaded from jsDelivr `orioncactus/pretendard@v1.3.9`, dynamic subset. Weights 400, 500, 600, 700 only.
- Mono: no brand mono face is chosen. The system stack `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` is used and is not presented as a brand face.

### Roles

| Role | Size / line height | Weight | Tracking | Decision |
|---|---|---|---|---|
| Storyboard title (preview index only) | 40px / 1.3, 32px below 900px | 700 | −0.02em | D-S-1 |
| Page title (h1), act title | 28px / 1.3 | 700 | −0.02em | D-P1-3 |
| Section title (h2), wordmark | 20px / 1.4 | 600–700 | −0.01em | D-P1-3 |
| Customer quote, report item title | 18px / 1.45–1.55 | 500–600 | 0 | D-P3-1 |
| Body | 16px / 1.5 | 400 | 0 | — |
| UI text, tables, ticket titles | 15px / 1.45 | 400–600 | 0 | D-P1-5 |
| Meta, mono identifiers, count badge | 13px / 1.45 | 400–600 | 0 | D-P3-1 |

- Korean text never gets negative tracking below 20px and never goes below −0.03em.
- `word-break: keep-all` with `overflow-wrap: anywhere` is set per component: headings, controls, labels, table cells, short UI prose. It is not a global default.
- Changing numbers use `tabular-nums`. No italics.

### Assets

- Logo: none. A Pretendard 700 text wordmark ("Kelay", or the app name inside a shipped app) stands in.
- Icons: none chosen. Text labels, plus dots and chevrons drawn in CSS.
- The app graph is inline SVG drawn with the color tokens.

<!-- design-md:section components-states -->
## 4. Components & States

Every interactive component has default, hover (pointer devices only), focus-visible, pressed and disabled states. Disabled is never opacity alone: background and text color change together, and the reason sits next to it.

- **Primary button.** Accent fill, panel-colored text, 40px tall (44px on coarse pointers). One per screen. In a decision panel (a request to allow, a detail view) it sits in that panel's header instead of the page header.
- **Secondary button.** Panel fill with a `line-strong` border; the border width never changes between states.
- **Quiet button.** Text only, for copy, preview and other side actions.
- **Status.** 8px dot plus a sentence. Done/connected = accent, failed = danger, waiting = warn, idle = ink-3. Not interactive.
- **List row.** Fixed columns so rows align; the status column is 128px and right-aligned. The first column is the subject (a team, a screen, a connection).
- **Listbox trigger and popover.** Used for permission scopes, the person picker and the ticket status mover. Never a native select. Arrow keys move, Enter or Space chooses, Escape closes and returns focus to the trigger. A cell the agent proposes gets an accent border, accent-soft fill and a "proposed · currently X" note.
- **Ticket card.** Title, assignee and due date. An overdue date is danger text. A ticket the viewer cannot move shows "담당자만 옮길 수 있어요" instead of a mover, so the move cannot fail on screen.
- **Thread (`/feedback`).** Messages in order, author and time on one line, no bubbles and no side stripes. A reply field sits under the thread.
- **Report item.** Custom checkbox, title, one-sentence change, and three facts: evidence, what changes, schema and permissions. The approve button counts the checked items and is disabled at zero.
- **Feedback backlog row.** A disclosure row with key (`FB-31`), text, author and team, and the report item it belongs to. It opens into the thread.
- **Choice card (radio).** Custom radio. When selected, it gets an accent border and dot.
- **App graph.** App nodes are panel rectangles with `line-strong` borders. The identity node is accent-soft with an accent border. Connected edges are ink-2 solid, a pending edge is warn and dashed, and identity edges are dotted `line-strong`. A list of the same connections always sits next to the graph.
- **Text input.** Same height as buttons. The label is always visible above it. Errors use a fixed helper slot below the input in danger text. Focus is the focus ring, not a thicker border.

<!-- design-md:section layout-platforms -->
## 5. Layout & Platforms

- **Shell.** A 240px sidebar and a main column up to 1120px wide. On wide screens the main column stays left-aligned and the rest stays empty.
- **Page header (D-P1-1).** Title and one-line lede on the left, the primary button on the right. The evidence for the decision sits in the first block under the header (D-P1-4).
- **Grammar per screen.**
  - Build, share, QA, agent: a single column of blocks.
  - Permissions and board: main content plus a 340px side panel.
  - Report: a list of items followed by the backlog.
  - Connect: a request panel, then the graph, then the list.
  - Storyboard (the preview index, not product UI): an opening, three acts and a closing.
    - Each scene pairs a 16:10 crop of its screen with the person's line, what Kelay does, and the event that leads into the next scene. Scenes chain by cause, not by feature list.
    - **D-S-1:** the storyboard title is the only display size in the system.
- **Responsive.**
  - The minimum supported width is 320px.
  - Below 1180px, side panels stack under the main content. Below 900px, the sidebar becomes a top bar with a menu button, and the primary button drops under the title at full width.
  - The board scrolls sideways inside its own container with lane snapping. Tables and the graph also scroll inside their containers.
  - The page itself never scrolls sideways. Each scroller is the containing block for anything absolutely positioned inside it.
- On coarse pointers, tap targets are at least 44px with at least 8px between neighbors.

<!-- design-md:section content-locales -->
## 6. Content & Locales

- Supported locale: `ko` only (`<html lang="ko">`). This document is written in English; every string on screen is Korean.
- Speech level: 해요체 throughout. Say what the person did or got, not the system state ("공유했어요", "QA 24개 모두 통과"). Do not write "처리가 완료되었습니다".
- Buttons name the result as a verb: "팀에 공유하기", "v3 배포하기", "안건 2개 승인하기", "내 Claude 연결하기". A button that only closes says "닫기".
- Errors say what happened and what to do now. No exclamation marks and no codes in error copy.
- One term per concept: 공유 (ship to a team), 고객 팀 (tenant), 권한 정책 (RLS policy), 개선 안건 (report item), 피드백, 연결, 개인 영역 / 팀 공유 영역 (single / shared VM area), 신원 (identity).
- MCP, A2A, RLS, VM and `/feedback` stay in Latin script. Collection names (`tickets`) and routes are the builder's own vocabulary, so the builder console shows them as mono text. Customer-facing screens do not show IDs.
- Dates and times: "11월 11일 08:52", ranges "10:00~18:00". Numbers use `ko-KR` grouping, and units attach to the number ("24개", "29,000원").

<!-- design-md:section governance -->
## 7. Governance

<!-- design-md:claim authority kind=portable-brief lang=en -->
This document is a portable design brief for the declared scope.
<!-- design-md:claim-end -->

<!-- design-md:claim application-priority order=prompt-fact,repository-fact,system-contract,reference-inspiration lang=en -->
1. Direct user instructions for the requested scope.
2. Repository facts.
3. This system contract.
4. Reference inspiration.
<!-- design-md:claim-end -->

<!-- design-md:claim unknowns policy=absent-at-smallest-unresolved-boundary lang=en -->
Omit only the smallest unresolved value or group. Do not replace it with a plausible default.
<!-- design-md:claim-end -->

<!-- design-md:claim changes policy=review-record-validate-before-adoption lang=en -->
Record, review, and validate changes before adoption.
<!-- design-md:claim-end -->

- Every decision here is an agent-proposed greenfield decision. Treat it as a brief until the product owner reviews it.
- A new value needs a decision first: add `D-<principle>-<n>` to the table, then use it in tokens and screens.
- App screens are dense tools. The restraint caps on piece count, word budget and borders do not apply to them. Single focus, one accent and the mono-label count do apply.

<!-- design-md:claim omitted count=4 lang=en -->
### Omitted

- `foundations.color.dark` — `unresolved`: no dark-mode palette has been decided.
- `typography-assets.logo` — `unresolved`: there is no logo or symbol yet; a text wordmark stands in.
- `typography-assets.font.mono` — `unresolved`: no brand mono face has been chosen.
- `typography-assets.icons` — `unresolved`: no icon set has been chosen.
<!-- design-md:claim-end -->
