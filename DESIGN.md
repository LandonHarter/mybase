# mybase dashboard design

The standard for every screen in `apps/dashboard`. When in doubt, choose the simpler option and the one that gets the user to their goal in fewer steps.

## Who it's for and what it does

- **User:** one person (the owner) running mybase on their own hardware, usually a developer.
- **Main jobs, in order:** find a project, create a project, get the details needed to connect an app to it, check that things are running.
- **Implication:** this is a tool, not a showcase. Speed of finding things beats visual flourish.

## Principles

1. **UX before UI.** Decide where something goes and what it's called before deciding how it looks.
2. **Everything is findable two ways:** visible navigation and the command menu (Ctrl/⌘ K). Every page and every action must appear in the command menu.
3. **One primary action per page,** top right of the page header, in the accent color. Everything else is outline or ghost.
4. **Only show what exists.** No nav items, buttons, or menu entries for features that aren't built yet. No disabled "coming soon" placeholders.
5. **Calm by default.** Neutral surfaces, one accent color, no decorative shadows, gradients, or illustrations. Color carries meaning (action, focus, state) and nothing else.
6. **Dense, not cramped.** 14px text, tight rows, but full-size controls (36px) so touch targets stay usable.
7. **Every state is designed:** loading, empty, error, and offline get real copy that tells the user what to do next.

## Layout

```
Desktop (md+, ≥768px)                        Mobile (<768px)
┌────────────┬──────────────────────────┐    ┌──────────────────────────┐
│ mybase     │ Title          [Primary] │    │ mybase  Proj Set   ⌕  ☀  │
│            │ short description        │    ├──────────────────────────┤
│▌Projects   │                          │    │ Title          [Primary] │
│  Settings  │ [filter]                 │    │ [filter]                 │
│            │ table / content          │    │ table / content          │
│            │ (max-w-5xl, left-aligned)│    │                          │
│ ⌕ Search ⌃K  ☀                        │    │                          │
└────────────┴──────────────────────────┘    └──────────────────────────┘
```

- **Left rail, 14rem, follows context** (`app-shell.tsx`). Top: product name, then the project switcher (`project-switcher.tsx`: current project or "All projects"; menu lists every project, All projects, Create project). Below it the links change with where you are:
  - **Outside a project** (Projects, Settings): Projects, then a "Recent" list of up to 5 projects (last opened first, kept in `localStorage` `mybase.recent`, topped up with the newest).
  - **Inside a project:** Overview, then one link per service the project has. A service with routed tabs (Database) nests them under its link, with a guide line, only while you're on that service. The in-page tab bar stays.
  - Pinned to the bottom: Settings, Search, color mode.
  - Projects are shown with a letter tile (`ProjectMark`) in the switcher, Recent list, and switcher menu.
  - **Mobile:** one sticky bar (name, switcher, search, mode) over a horizontally scrolling row of the same links plus Settings. No Recent list and no nested tabs; the parent of the current tab gets the selected surface instead.
