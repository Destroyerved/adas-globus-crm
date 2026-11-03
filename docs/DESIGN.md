# ADAS CRM design system

The CRM uses the same visual language as **adasglobuspro.com**, tuned for an app people use all day. The website's source of truth is `assets/css/styles.css` in the website repository. Every value below is taken from it unless marked **new**.

> **In one line:** an off-white canvas, white panels with hairline borders, charcoal ink, one teal action colour, a navy sidebar with a cyan marker, light-weight big numbers, pill buttons, and almost no shadow or motion.

---

## 1. Principles

1. **Same brand, denser room.** Keep the website's colours, typeface, hairlines and pill shapes. Drop its marketing scale: smaller type, tighter spacing, no scroll animations.
2. **Hairlines over boxes.** Separate things with 1px `--line` borders and whitespace, not shadows or heavy fills.
3. **One action colour.** Teal (`--primary`) means "do something". Blue (`--blue`) is for focus rings, links in dense text and information, never for primary buttons.
4. **Light numbers, bold labels.** Big figures use weight 300, like the website's stats band. Labels and names carry the weight.
5. **Navy frames the work.** Navy appears in the sidebar, the bulk-action bar and the login screen. It never fills content panels.
6. **Calm by default.** Colour signals status only. A screen with nothing wrong is mostly ink, white and teal.
7. **Keyboard first.** Every action is reachable without a mouse, and focus is always visible.

## 2. What carries over and what changes

| Element | Website | CRM |
|---|---|---|
| Canvas | `#FBFCFB` off-white | Same |
| Panels and cards | White, 1px `--line`, radius 10px | Same |
| Typeface | Hanken Grotesk 300–700 | Same, self-hosted |
| Body size | 17px | **14px** (dense data) |
| Headlines | Light 300 with one bold phrase | Page titles only; record names use 600 |
| Buttons | Pills, 52px and 44px tall | Pills, **36px** default, 32px small, 40px large |
| Inputs | 48px tall, radius 8px, border `#BFC8CA` | **36px** tall, radius 8px, border **`#8A959C`** (see 9.1) |
| Dark band and footer | Navy `#041C3E` / `#06121F` | Navy sidebar, bulk-action bar, login |
| Kicker (28px teal bar before a label) | Section intros | Profile section headers |
| Eyebrow (small uppercase, tracked) | Tags and labels | Sidebar groups, timeline day headers |
| Glass tile mosaic | Hero photos, band corners | Empty states and login only |
| Motion | Reveals, wipes, counters | Hover and state changes only, 120–280ms |
| Charts | Blue `#2F64A8` + teal `#00A3A3`, hairline grid, table toggle | Same rules |
| Dark mode | None | None in v1; tokens ready for it |

## 3. Tokens

Put these in `apps/web/src/styles/tokens.css`. Components MUST use tokens (or the Tailwind classes generated from them), never raw hex values.

