# Prototype sync

The console ports `design/prototype/index.html` as of commit
**f063d30c06abc7fc68366e4a2394f7615714ce20** ("Use a plain-text Kelay wordmark in the top bar"),
the newest change to that file on `origin/main` when this was last checked (2026-11-11).

To re-sync: `git log -1 --format=%H origin/main -- design/prototype/index.html`, diff that file
against the commit above, and port the changes using the map below.

## What maps where

| Prototype | Console |
|---|---|
| `<style>` (base block, then "Design refresh: flat") | `src/app/globals.css`, same rule order; additions at the end |
| Geist / Geist Mono from Google Fonts | `geist` package via `next/font` in `src/app/layout.tsx` |
| `I` icon set, `ic()` | `src/components/icon-paths.ts`, `<Icon>` in `src/components/ui.tsx` |
| Mock data (`ME`, `APPS`, `MEMBERS`, `BOARD`, `TICKETS`, `PROPOSALS`, `LINKS`, assistants, tool calls, checks) | `src/lib/api/fixtures.ts`, served by the mock `ConsoleApi` in `src/lib/api/mock.ts` |
| `topbar()` | `src/components/top-bar.tsx`, `avatar-menu.tsx` |
| `#/` Home (`viewHome`) | `src/app/page.tsx`, `src/components/home/prompt-form.tsx` |
| `#/apps` My Apps, store share modal | `src/app/apps/page.tsx`, `src/components/apps/apps-view.tsx`, `src/components/share-modals.tsx` |
| `#/graph/:focus` App Graph (`viewGraph`, `appGraph`, `graphPanel`) | `src/app/graph/[[...focus]]/page.tsx`, `src/components/graph/*`, `src/lib/graph.ts` |
| `#/app/:id/:tab` Workspace (`viewApp`, `TABS`) | `src/app/app/[id]/[tab]/page.tsx`, `src/components/workspace/workspace.tsx`, `workspace-shell.tsx`, `tab-meta.ts` |
| `#/app/:id/:tab/ship` (`shipModal`) | `src/app/app/[id]/[tab]/ship/page.tsx`, `src/components/workspace/screen/ship-modal.tsx` |
| `#/app/new/screen` (`buildingStage`) | `src/components/workspace/screen/new-app-workspace.tsx` |
| Screen tab (`tabScreen`, `boardMock`) | `src/components/workspace/tabs/screen-tab.tsx`, `screen/screen-view.tsx`, `screen/board-preview.tsx` |
| Access, QA, Agent, Feedback, Users, Monitoring tabs | `src/components/workspace/tabs/<tab>-tab.tsx`, loaded by `tab-registry.ts`, fed by `tab-data.ts` |
| Access "policy" view | also `src/components/workspace/policy-matrix-card.tsx` (renders the app's `PolicyMatrix`, contracts §3) |
| `chatPanel()` | `src/components/workspace/chat-panel.tsx` |
| App share modal | `ShareAppModal` in `src/components/share-modals.tsx` |
| `toast()` | `src/components/toast.tsx` |
| Story captions (`SCENES`, `storyCard`) and the `.proto` bar | `src/lib/story.ts`, `src/components/story-layer.tsx`; off unless `?story=1` or the account menu's Story mode |

## Deliberate differences

- Clickable divs (graph nodes, edge labels, connection rows, tickets) are buttons; switches use `role="switch"`.
- One focus ring (`:focus-visible`) replaces browser defaults.
- MCP endpoints follow contracts §7 (`/<handle>/<app>/mcp` on the app domain), not the prototype's subdomain form.
- "Connect apps" opens a request form (`POST /v1/grants`); the prototype's button did nothing.
- Builds for prompts that aren't a ticket board use neutral step copy.
- The Next.js dev indicator is off because it covers the Story bar.