- **Content is left-aligned** next to the rail, capped at `max-w-5xl` so lines and tables don't stretch on wide monitors. Never center page content.
- **Page header** (`PageHeader`): title, optional one-line description, primary action on the right. Every page uses it.
- **Spacing** follows Tailwind's 4px scale. Page padding `px-4 py-6` mobile, `px-8 py-8` desktop. Header to content `mb-6`.
- **Project pages:** a project's page (`#/projects/<name>`) is a grid of service cards (`ServiceCard`), one per service the project has: icon, name, one-line description, one line of live status. Every service shows, on or off, in the same order. When on, the whole card links to that service's page. Optional services have a switch in the card's top right; flipping it opens a confirm dialog (`ConfirmDialog`, an alert dialog) that says what turning it on or off does, and the page stays put. An off service's card keeps the same layout but is greyed out with a dashed border, doesn't link anywhere, and its status line reads "Off". Core services (database, storage) have no switch. "Delete project" sits below.
- **Service pages** (`#/projects/<name>/database`, `/storage`, `/cron`) show the project name as a breadcrumb above the title (`PageHeader`'s `breadcrumb`). A service with several views uses routed tabs under the header (links with `aria-current`, see `pages/database/layout.tsx`); the header's primary action belongs to the active tab (Insert row, Run).
- **Item pages inside a service** (a cron job, `#/projects/<name>/cron?j=<job>`) use a breadcrumb of `project / Service`, the item name as title, and its main action (Run now) as primary. An optional service's page ends with a "Turn off …" danger section, and when the service is off, it shows a dashed panel with a Turn on button instead.
- **Settings-style forms** use a two-column row: label + hint on the left (14rem), control on the right, separated by a top border. Stacks on small screens.

## Color

All colors are CSS variables in `apps/dashboard/src/styles/globals.css`, using shadcn's token names, in OKLCH. Never hard-code a color in a component; use the Tailwind token classes (`bg-background`, `text-muted-foreground`, `bg-primary`, ...).

### Neutrals (cool grey, hue 250)

| Token | Light | Dark | Use |
|---|---|---|---|
| `background` | `oklch(0.99 0.002 250)` | `oklch(0.175 0.006 250)` | Page canvas |
| `sidebar` | `oklch(0.97 0.003 250)` | `oklch(0.155 0.006 250)` | Left rail / mobile top bar |
| `foreground` | `oklch(0.22 0.012 250)` | `oklch(0.94 0.004 250)` | Body text |
| `muted-foreground` | `oklch(0.5 0.012 250)` | `oklch(0.68 0.01 250)` | Secondary text, table headers, hints |
| `border` | `oklch(0.91 0.005 250)` | `oklch(0.275 0.008 250)` | Dividers, outlines |
| `accent` | `oklch(0.945 0.005 250)` | `oklch(0.255 0.008 250)` | Hover / selected surface (shadcn's name; not the brand accent) |
| `destructive` | `oklch(0.55 0.2 27)` | `oklch(0.68 0.18 25)` | Errors, destructive actions |

### Accent (user-selectable)

The accent is `--primary` (and `--ring` follows it). It appears in exactly four places: the page's primary button, keyboard focus rings, the active-page marker in the rail, and switches that are on. Don't add more.

| Accent | Light `--primary` | Dark `--primary` |
|---|---|---|
| Moss (default) | `oklch(0.5 0.1 150)` | `oklch(0.74 0.12 150)` |
| Cobalt | `oklch(0.5 0.17 262)` | `oklch(0.72 0.14 262)` |
| Raspberry | `oklch(0.52 0.19 5)` | `oklch(0.73 0.15 5)` |
| Amber | `oklch(0.54 0.13 60)` | `oklch(0.8 0.14 75)` |
| Graphite | `oklch(0.26 0.012 250)` | `oklch(0.92 0.004 250)` |

Moss is the default: a muted green that reads as "running / healthy" without being a loud brand color.

## Changing the color scheme and mode

- **Mode:** Light, Dark, or Match system. Set from Settings, the moon/sun button in the rail, or the command menu.
- **Accent:** one of the five above. Set from Settings or the command menu.
- Both are saved in `localStorage` (`mybase.mode`, `mybase.accent`) and applied by `ThemeProvider` (`src/lib/theme.tsx`) as a `dark` class and a `data-accent` attribute on `<html>`.
- An inline script in `index.html` applies them before first paint, so the page never flashes the wrong theme. Keep its keys in sync with `theme.tsx`.

**To add an accent:** add a light and dark `[data-accent="name"]` block in `globals.css` (copy an existing one, keep the selector shape so swatches can preview it), add the name to `ACCENTS` in `theme.tsx` and a label in `ACCENT_LABELS` (`accent-picker.tsx`). The light value needs at least 4.5:1 contrast with its foreground; the dark value should be lighter so it stays readable on the dark canvas.

## Typography

- **Hanken Grotesk** (variable) for everything. A plain, slightly warm grotesque with good figures, less generic than Inter.
- **JetBrains Mono** only for literal values the user will copy or type: commands, connection strings, hostnames, keys. Never for labels or decoration.
- Both are self-hosted through `@fontsource-variable/*`. The dashboard must work offline on a LAN, so never load fonts from a CDN.
- Tabular figures are on globally so numbers and dates line up in tables.

| Role | Class | Size |
|---|---|---|
| Page title | `text-xl font-semibold tracking-tight` | 20px |
| Section heading | `text-base font-semibold` | 16px |
| Body, table cells, controls | `text-sm` (body default) | 14px |
| Small meta (shortcuts) | `text-xs` | 12px |

Sentence case everywhere. No all-caps labels, no eyebrow text above headings.

## Shape and depth

- `--radius` is 0.5rem. Controls use `rounded-md` (6px), dialogs and empty-state panels `rounded-lg` (8px), accent swatches are circles. Radius grows with container size; it isn't one value on everything.
- No shadows on in-page content. Only floating layers (dialogs, menus, toasts) get shadcn's default shadow, because they really are above the page.
- Lists are tables with row dividers, not grids of cards. The one exception is a project's services: a short, fixed set of destinations, not a list to scan.
- Empty and error panels use a dashed border, which signals "nothing here yet" rather than "a container of things."

## Motion

- Only motion that responds to the user: dialogs, menus, and toasts animate in and out (shadcn defaults via `tw-animate-css`).
- No entrance animations on page load, no hover animations on rows.
- `prefers-reduced-motion` turns all animation off (`globals.css`).

## Writing

- Name things by what the user gets, not how it's built: "Create project," not "Provision tenant."
- Buttons say exactly what happens, and the result uses the same verb: "Create project" → toast "Created recipes."
- Errors say what went wrong and what to do, with no apology: "Can't reach the API at http://localhost:4000. Start it with `bun run dev:api`, then retry."
- Empty states explain what the thing is and offer the action: "No projects yet. A project is one app's backend: ..." + Create project.
- Show API error messages verbatim inline next to the field that caused them, not in a toast.
- Success goes in a toast (bottom right). Errors stay on screen until fixed.

## Interaction patterns

| Need | Pattern |
|---|---|
| Find anything | Command menu (Ctrl/⌘ K): actions, projects, pages, appearance |
| Confirm an action | `ConfirmDialog` (alert dialog): title names the action and target, description says what happens, confirm button repeats the action's name. Destructive actions get the destructive button |
| Create something | Dialog with a single focused field, Enter submits; after success go to the list where the new item is visible |
| Filter a list | Search input above the table; the filter is kept in the URL (`#/projects?q=...`) and replaces history so Back isn't polluted |
| Dates | Relative ("3 hours ago"), exact date/time on hover via `title` |
| Navigation state | Hash routes (`#/projects`, `#/projects/<name>/database/sql`, `#/settings`) so every view, including each tab and the selected table, has a linkable URL |
| Loading | Skeleton lines in the shape of the content, never a full-page spinner |
| API down | Inline dashed panel with the API URL, the command to start it, and Retry |

## Accessibility floor

- Visible focus ring (3px, accent at 50%) on every interactive element. Never remove outlines without replacing them.
- All icon-only buttons have an `aria-label`. The current nav item has `aria-current="page"`.
- Body text meets WCAG AA contrast in both modes; check new colors before adding them.
- Everything is reachable and usable by keyboard alone.

## Building UI

- **Stack:** React 19, Tailwind v4, shadcn/ui (new-york style, Radix, lucide icons), served by Bun's HTML import with `bun-plugin-tailwind`. No Vite, no Next.
- **Add shadcn components** from `apps/dashboard`: `bunx --bun shadcn@latest add <name>`. Then check the new file imports `cn` from `@/lib/utils` (the CLI has wrongly imported it from an npm package called `cn` before) and doesn't pull in `next-themes` (use `useTheme` from `@/lib/theme`).
- Files in `src/components/ui` are owned shadcn code. Change them only to fix tokens or behavior for the whole app; put app-specific UI in `src/components`.
- Pages live in `src/pages`, one file each, and start with `<PageHeader>`. A page with tabs gets a folder (`src/pages/database/`), one file per tab. Pages inside a project wrap their content in `<ProjectGate>`, which handles the loading, offline, and not-found states.
- When you add a top-level page, add it to `useLinks` (outside-a-project links) or the bottom group in `app-shell.tsx` and to the command menu. A service page goes in `SERVICE_PAGES` (`service-card.tsx`), which also puts it in the rail inside a project, and the command menu's project group instead. When you add an action, add it to the command menu.
