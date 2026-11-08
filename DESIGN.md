# mybase dashboard design

The standard for every screen in `apps/dashboard`. When in doubt, choose the simpler option and the one that gets the user to their goal in fewer steps.

## Who it's for and what it does

- **User:** one person (the owner) running mybase on their own hardware, usually a developer.
- **Main jobs, in order:**
  1. Find a project or a resource in it (a table, a queue, a site).
  2. **Look at and change data:** rows, files, keys, messages, secrets.
  3. Run or test work and see the result: run a cron job, send a message, try a search.
  4. Connect an app: copy a URL, a key, a snippet with the real names filled in.
  5. Diagnose failures: what failed, when, and why.
- **Implication:** this is a tool, not a showcase. Speed of finding things beats visual flourish.

## Principles

1. **Show the thing, not a description of it.** Every service's first screen shows its real resources (tables, keys, queues, sites) or a useful first action. Explanations live in empty states, the Connect sheet, and the docs, not above the data.
2. **UX before UI.** Decide where something goes and what it's called before deciding how it looks.
3. **Everything is findable two ways:** visible navigation and the command menu (Ctrl/⌘ K). Every page, every action, and the project's own objects (tables, queues, jobs, sites) appear in the command menu.
4. **One emphasized action per task region.** Run sits by the editor, Upload by the path, Send by the messages. The page header holds the page's main action in the accent color; everything else is outline or ghost.
5. **Only show what exists.** No nav items, buttons, or menu entries for features that aren't built yet. No disabled "coming soon" placeholders.
6. **Calm by default.** Neutral surfaces, one accent color, no decorative shadows, gradients, or illustrations. Color carries meaning (action, focus, state) and nothing else.
7. **Live, but Pi-friendly.** Data stays fresh without constant polling (see "Live data"). Interactivity means visible cause and effect, not constant motion.
8. **Dense, not cramped.** 14px text, tight rows, hit targets of 32 px on desktop and 44 px under touch.
9. **Every state is designed:** loading, empty, error, stale, and offline get real copy that tells the user what to do next.

## Layout

```
Desktop (md+, ≥768px)                          Mobile (<768px)
┌─────────────┬───────────────────────────┐    ┌──────────────────────────────┐
│ mybase      │ shop / Queues             │    │ ☰  [Shop ⌄] / Queues   ⌕  ☀ │
│ ● pi.local  │ Queues   4 · 312 waiting  │    ├──────────────────────────────┤
│ [Shop    ⌄] │          [Connect][+ New] │    │ Queues            [+ New]    │
│             │                           │    │ table / content              │
│ ▌Overview   │ table / content           │    │                              │
│ Data        │ (max-w-5xl, or full width │    │ ☰ opens the rail as a sheet  │
│  Database   │  for workspaces)          │    └──────────────────────────────┘
│  …          │                           │
│ Compute …   │                           │
│ App …       │                           │
│─────────────│                           │
│ Security  2 │                           │
│ Settings    │                           │
│ ⌕ Search ⌃K ? ☀                         │
└─────────────┴───────────────────────────┘
```

- **Left rail, 14rem** (`app-shell.tsx`). Top: product name, then **instance identity** (the host in mono `text-xs` with a health dot from `/health`: up / unreachable, never green because something is "enabled"; click for version and links), then the project switcher.
  - The middle scrolls (`min-h-0 flex-1 overflow-y-auto`), so the footer never falls off-screen when many services are on.
  - **Outside a project:** Projects, then "Recent" (up to 5 projects, last opened first, `localStorage` `mybase.recent`).
  - **Inside a project:** Overview, then the project's services, grouped **Data** (Database, Storage, Cache, Vector, Secrets), **Compute** (Hosting, Registry, Sandboxes, Cron, Queues), **App** (Users, Analytics, Realtime, Captcha, Rate limits, Search). Group labels are `text-xs font-medium text-muted-foreground`; a collapsed group is remembered (`mybase.rail.collapsed`) and still shows the service you're on. **The rail lists services only:** sub-views are tabs in the content. Every link is active when `route.page` is its service.
  - Inside the docs: every guide, grouped by section.
  - Footer: Security (with a count badge of critical/warning advisor findings, **only from data a page already loaded**), Settings, Search, the `?` help menu (Documentation, Keyboard shortcuts), color mode.