```css
:root {
  /* Surfaces (website) */
  --bg: #FBFCFB;            /* app canvas */
  --bg-alt: #F1F3F2;        /* hover rows, Kanban columns, muted fills */
  --surface: #FFFFFF;       /* panels, cards, inputs, menus */
  --tint: #E5F1F2;          /* selected rows, brand badges, callouts */

  /* Ink (website) */
  --ink: #0F1B2A;           /* primary text */
  --ink-2: #445161;         /* secondary text */
  --ink-3: #646F7C;         /* meta, placeholders, table headers */
  --line: #DCE2E2;          /* hairlines, panel borders */
  --line-strong: #BFC8CA;   /* dividers that need more weight, disabled borders */
  --line-field: #8A959C;    /* NEW: form-control borders (3:1 on white) */

  /* Brand (website) */
  --primary: #00778A;       /* primary buttons, active states, links */
  --primary-ink: #005E6D;   /* primary hover, teal text on tint */
  --blue: #015FA7;          /* focus ring, info, inline links. The website calls this --accent;
                               renamed because shadcn uses --accent for a grey hover fill */
  --navy: #041C3E;          /* sidebar, bulk bar, login band */
  --navy-2: #0A2B52;        /* sidebar hover and active item */
  --navy-line: rgba(255, 255, 255, 0.13);
  --cyan: #63DFE9;          /* active marker on navy only */

  /* Status tones (NEW except danger and warning, which the website uses) */
  --success: #067647;  --success-bg: #ECFDF3;
  --warning: #7A4F00;  --warning-bg: #FFF1D6;
  --danger:  #B42318;  --danger-bg:  #FEF3F2;
  --info:    #015FA7;  --info-bg:    #E8F1FA;
  --neutral: #445161;  --neutral-bg: #F1F3F2;
  --brand:   #005E6D;  --brand-bg:   #E5F1F2;

  /* Charts (website, validated for colour-blind separation) */
  --chart-1: #2F64A8;       /* primary series */
  --chart-2: #00A3A3;       /* comparison series */
  --chart-muted: #9AA5AE;   /* NEW: "other", "lost", baselines */

  /* Shape */
  --radius: 10px;           /* panels and cards */
  --radius-field: 8px;      /* inputs, menus, small cards */
  --radius-dialog: 14px;    /* dialogs and the login card */
  --radius-pill: 999px;     /* buttons, chips, badges */

  /* Elevation (website values) */
  --shadow-pop: 0 12px 30px -14px rgba(15, 27, 42, 0.4);     /* menus, popovers, tooltips */
  --shadow-lift: 0 18px 40px -28px rgba(15, 27, 42, 0.35);   /* hover on clickable cards, drag */
  --shadow-dialog: 0 30px 60px -30px rgba(4, 28, 62, 0.45);  /* dialogs, drawers */
  --scrim: rgba(4, 28, 62, 0.4);                             /* NEW: navy-tinted overlay */

  /* Focus (website) */
  --focus-ring: 0 0 0 2px var(--surface), 0 0 0 4px var(--blue);
  --field-focus: 0 0 0 3px rgba(0, 119, 138, 0.18);
  --field-invalid: 0 0 0 3px rgba(180, 35, 24, 0.1);

  /* Motion (website easing) */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-fast: 120ms;
  --dur-base: 200ms;
  --dur-slow: 280ms;

  /* Type */
  --font: "Hanken Grotesk Variable", "Hanken Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;

  /* Layout */
  --sidebar-w: 248px;
  --sidebar-w-collapsed: 64px;
  --topbar-h: 56px;
  --content-max: 1240px;    /* website --max; forms and profiles */
}
```

### 3.1 shadcn/ui and Tailwind v4 mapping

shadcn uses its own variable names. **Watch the clash:** shadcn's `--accent` means a subtle hover background, not the website's brand blue. That's why the brand blue is `--blue` in `tokens.css`, and shadcn's `--accent` maps to `--bg-alt`. `--primary` and `--radius` mean the same thing in both systems, so `tokens.css` already sets them.

```css
@import "tailwindcss";
@import "./tokens.css";

:root {
  --background: var(--bg);
  --foreground: var(--ink);
  --card: var(--surface);             --card-foreground: var(--ink);
  --popover: var(--surface);          --popover-foreground: var(--ink);
  /* --primary comes from tokens.css */ --primary-foreground: #FFFFFF;
  --secondary: var(--tint);           --secondary-foreground: var(--primary-ink);
  --muted: var(--bg-alt);             --muted-foreground: var(--ink-3);
  --accent: var(--bg-alt);            --accent-foreground: var(--ink);   /* hover fill, NOT brand blue */
  --destructive: var(--danger);
  --border: var(--line);
  --input: var(--line-field);
  --ring: var(--info);
  --sidebar: var(--navy);
  --sidebar-foreground: rgba(255, 255, 255, 0.72);
  --sidebar-primary: var(--cyan);     --sidebar-primary-foreground: var(--navy);
  --sidebar-accent: var(--navy-2);    --sidebar-accent-foreground: #FFFFFF;
  --sidebar-border: var(--navy-line);
  --sidebar-ring: var(--cyan);
}

@theme inline {
  --font-sans: var(--font);
  --font-mono: var(--mono);

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);

  /* Brand names for direct use: bg-tint, text-ink-2, border-line ... */
  --color-ink: var(--ink);
  --color-ink-2: var(--ink-2);
  --color-ink-3: var(--ink-3);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong);
  --color-bg-alt: var(--bg-alt);
  --color-tint: var(--tint);
  --color-primary-ink: var(--primary-ink);
  --color-blue: var(--blue);
  --color-navy: var(--navy);
  --color-navy-2: var(--navy-2);
  --color-cyan: var(--cyan);
  --color-success: var(--success);   --color-success-bg: var(--success-bg);
  --color-warning: var(--warning);   --color-warning-bg: var(--warning-bg);
  --color-danger: var(--danger);     --color-danger-bg: var(--danger-bg);
  --color-info: var(--info);         --color-info-bg: var(--info-bg);
  --color-neutral: var(--neutral);   --color-neutral-bg: var(--neutral-bg);
  --color-brand: var(--brand);       --color-brand-bg: var(--brand-bg);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-muted: var(--chart-muted);

  --radius-sm: 6px;
  --radius-md: var(--radius-field);
  --radius-lg: var(--radius);
  --radius-xl: var(--radius-dialog);
}

body {
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font);
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
```

