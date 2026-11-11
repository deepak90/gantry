# Design system

The web app's look comes from two stylesheets in `apps/web/src/styles/`:

- `tokens.css`: every color, font size, space, radius, shadow and duration, as CSS variables.
- `ui.css`: the shared components (buttons, pills, cards, panel headers, empty states, notes,
  fields, segmented controls, menus).

Panel stylesheets lay things out and use these; they do not define colors or their own buttons.

## Principles

1. **One way to do each thing.** One button family, one pill family, one card, one panel header.
2. **Red means act now.** Red is for danger and "needs attention" only: never a phase, crew, task
   or decoration color.
3. **The story lives on the chart.** State shows on bars, bands and badges before it shows in panels.
4. **Quiet on load.** The plan does not judge itself when it opens; findings appear when someone
   asks the assistant or a rule they made fires.
5. **Dense but legible.** Tabular numbers, 11px minimum, WCAG AA contrast for all text.
6. **US English.** Every label, message, seed name and assistant reply uses US spelling (color,
   Harbor, labor, center, canceled); dates and money format as `en-US`.

## Color roles

| Role | Tokens | Use |
| --- | --- | --- |
| Text | `--ink`, `--ink-soft`, `--ink-faint` | Body, secondary, tertiary text and icons (all AA on white) |
| Surfaces | `--surface`, `--surface-sunken`, `--surface-hover`, `--canvas` | Panels, wells, hover rows, the app background |
| Lines | `--line-soft`, `--line`, `--line-strong` | Dividers, borders, control borders |
| Accent (cobalt) | `--accent`, `--accent-strong`, `--accent-soft`, `--accent-line` | Selection, focus, links, "in progress" |
| Danger (red) | `--danger`, `--danger-strong`, `--danger-soft`, `--danger-line` | Errors, overdue, over budget once flagged, destructive actions |
| Warning (amber) | `--warning`, `--warning-fill`, `--warning-soft`, `--warning-line` | Caution, waiting on someone |
| Success (green) | `--success`, `--success-fill`, `--success-soft`, `--success-line` | Done, paid, approved |
| Categories | `--cat-0` … `--cat-5`, `--cat-none` | Phase colors (muted; white text at 5:1 or better) |
| PayPal | `--paypal-navy`, `--paypal-blue` | The Paid state only (the Paid pill, paid bars and tags). Never PayPal gold, and never on a button |

Primary buttons are ink, not accent: the accent marks where you are, ink marks what to do.

## Type

Archivo (variable, self-hosted from `@fontsource-variable/archivo`). Headings and names use the wide
cut (`--stretch-display`), UI text the normal width, dense grid cells may use `--stretch-dense`.
Sizes: `--fs-2xs` (11px) to `--fs-3xl` (28px). Numbers in tables use `.num` (tabular figures).

## Space, radii, elevation, motion

- Space: a 4px scale, `--space-3xs` (2px) to `--space-3xl` (48px); use `gap` between siblings.
- Radii: `--radius-xs` 3px · `--radius-sm` 5px · `--radius-md` 7px (controls) · `--radius-lg` 10px
  (cards, popovers) · `--radius-xl` 14px (dialogs) · `--radius-pill`.
- Shadows: `--shadow-xs` (controls), `--shadow-sm` (hovered cards), `--shadow-md` (popovers),
  `--shadow-lg` (menus, dialogs). Focus: `--focus-ring`.
- Motion: `--dur-fast` / `--dur` / `--dur-slow` with `--ease-out`; all zero under reduced motion.

## Components (ui.css)

```html
<button class="button is-primary">Approve</button>        <!-- the one main action -->
<button class="button">Cancel</button>                    <!-- secondary -->
<button class="button is-quiet is-icon" aria-label="Close"><i class="fa fa-xmark"></i></button>
<button class="button is-danger">Delete</button>
<button class="button is-link">Show in plan</button>
<button class="button is-primary">Review payment</button> <!-- a pay action: our own button, then the payout sheet -->

<span class="pill is-success">Paid</span>
<span class="pill is-label"><i class="pill-dot" style="--pill-dot: …"></i>Electrical</span>

<div class="card">…</div>
<header class="panel-head">
  <div class="panel-head-text"><h2 class="panel-head-title">Crews</h2><p class="panel-head-sub">…</p></div>
  <div class="panel-head-actions">…</div>
</header>
<p class="section-label">Rented equipment</p>
<div class="empty-state"><p class="empty-state-title">No rules yet</p><p>…</p><button class="button">…</button></div>
<div class="note is-warning"><i class="fa fa-triangle-exclamation"></i>…</div>
<label class="field"><span class="field-label">Name</span><input class="input"></label>
<div class="segmented"><button aria-pressed="true">All</button><button>In progress</button></div>
<div class="popover"><button class="menu-item"><i class="fa fa-pen"></i>Rename</button></div>
<button class="switch" role="switch" aria-checked="true"><span></span></button>
<label class="input-icon"><i class="fa fa-magnifying-glass"></i><input class="input" placeholder="Search"></label>
<span class="pill is-info">Erect steel<button class="pill-remove" aria-label="Leave it out">×</button></span>
```

Sizes and variants: `.is-sm` on pills, notes and inputs; `button.pill` is clickable; `.button.is-on-ink`
for the dark header; `.panel-head-icon` is a neutral tile before a panel title. `.segmented` styles
`aria-pressed`, `aria-selected` and `aria-checked` alike.

Rules that keep it consistent:

- No hex or `rgb()` colors outside `tokens.css` (except data colors that come from the plan,
  such as a crew's own color).
- No colored side stripes (`border-left` thicker than 1px) on cards, rows or notes: use a tinted
  background, a full border or a leading icon.
- No gradient text, no glows; shadows only for elevation.
- Paying is ours to draw, in PayPal's words: Review payment opens the payout sheet (`payments/PayoutSheet.tsx`,
  PayPal Payouts' "Review your payment details", then Send payout). "PayPal" is plain text; PayPal's mark appears
  only beside "Paid", unaltered, and never inside a button; nothing imitates PayPal's gold checkout button.
- Money and approval screens read like a payments product in the trade's terms: trade partner (supplier for a
  rental), scope, % complete, scheduled value, retainage, due this period, funding source, approver ("Approver:
  Chris Hale, Project Manager"). Labels and statuses, not sentences ("Pending", then "Approved by Chris Hale · 10:42
  AM"); counts come from the data with the plural that fits ("2 of 2 payments completed"). Remy's speech stays
  conversational.
- Bryntum widgets are themed through their CSS variables (see `gantt.css`), not replaced.