- **Project switcher** (`project-switcher.tsx`): a searchable popover (⌘P), sorted by recently opened, display name + mono slug + service count. Switching keeps the current service when the other project has it (item ids are dropped), else opens its Overview.
- **Mobile:** one sticky bar: Menu (opens the rail as a sheet), the switcher, the current page's name, search, mode. No horizontal link strip.
- **Widths:** reading (`max-w-prose`), standard (`max-w-5xl`, most pages), **workspace** (`w-full`) for the table editor, SQL editor, logs, audit log, file browser, and a sandbox's runs. Content is left-aligned next to the rail; never center page content.
- **Spacing** follows Tailwind's 4px scale. Page padding `px-4 py-6` mobile, `px-8 py-8` desktop. Header to content `mb-6`, sections `mb-8`, section header to content `mb-2`.
- **Settings-style forms** use `Row`: label + hint on the left (14rem), control on the right, separated by a top border. Stacks on small screens. `Row id` makes it a deep-link target (`?s=<id>`).

## Page anatomy

1. **Header** (`PageHeader`): breadcrumb (every level linked, `<nav aria-label="Breadcrumb"><ol>`), title, **live facts** instead of a marketing sentence ("4 queues · 312 waiting · 2 dead"), and the actions: the emphasized action plus a **Connect** button that opens the Connect sheet. Only the facts line gets `aria-live`.
2. **Data on the first screen:** the service's real objects, with their most useful row action always visible.
3. **Secondary views as tabs** (`RoutedTabs`): Activity, Settings. The **danger zone** ("Delete [service] data and turn off…", with an impact summary) lives in the Settings tab, never on the first screen.

- **Project Overview** (`#/projects/<name>`): header with Connect + a quick-connect strip (the 2–3 values people copy most: DB URL template, bucket, live site URL), then **enabled services as live preview panels** (on `--surface`: real numbers, a short list, a link to the page; named "Enabled", never "Running"), then attention items, then a compact **"Add a service"** list (one line each: icon, name, one-line value, Turn on). No switches on panels.
- **Turned-off service** (`ServiceOff`): icon, name, 2–3 "what you get" bullets, Turn on, and host prerequisites shown separately from project enablement. Turning on is one click with progress, then the service's first-run state.
- **Item pages** (a queue, a key, a site): breadcrumb `project / Service`, the identifier as a mono 18 px title (click to copy), tabs via `?tab=`.
- **Connect sheet:** one right-side sheet per service: per-method tabs, real values filled in, Copy on everything, and "Create scoped API key". Service settings go in the Settings tab, not here. While a service has no data, its empty state shows an inline first-run recipe; it doesn't collapse once data arrives.
- **Documentation** (`#/docs`): an index, then one page per guide (`#/docs/<service>/<guide>`, `?s=<section>`), capped at 40rem, with an "On this page" outline on wide screens and previous/next links. Code blocks use `CodeBlock`. `## Agent notes` renders as a collapsed "Notes for AI agents". Every guide header has Copy markdown and Copy .md URL.

## Color

All colors are CSS variables in `apps/dashboard/src/styles/globals.css`, using shadcn's token names, in OKLCH. Never hard-code a color in a component; use the token classes (`bg-background`, `text-muted-foreground`, `bg-success/12`, …). The docs site (`apps/site/app/global.css`) mirrors the neutrals and status colors; change both together.