After running the shadcn CLI, restyle the generated components to this document (pill buttons, 36px controls, hairline tables). Keep them in `apps/web/src/components/ui`. Don't fork them per feature.

## 4. Typography

Self-host **Hanken Grotesk** (variable, weights 300–700), for example through the Fontsource package. Don't load Google Fonts at runtime: the app is internal and should not depend on, or report to, a third party.

| Style | Size / line height | Weight | Tracking | Use |
|---|---|---|---|---|
| `display` | 28 / 34 | 300; `<strong>` 650 | -0.02em | Page titles ("**Leads** 12,480"), dashboard greeting |
| `title-lg` | 22 / 28 | 600 | -0.015em | Record name in a profile header |
| `title` | 17 / 24 | 600 | -0.01em | Panel, dialog and drawer titles |
| `body` | 14 / 20 | 400 | 0 | Default text, table cells (comfortable) |
| `body-sm` | 13 / 18 | 400 | 0 | Compact table cells, meta lines, help text |
| `label` | 13 / 18 | 600 | 0 | Form labels, table headers (in `--ink-3`) |
| `eyebrow` | 11.5 / 16 | 650 | 0.12em, uppercase | Sidebar group labels, timeline day headers, profile section labels |
| `kpi` | 32 / 36 | 300 | -0.035em | KPI tiles; tabular numbers |
| `kpi-lg` | 44 / 48 | 300 | -0.04em | One headline number per dashboard at most |
| `mono` | 12.5 / 18 | 400 | 0 | IDs, API tokens, technical values |

- Numbers in tables, KPIs and money use `font-variant-numeric: tabular-nums`.
- The website pattern of a light headline with **one** bold phrase is used only for `display` titles. Never bold more than one phrase.
- Sentence case everywhere, including buttons and titles. Uppercase only for `eyebrow`.

## 5. Layout

```text
┌──────────┬──────────────────────────────────────────────────────────────┐
│          │  Top bar 56px: [Search  Ctrl K]            [+ New] [🔔] [VS] │
│  NAVY    ├──────────────────────────────────────────────────────────────┤
│ SIDEBAR  │  Page header: display title · count        [Secondary] [Primary]
│  248px   │  View tabs (underline) ─────────────────────────────────────  │
│          │  Filter chips · search · columns · density                   │
│ WORK     │  ┌────────────────────────────────────────────────────────┐  │
│  ▍Dash   │  │ White panel, 1px line, radius 10                       │  │
│   Inbox  │  │ Table / board / profile content                        │  │
│   Tasks  │  └────────────────────────────────────────────────────────┘  │
│ RECORDS  │                                                              │
│   ...    │            ┌ navy bulk-action bar appears on selection ┐     │
└──────────┴──────────────────────────────────────────────────────────────┘
```

- **Spacing scale:** 4px base (4, 8, 12, 16, 20, 24, 32, 40, 48).
- **Page padding:** 24px desktop, 16px under 768px. No horizontal page scroll at any width; wide tables scroll inside their panel.
- **Widths:** lists and boards are fluid. Forms, settings and profile main columns cap at `--content-max` (1240px).
- **Profile layout:** a main column plus a 320px right rail. Under 1100px the rail moves above the tabs as a collapsible "About" panel.
- **Breakpoints:** 768px (sidebar becomes a drawer; top bar shows a menu button), 1100px (profile rail stacks), 1440px (more table columns visible by default).

### 5.1 Sidebar

- Background `--navy`. Width 248px; collapses to 64px (icons only, tooltips on hover), and the choice is remembered per user.
- Top: the company logo in white (the website does this with `filter: brightness(0) invert(1)` on `logo.avif`); collapsed, the navy "AGP" square mark from the website wordmark.
- Group labels in `eyebrow` style at 62% white.
- Item: 36px tall, 8px radius, icon 18px plus label at 14px/500, text at 72% white.
- Hover: `--navy-2` fill, white text.
- Active: `--navy-2` fill, white text, weight 600, and a **2px cyan bar** on the left edge (the website's cyan line motif).
- Counts (for example overdue tasks) appear as small pills: `--navy-2` background with cyan text; danger counts use `--danger-bg` with `--danger` text.

### 5.2 Top bar

- Background `rgba(251, 252, 251, 0.94)` with `backdrop-filter: blur(12px)` and a 1px bottom `--line`, like the website header. Gains `0 6px 24px -18px rgba(15, 27, 42, 0.5)` when content scrolls under it.
- Search field: 36px pill, `--surface`, `--line-field` border, placeholder "Search or jump to… Ctrl K".
- **New** button: primary pill, small, with a plus icon. It opens a menu.

### 5.3 Page header

- Optional kicker above the title (a 28px × 2px teal bar plus 13px/500 `--ink-2` text, from the website's `.kicker`).
- Title in `display`, with the record count in `--ink-3` at weight 300.
- Actions on the right: at most one primary pill, then outline or ghost buttons; overflow goes in a "More" menu.
- View tabs underneath: 14px/500 labels with the website's nav underline (2px `--primary`, grows from the left over 350ms on hover, stays on the active tab).

## 6. Components

### 6.1 Buttons

| Variant | Look | Use |
|---|---|---|
| Primary | `--primary` fill, white 600 text; hover `--primary-ink` | One per view: the main action |
| Outline | 1px `--primary` border, `--primary-ink` text; hover fills teal with white text | Secondary actions |
| Ghost | No border, `--ink-2` text; hover `--bg-alt` | Toolbar and row actions |
| Danger | `--danger` fill, white text | Destructive confirmation only, inside dialogs |
| Link | `--primary-ink`, 600, arrow icon that moves 3px on hover (website `.link-arrow`) | "View all", "Open report" |

- Pill radius always. Heights: 32 (sm), 36 (default), 40 (lg). Horizontal padding 14 / 16 / 20px. Gap between icon and label 8px.
- Press: `scale(0.98)`. Disabled: 50% opacity, no hover.
- Icon-only buttons are 32px circles with an `aria-label` and a tooltip.

### 6.2 Form controls

- Label above the field (`label` style). Optional fields say "(optional)" in `--ink-3`, as the website forms do. No placeholder-only labels.
- Inputs, selects, comboboxes, date pickers: 36px tall, radius 8px, `--surface` background, 1px `--line-field` border, 14px text, 12px horizontal padding.
- Focus: border `--primary` plus `--field-focus` ring (the website's form focus).
- Invalid: border `--danger` plus `--field-invalid` ring, and the message below in 13px `--danger` with an icon. Move focus to the first invalid field on submit.
- Checkbox and radio: 16px, radius 4px for checkboxes, checked fill `--primary`.
- Switch: 32 × 18px, track `--line-strong` when off and `--primary` when on.
- Help text: 13px `--ink-3` under the field.
- Create forms open in a right-side **drawer** (480px; full width on mobile). Large editors (campaign builder, import mapping) get a full page.

### 6.3 Chips and filters

- From the website's chips: pill, 1px `--line-strong` border, `--surface`, 13px/500, 28px tall in the app.
- Hover: border `--primary`. Selected or active filter: `--primary` fill, white text, with a check icon that slides in.
- An active filter chip reads as "Market: US ×". Clicking it edits; the × removes it.
- "Add filter" is a ghost chip with a plus icon.

### 6.4 Status badges

Pill, 22px tall, 12px/600, sentence case, tone background and text. Never rely on colour alone: the label is always there, and an icon is added where it helps (for example a clock for overdue).

| Tone | Text / background | Used for |
|---|---|---|
| `neutral` | `--neutral` / `--neutral-bg` | Researching, Contacted, Draft, Disqualified, Unsubscribed |
| `info` | `--info` / `--info-bg` | New, Scheduled, Free trial |
| `brand` | `--brand` / `--brand-bg` | Engaged, open deal stages, Active sequence |
| `success` | `--success` / `--success-bg` | Qualified, Converted, Won, Delivered, Valid email |
| `warning` | `--warning` / `--warning-bg` | Due today, Risky email, Pending approval, Paused, basis expiring soon |
| `danger` | `--danger` / `--danger-bg` | Overdue, Lost, Bounced, Complained, Suppressed, Failed, SLA breached |

Market badges: "US" and "CA" in `neutral`, 11.5px/650 with 0.06em tracking.

### 6.5 Tables

The workhorse. Based on the website's `.rows` and `.chart-table` patterns.

- Inside a white panel (1px `--line`, radius 10). No zebra stripes.
- Header row: 36px, `label` style in `--ink-3`, 1px `--line` bottom border, sticky. Sortable headers show an arrow on hover and when active.
- Rows: 44px comfortable or 36px compact (user toggle, remembered), with a 1px `--line` bottom border. Hover `--bg-alt`.
- Selected rows: `--tint` background plus a 2px `--primary` bar on the left.
- First column: checkbox, then the primary name in 600 `--ink` as a link (no underline until hover). The first two columns stick when scrolling horizontally.
- Numbers and money are right-aligned and tabular. Dates are left-aligned. Empty values show "—" in `--ink-3`.
- Long text truncates with an ellipsis; full text appears in a tooltip and on the record.
- Row actions appear on hover or focus at the right end (ghost icon buttons) and in a context menu.
- Server-side pagination or virtualised infinite scroll. Never load all rows.
- **Bulk-action bar:** when rows are selected, a navy pill bar floats at the bottom centre: "**12 selected** · Assign · Change status · Add tag · Add to sequence · Export · More · ×". Text white, the count in cyan, buttons ghost on navy (white 72%, hover `--navy-2`).

### 6.6 Panels and cards

- Panel: `--surface`, 1px `--line`, radius 10, padding 20px, no shadow. The title row uses `title` with optional actions on the right.
- Clickable card: same, plus on hover `translate: 0 -2px`, `--line-strong` border and `--shadow-lift` (the website's `.card--hover`, shortened to 200ms).
- Callout: `--tint` background, 3px `--primary` left border, radius `0 10px 10px 0`, from the website's `.callout`. Use it for inline notices such as "This contact has no marketing basis, so sequences will skip them." Warning and danger callouts swap in their tone colours.

### 6.7 KPI tiles

From the website's stats band:
- A row of tiles inside one panel, divided by 1px `--line` vertical rules rather than separate boxes.
- Number in `kpi` (300 weight, tabular). Label below in 13px `--ink-2`, at most 2 lines.
- Change vs the previous period as a small text chip: a ▲/▼ arrow, a signed value and a tone (`success` or `danger`, `neutral` when flat). Never colour alone.
- The whole tile is a link to the list behind the number.

### 6.8 Kanban board

- Columns 288px wide on `--bg-alt`, radius 10, 8px padding, 12px gaps. Horizontal scroll inside the board area.
- Column header: stage name 600, count in `--ink-3`, total value (tabular, reporting currency) and probability in `--ink-3` 13px.
- Deal card: `--surface`, 1px `--line`, radius 8, 12px padding. Company name 600; deal name `--ink-2`; monthly value plus currency on the right; owner avatar; badges for "Trial ends in 2 days" (warning) or "Idle 21 days" (danger).
- Dragging: `--shadow-lift`, no rotation, the source slot shown as a dashed `--line-strong` outline. Drop targets highlight with `--tint`.
- Won and Lost are collapsed drop zones at the end of the board, with counts.
- Keyboard: focus a card, press Space to pick it up, arrow keys to move, Space to drop, Escape to cancel. Announce moves to screen readers (dnd-kit's announcements).

### 6.9 Record profile

- **Header:** an eyebrow with the record type, the name in `title-lg`, then a meta line in `--ink-2` (company · market badge · owner · local time). Status badge and main actions on the right.
- **Tabs:** underline style (5.3).
- **Right rail:** "About" key-value list in the website `.rows` style (label 600 on the left, value `--ink-2` on the right, hairlines between), followed by associated records and the next task.
- **Inline edit:** click a value to edit in place; Enter saves and Escape cancels. A saved value briefly shows a small check icon, with no colour flash.

### 6.10 Activity timeline

- A vertical 1px `--line` rail on the left, with a 9px dot per entry. User actions get a `--primary` dot with a soft halo `0 0 0 4px rgba(0, 119, 138, 0.12)` (the website's day-timeline dot); system entries get an `--ink-3` dot without a halo.
- Day headers in `eyebrow` style ("TODAY", "3 NOV 2026").
- Entry: an icon for the type, the summary in 14px with the actor in 600, the time in `--ink-3` on the right. Email entries expand inline. Bodies longer than 4 lines collapse.
- A quick-log bar at the top: Note · Call · Meeting · Email · Task.

### 6.11 Dialogs, drawers, menus, toasts

- **Dialog:** `--surface`, radius 14, `--shadow-dialog`, overlay `--scrim`. Width 480 (default) or 640. Title in `title`; actions bottom-right, with the primary action last.
- **Drawer:** from the right, same surface and shadow, radius 0, slides in over 280ms with `--ease-out`.
- **Menus and popovers:** `--surface`, 1px `--line`, radius 8, `--shadow-pop`, 4px padding, 32px items with an `--bg-alt` hover.
- **Toast:** bottom-right, `--surface`, radius 8, `--shadow-pop`, a 3px left bar in the tone colour, 14px text plus an optional Undo link. It dismisses after 5 seconds and pauses on hover.
- **Confirm destructive actions** in a dialog that names the object and count ("Delete 12 leads?"). The Danger button repeats the verb ("Delete 12 leads").

### 6.12 Command palette

- Ctrl/⌘ K opens it: a centred dialog, 640px wide, with a search input at the top.
- Results group into Records, Actions ("New deal", "Log call") and Navigation, each under an eyebrow label.
- Arrow keys move, Enter opens, Tab cycles groups. Recent items show when the query is empty.

### 6.13 Empty, loading and error states

Every list, panel and widget designs all four states: loaded, empty, loading and error.

- **Empty:** centred in the panel. A small 2×2 glass-tile cluster (see below), a title in `title`, one line of `--ink-2` explaining what goes here, and one primary or outline action. Example: "No leads yet · Import a spreadsheet or add one by hand · [Import leads]". Filtered-empty says so and offers "Clear filters".
- **Loading:** skeleton rows and blocks in `--bg-alt` with a slow shimmer (off under reduced motion). No spinners for page loads; a 16px spinner only inside buttons that are working.
- **Error:** an inline danger callout with what failed in plain words, a Retry button and a request ID in `mono` for support.

The tile cluster, taken from the website's `.feature-tiles`:

```css
.tile-cluster { display: grid; grid-template-columns: repeat(2, 22px); grid-template-rows: repeat(2, 22px); }
.tile-cluster i:nth-child(1) { background: rgba(0, 163, 163, 0.22); }
.tile-cluster i:nth-child(2) { background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
.tile-cluster i:nth-child(3) { grid-column: 2; box-shadow: inset 0 0 0 1px rgba(0, 94, 109, 0.25); }
```

### 6.14 Login screen

The only expressive screen. Split layout: on the left, a navy band (like the website's `.dark` section) with the white logo, the title "ADAS **CRM**" in `display` scaled to 44px, one line in 72% white, and the website's corner tile cluster (`.band-tiles`). On the right, the canvas with a white card (radius 14, `--shadow-dialog`) holding "Sign in with Microsoft" (primary pill, full width) and a small "Admin sign-in" link for break-glass. On mobile the band shrinks to a header.

### 6.15 Public pages (unsubscribe and click)

Served on `go.adasglobuspro.com` to recipients. Use the **website** scale (17px body, 52px pill buttons), the off-white canvas, the logo and a single white card: "Unsubscribe **jane@firm.com** from ADAS Globus Pro emails?" → [Unsubscribe]. Then the confirmation. No navigation and no tracking scripts.

## 7. Charts

- Use Recharts through shadcn's chart wrapper, styled to match the website chart: 1px `--line` gridlines (horizontal only), 12px `--ink-3` axis labels with tabular numbers, no chart borders, 2px top radius on bars.
- **Colour:** one series uses `--chart-1` (blue). A two-series comparison uses `--chart-1` and `--chart-2`. "Other", "Lost" and baselines use `--chart-muted`. Don't add categorical colours. Prefer a sorted horizontal bar chart (one colour) for anything with more than 3 categories, such as leads by source.
- No pie or donut charts with more than 3 slices. No 3D, no gradients, no dual axes.
- Tooltip in the website `.chart-tip` style: white, 1px `--line`, radius 8, `--shadow-pop`, title 650, rows with a 12 × 2px colour key and tabular values.
- Every chart has a **"View as table"** toggle (the website's `.chart-table` pattern) and a text summary for screen readers.
- Won vs lost: Won in `--chart-1`, Lost in `--chart-muted`, both labelled. Don't use green against red.
- Interactive highlighting dims the other series to 38% opacity, as the website chart does.

## 8. Icons

- Lucide, `strokeWidth={1.6}` with round caps and joins (the website's icon stroke). Sizes: 16 (inline and badges), 18 (sidebar, buttons), 20 (headers), 40 (empty states, at stroke 1.4).
- Icons inherit `currentColor`. One icon per concept everywhere:

| Concept | Lucide icon (or nearest current name) |
|---|---|
| Dashboard | `layout-dashboard` |
| Inbox | `inbox` |
| Tasks | `list-checks` |
| Leads | `user-plus` |
| Contacts | `users` |
| Companies | `building-2` |
| Deals | `handshake` |
| Outreach | `send` |
| Reports | `chart-column` |
| Settings | `settings` |
| Call | `phone` |
| Meeting | `calendar` |
| Email | `mail` |
| Note | `sticky-note` |
| Trial | `flask-conical` |
| Suppressed | `ban` |
| Overdue | `clock-alert` |

## 9. Accessibility

Target: **WCAG 2.2 AA**.

### 9.1 Verified contrast

Measured with the WCAG 2 formula. Text needs 4.5:1 (3:1 for large text); UI component boundaries and graphics need 3:1.

| Pair | Ratio | Use |
|---|---|---|
| `--ink` on `--bg` | 16.87 | Body text |
| `--ink-2` on `--bg` | 7.87 | Secondary text |
| `--ink-3` on `--surface` | 5.11 | Meta text on panels |
| `--ink-3` on `--bg-alt` | 4.59 | Meta text on hovered rows (passes, just) |
| White on `--primary` | 5.24 | Primary button |
| `--primary-ink` on `--tint` | 6.45 | Brand badge, selected row text |
| `--blue` on `--surface` | 6.57 | Links, info |
| White at 72% on `--navy` | 9.15 | Sidebar items |
| `--cyan` on `--navy-2` | 8.96 | Active count pills |
| `--success` on `--success-bg` | 5.40 | Success badge |
| `--warning` on `--warning-bg` | 6.38 | Warning badge |
| `--danger` on `--danger-bg` | 6.05 | Danger badge |
| `--info` on `--info-bg` | 5.75 | Info badge |
| `--neutral` on `--neutral-bg` | 7.26 | Neutral badge |
| `--chart-1` on `--surface` | 5.98 | Primary chart series |
| `--chart-2` on `--surface` | 3.10 | Comparison series (graphics only, never text) |
| `--line-field` on `--surface` | 3.06 | Input borders |
| `--line-strong` on `--surface` | 1.70 | Decorative dividers only; **not** for input borders |

`--line-field` is new because the website's input border (`#BFC8CA`, 1.70:1) doesn't meet the 3:1 rule for form controls. It is a deliberate, small departure.

### 9.2 Rules

- Visible focus on everything: a 2px `--blue` outline with offset, never removed.
- Minimum target 24 × 24px (WCAG 2.2). Default controls are 32–36px; on touch screens, row actions grow to 44px.
- Every input has a programmatic label. Errors are linked with `aria-describedby` and announced.
- Status is never colour-only: badges have text, deltas have arrows and signs, charts have tables.
- Tables use real `<table>` semantics (or a correct ARIA grid when virtualised), with sortable headers announced.
- Live regions announce toasts, background job completion and Kanban moves.
- Respect `prefers-reduced-motion`: no shimmer, no slide-ins, instant state changes.
- Run axe in Playwright on every main screen in CI.

### 9.3 Keyboard map

| Keys | Action |
|---|---|
| Ctrl/⌘ K | Command palette and search |
| `/` | Focus the list search box |
| `N` | New record of the current type |
| `G` then `H`, `I`, `T`, `L`, `C`, `O`, `D`, `R` | Go to Home (dashboard), Inbox, Tasks, Leads, Contacts, Organisations (companies), Deals, Reports |
| `J` / `K` | Next / previous row or card |
| Enter | Open the focused record |
| `E` | Edit the focused field or record |
| `X` | Select the focused row |
| `L` then `C`, `M`, `N` | Log call, meeting or note on the open record |
| Escape | Close the dialog, drawer or palette, or cancel an edit |
| `?` | Show all shortcuts |

Shortcuts never fire while typing in a field.

## 10. Content and formatting

- **Voice:** the website's plain, direct English. Short sentences, sentence case, no jargon, no exclamation marks.
- **Buttons say what they do:** "Assign lead", "Send email", "Import 1,240 contacts", not "Submit" or "OK".
- **Errors say what happened and what to do:** "This email already belongs to Jane Patel at Acme CPA. Open her record or use a different email."
- **Empty states explain the value:** "Tasks you schedule appear here, with today's at the top."
- **Dates:** `4 Nov 2026` (unambiguous for teams in India, the U.S. and Canada). Relative times for the last 7 days ("2 h ago", "Yesterday") with the absolute date and time in a tooltip.
- **Times:** `9:30 am` in the viewer's zone. When a time belongs to someone else's zone, label it: "9:30 am Toronto (8:00 pm IST)".
- **Numbers:** Western grouping (`1,250,000`) for everyone, including users in India. Never lakh or crore grouping, so figures match what clients see.
- **Money:** always mark the currency: `US$12,500`, `CA$12,500`, `US$4.5k/mo`. Reports in the reporting currency show the original on hover.
- **Names:** "First Last" in lists; the company appears after a middot: "Jane Patel · Acme CPA".
- **Counts:** "1 lead", "12 leads"; "No leads", not "0 leads".

## 11. Motion

| Interaction | Duration | Easing |
|---|---|---|
| Colour, border and background on hover | 120ms | linear |
| Menus, popovers, tooltips (fade plus 4px rise) | 200ms | `--ease-out` |
| Tab underline growth | 350ms | `--ease-out` |
| Drawers | 280ms | `--ease-out` |
| Card lift on hover | 200ms | `--ease-out` |

No entrance animations for data, no number counters, no parallax, no spring effects, nothing that loops except the loading shimmer. Everything turns off under reduced motion.

## 12. Don'ts

- Don't use gradients, glassmorphism on content, or decorative shadows on panels.
- Don't use teal and blue together as two competing action colours.
- Don't put navy behind content panels or tables.
- Don't use more than one bold phrase in a title, or bold inside table cells except the primary name.
- Don't use cyan outside navy surfaces. It fails contrast on white.
- Don't rely on colour alone for status.
- Don't use raw hex values in components. Add a token if something is missing, and record it here.
- Don't ship a screen without its empty, loading and error states.
- Don't use the website's marketing scale (17px body, 52px buttons) inside the app; it belongs only on public pages (6.15).