### Neutrals (cool grey, hue 250)

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `oklch(0.99 0.002 250)` | `oklch(0.175 0.006 250)` | Page canvas; tables sit on it |
| `surface` | `oklch(0.975 0.003 250)` | `oklch(0.195 0.006 250)` | **Only** Overview panels, stat tiles, code blocks, sheets. No white cards |
| `sidebar` | `oklch(0.97 0.003 250)` | `oklch(0.155 0.006 250)` | Rail / mobile bar |
| `foreground` | `oklch(0.22 0.012 250)` | `oklch(0.94 0.004 250)` | Body text |
| `muted-foreground` | `oklch(0.5 0.012 250)` | `oklch(0.68 0.01 250)` | Secondary text, table headers, hints |
| `border` | `oklch(0.885 0.005 250)` | `oklch(0.275 0.008 250)` | Dividers, outlines |
| `accent` | `oklch(0.945 0.005 250)` | `oklch(0.27 0.008 250)` | Hover surface (shadcn's name; not the brand accent) |
| `sidebar-accent` | `oklch(0.93 0.005 250)` | `oklch(0.25 0.007 250)` | Rail hover / current page |
| `selected` | accent 10% | accent 10% | Selected row / segment |

### Status (system health)

| Token | Light | Dark | Use |
|---|---|---|---|
| `success` | `oklch(0.52 0.14 150)` | `oklch(0.74 0.14 150)` | Live, OK, active |
| `warning` | `oklch(0.55 0.13 60)` | `oklch(0.78 0.14 75)` | Needs attention (DNS, warnings), rate-limit blocks |
| `info` | `oklch(0.53 0.14 245)` | `oklch(0.74 0.13 245)` | In progress (queued, starting, running), with a pulse |
| `destructive` | `oklch(0.55 0.2 27)` | `oklch(0.68 0.18 25)` | Failed, errors, destructive actions |

Each has a `/12` tint for badges (`bg-success/12 text-success`). Text values are at least 4.5:1 on `background` and `surface` (checked).

- **Color describes the health of the system, not the outcome a rule was built to produce.** A rate limit blocking a request is the rule working: `warning` or neutral, never `destructive`.
- **Never color alone:** `StatusDot` always has a text label.
- **"Enabled" is not "healthy":** configuration states are neutral.
- **In progress is `info`, never the accent:** the accent is user-chosen, and a green accent would read as "healthy".

### Charts

`--chart-1` is the accent at reduced chroma; `--chart-2..4` are neutral steps. Bad = `destructive`, blocked = `warning`. Never raw `bg-primary/65`.

### Accent (user-selectable)

The accent is `--primary` (and `--ring` follows it). It appears in: the emphasized button, focus rings, the current-page marker in the rail, switches that are on, the active tab underline, the selected row or segment indicator, inline links in body copy, progress bars, and chart marks (through `--chart-1`). **Never as a large fill.**

| Accent | Light `--primary` | Dark `--primary` |
|---|---|---|
| Moss (default) | `oklch(0.5 0.1 150)` | `oklch(0.74 0.12 150)` |
| Cobalt | `oklch(0.5 0.17 262)` | `oklch(0.72 0.14 262)` |
| Raspberry | `oklch(0.52 0.19 5)` | `oklch(0.73 0.15 5)` |
| Amber | `oklch(0.54 0.13 60)` | `oklch(0.8 0.14 75)` |
| Graphite | `oklch(0.26 0.012 250)` | `oklch(0.92 0.004 250)` |

## Changing the color scheme and mode

- **Mode:** Light, Dark, or Match system. Set from Settings, the moon/sun button in the rail, or the command menu.
- **Accent:** one of the five above. Set from Settings or the command menu.
- Both are saved in `localStorage` (`mybase.mode`, `mybase.accent`) and applied by `ThemeProvider` (`src/lib/theme.tsx`) as a `dark` class and a `data-accent` attribute on `<html>`.
- An inline script in `index.html` applies them before first paint. Keep its keys in sync with `theme.tsx`.

**To add an accent:** add a light and dark `[data-accent="name"]` block in `globals.css` (keep the selector shape so swatches can preview it), add the name to `ACCENTS` in `theme.tsx` and a label in `ACCENT_LABELS` (`accent-picker.tsx`). The light value needs at least 4.5:1 contrast with its foreground; the dark value should be lighter.

## Typography

- **Hanken Grotesk** (variable) for everything; **JetBrains Mono** only for literal values the user will copy or type: commands, connection strings, hostnames, keys, ids, cell values. Never for labels or decoration.
- Both are self-hosted through `@fontsource-variable/*`. The dashboard must work offline on a LAN; never load fonts from a CDN.
- Tabular figures are on globally.

| Role | Class | Size |
|---|---|---|
| Title (Projects, project Overview) | `text-2xl font-semibold tracking-tight` | 24px |
| Title (default) | `text-xl font-semibold tracking-tight` | 20px |
| Title that is an identifier | `font-mono text-lg font-semibold` (click to copy) | 18px |
| Section heading | `text-base font-semibold` | 16px |
| Metric | `metric` (`text-2xl font-semibold tracking-tight tabular-nums`) | 24px |
| Body, table cells, controls | `text-sm` | 14px |
| Mono value | `mono-value` (`font-mono text-[13px]`); 12px only for secondary metadata | 13px |
| Code block | `code-block` (12.5px, `leading-5`) | 12.5px |
| Badge, table header, small meta | `text-xs font-medium` | 12px |

Editable inputs are 16px under touch (`text-base md:text-sm`) so phones don't zoom. Semibold only for hierarchy and decisive state. Sentence case everywhere; no all-caps labels, no eyebrow text.

## Shape and depth

- `--radius` is 0.5rem. Controls `rounded-md`, dialogs and panels `rounded-lg`, badges `rounded-sm`, swatches are circles.
- No shadows on in-page content (the selected segment of a `SegmentedControl` is the one `shadow-xs`). Floating layers (dialogs, sheets, menus, toasts) get the default shadow.
- Lists are tables with row dividers, not grids of cards. The exception is the project Overview's service panels.
- **Dashed borders only for empty states and drop targets.** Errors use a solid panel (`ErrorPanel`).

## Tables

- Navigation lists use the **stretched link**: the name `<a>` gets `after:absolute after:inset-0`, the row is `relative`, buttons in it `relative z-10`. No `onClick` on `<tr>`. Data tables (rows, cells) keep their cells selectable instead.
- The single most useful row action is **always visible** as a ghost icon (cron Run ▶, rule Test, site Visit ↗). Secondary actions appear on hover or focus-within, and are always visible under `pointer: coarse`.
- Hover `bg-accent/60`. Selected row = `bg-selected` + an accent bar on the left (`data-state="selected"`). Rows arriving by poll or mutation get `animate-arrive` (600 ms).
- Sticky header on long lists. Numbers right-aligned `tabular-nums`. Mono only for literal values. Header cells `text-xs font-medium text-muted-foreground`, sentence case (the `TableHead` default; don't override it per page). Row height `h-10`. Empty cells show "—" (`Empty`).
- Keyboard: j/k (or ↑/↓ on a row) move, Enter opens, `x` selects. Rows opt in with `data-row`. **No destructive single keys.**

## Interaction patterns

| Need | Pattern |
|---|---|
| Find anything | Command menu (Ctrl/⌘ K): "This page" actions (`useCommands`), recent pages, the project's objects, services, projects, docs (only once you type), appearance; destructive commands and sign out last, only after typing |
| Edit a value inline | Click selects a cell (⌘C copies the raw value); double-click or Enter edits (Enter saves, Esc cancels, spinner in the cell, red ring + the Postgres message on error); Space or the expand icon opens the row in the Inspector |
| Inspect an object | The one `Inspector` sheet: identifier + Copy, typed body, actions footer. Files, rows, messages, documents, audit events, tasks, tags, artifacts |
| Delete one row, message, key, or file | Inline two-step (`InlineDelete`): trash → "Delete? ✓ ✕", back after 3 s. Database rows: a confirm naming the table and primary key, explaining cascades |
| Delete many | `ConfirmDialog` with the count. It keeps itself open on failure, shows the error, and offers Retry; callers don't catch |
| Delete a project or turn a service off | Typed name + real impact counts; in Settings, worded "Delete … and turn off" |
| Undo | Only where the backend really restores: secrets (revision restore), pause/resume, settings ("Removed KEY · Undo") |
| Turn a service on | One click, no confirm, visible progress, then its first-run page. A confirm only when there are options (link keys, host setup) |
| Live data | See "Live data" |
| Copy | A labelled Copy control; ✓ for 1.5 s; announced politely; the text stays selectable (`CopyField`, `CodeBlock`, `useCopy`). Works on plain-HTTP LAN installs (`lib/clipboard.ts`) |
| Create something | Small quick-create dialog with one focused field and Enter submits; larger forms in a scrollable sheet or dialog with an Advanced section. After success, show the new item (highlighted) |
| Filter a list | Search input above the table (`data-filter`, `/` focuses it); kept in the URL, replacing history |
| Choose one of a few | `SegmentedControl` (range, mode); `RoutedTabs` for views with their own URL |
| Dates | `TimeAgo` ("3 hours ago", live), exact time in `title`/inspector. `Countdown` for things under an hour away |
| Navigation state | Hash routes; every view, tab, selected item, filter, sort, and page has a linkable URL |
| Loading | Shaped skeletons (`TableSkeleton`, `CardGridSkeleton`, `StatRowSkeleton`, `LinesSkeleton`), shown only after 200 ms; never a full-page spinner |
| API down | `OfflinePanel`: the real origin, the command for this install, auto-retry with backoff |

### Shortcuts (`lib/keys.ts`, `?` shows them)

`⌘K` search · `⌘P` switch project · `?` cheat sheet · `/` filter · `g p` projects · `g o` overview · `g d` database · `g s` settings · `c` create · `r` refresh · `[` / `]` previous / next tab · `j` / `k` move in a list · `↵` open · `x` select. Single keys are ignored while typing. **No destructive action has a single-key shortcut.**

## Live data

mybase runs on a Raspberry Pi with an SD card: every request is a query. `useLoad` (`lib/load.ts`) is the one data layer:

- A module cache keyed by request; cached data shows instantly (Back is instant) and revalidates in the background. Requests are deduped and aborted when nothing reads them. `keepPrevious` holds the old data across filter/range/page changes. Mutations call `invalidate(prefix)`; simple reversible toggles may `mutate` optimistically with rollback (never deletes).
- **Refetch on focus.** Poll **only the visible page**: **2 s while something is in progress** (deploy, cron run, sandbox execution), stopping at a terminal state; **15 s** on operational lists (queues, realtime, hosting, cron history); **60 s** on analytics; **never** on secrets or settings. Pause when the tab is hidden or after 5 minutes without input; back off ×2 on errors. No hover prefetch, no pollers for rail badges (`useCached` reads what pages loaded).
- Every polled or refreshable section shows `LiveIndicator`: "Updated 12s ago · ↻" (with "auto-refresh 15s" and a small success dot while polling; "Paused · Resume" when paused). `r` refreshes.
- A failed refresh **keeps the data** and says "Couldn't refresh · last updated … · Retry". Only a first load that fails shows an `ErrorPanel`.
- `aria-live="polite"` only on summary counts and completion states, never on whole tables.

## Errors

- Form errors stay inline, next to the field (`aria-invalid` + `aria-describedby`); with several, an error summary at the top and focus on the first invalid field.
- Errors from one-click actions → a **persistent** toast (no auto-dismiss) with Retry.
- `ConfirmDialog` errors appear inside the dialog.
- `errorMessage` (`lib/api.ts`) separates API answers (with the request id on 5xx), network failures ("Can't reach the mybase API at …"), timeouts, and local validation messages.

## Motion

- Color and opacity only, ≤150 ms for feedback (`transition-colors`). Dialogs, sheets, menus, and toasts fade in and out.
- A 600 ms fade (`animate-arrive`) for rows that arrive by poll or mutation. A pulse (`animate-progress`) only for work in progress.
- **No transforms:** no press translate or scale, no slides, no View Transitions, no rail-marker slide.
- `prefers-reduced-motion` turns all of it off (`globals.css`).

## Writing

- Name things by what the user gets, not how it's built: "Create project," not "Provision tenant."
- Buttons say exactly what happens, and the result uses the same verb: "Create project" → toast "Created recipes · View".
- Status vocabulary: Disabled / Enabled, Setup required / Ready, Loading / Stale / Failed. "Enabled" never implies healthy; "configured" never implies reachable.
- Errors say what went wrong and what to do, with no apology: "Can't reach the mybase API at http://pi.local:4000. On the server, run `mybase server status`, then retry."
- Empty states explain what the thing is and offer the real create form (optionally "Fill example" the user reviews). One-click live testers only where they're stateless (captcha solve, rate-limit test, web search, realtime playground); never recurring jobs against third-party URLs or fake analytics events.
- Show API error messages verbatim next to the field that caused them. Success goes in a toast (bottom right).
- Toasts: "Turned on {service} for {project}". Empty values show "—".

## Accessibility floor

- Visible focus ring (3px, accent at 50%) on every interactive element; `focus-ring` for links, summaries, and rows. Never remove outlines without replacing them.
- "Skip to content" link to `main#main-content`. On navigation, focus moves to the page's `h1` and the page scrolls to the top (Back restores the position); filter changes don't move focus. `document.title` = "resource · project · mybase".
- Icon-only buttons have an `aria-label` naming the object ("Delete message 3f2a…"); decorative icons are `aria-hidden`. The current nav item has `aria-current="page"`.
- Tooltips open after ~300 ms (keyboard focus immediately). Truncated values have an accessible full view (inspector/popover), not only `title`.
- Hit targets: 32 px desktop, 44 px under `pointer: coarse` (buttons get it globally; switches keep a small visible track inside a larger target).
- Body text meets WCAG AA in both modes; check new colors before adding them.
- Everything is reachable and usable by keyboard alone.

## Building UI

- **Stack:** React 19, Tailwind v4, shadcn/ui (new-york style, Radix, lucide icons), served by Bun's HTML import with `bun-plugin-tailwind`. No Vite, no Next.
- **Add shadcn components** from `apps/dashboard`: `bunx --bun shadcn@latest add <name>`. Check the new file imports `cn` from `@/lib/utils` and doesn't pull in `next-themes`, and remove any slide/zoom animation classes (Motion).
- Files in `src/components/ui` are owned shadcn code (plus `sheet`, `popover`, `select` (native), `checkbox`). Change them only to fix tokens or behavior for the whole app.
- **Use the app primitives; don't hand-roll copies:**

| Primitive | File | For |
|---|---|---|
| `PageHeader` | `components/page-header.tsx` | Every page's title row (breadcrumb array, `mono`, `size="lg"`) |
| `RoutedTabs`, `SegmentedControl` | `components/tabs.tsx` | Tab bars with URLs; small exclusive choices |
| `Section`, `SectionHeader`, `Mono`, `InlineCode`, `Empty` | `components/status.tsx` | Page sections; literal values; "—" |
| `StatusDot`, `Badge`, `LiveIndicator` | `components/status.tsx` | Health with a label; tags; freshness |
| `TimeAgo`, `Countdown` | `components/time-ago.tsx` | Every timestamp |
| `CodeBlock`, `CopyField` | `components/code-block.tsx`, `copy-field.tsx` | Snippets and copyable values |
| `Sheet`, `Inspector`, `Facts` | `components/ui/sheet.tsx`, `components/inspector.tsx` | Side panels, object details |
| `ConfirmDialog`, `InlineDelete` | `components/confirm-dialog.tsx`, `inline-delete.tsx` | The delete model |
| `ErrorPanel`, `OfflinePanel`, `EmptyState`, skeletons | `components/states.tsx` | Every non-ready state |
| `Select`, `Checkbox`, `Table…` (`TableEmpty`) | `components/ui/` | Native select, checkbox, tables |
| `Row` | `components/row.tsx` | Settings-style forms |
| `useLoad`, `invalidate`, `POLL` | `lib/load.ts` | All API reads |
| `useCommands` | `lib/commands.ts` | "This page" actions in ⌘K |
| `plural`, `formatCount`, `compact`, `middle`, `niceMax` | `lib/format.ts`, `lib/chart.ts` | Numbers and identifiers |

- Pages live in `src/pages`, one file each, and start with `<PageHeader>`. A page with tabs gets a folder (`src/pages/database/`). Pages inside a project wrap their content in `<ProjectGate>`.
- When you add a top-level page, add it to the rail (`app-shell.tsx`) and the command menu. A service page goes in `SERVICE_PAGES` (`service-card.tsx`: icon, route, rail group, summary, "what you get", docs slug, ⌘K `commands`), which puts it in the rail, the Overview, and the command menu. When you add an action, register it with `useCommands`. Workspace pages are listed in `isWorkspace` (`app.tsx`).
- **Add documentation** beside the package or service it describes. Import the Markdown as text and register it in `src/lib/docs.ts`. Links between guides (`x.md#section`, `sdk/x.md`) are checked by `lib/docs.test.ts`. Keep the h1 in each Markdown file for standalone readers, and use h2/h3 for sections.
