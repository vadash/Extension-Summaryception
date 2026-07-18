# Summaryception UI visual language

Use for Summaryception restyling or sibling SillyTavern plugins. Copy interaction grammar and density, not product name, exact layout, or every color. References: `settings.html`, `style.css`, `src/entry/ui-tabs.js`.

## Goals

- First view shows enabled mode, current activity, attention needs.
- Compact, not cramped: routine tabs near one settings-panel viewport.
- Calm technical console: cards, rails, meters, terse labels; no raw diagnostic wall.
- Inherit SillyTavern theme; add restrained product accent and domain visualization.
- Navigation stays usable while content scrolls.

## Information architecture

Order:

1. SillyTavern drawer header with icon, name, collapse control.
2. Compact global mode/enable control when meaningful.
3. One-line live status strip.
4. Sticky primary tab strip.
5. Active tab panel with compact sections/cards.

Use three to five tabs progressing from routine to specialist: Status, stored Data/Memory, Settings, Prompts/Templates when relevant, Tools/Diagnostics. Rename or omit by domain. Never place every control on one long page.

## Navigation

- Status opens after every reload, initialization, or new SillyTavern session. Never restore previous tab at startup.
- Tab click changes active panel only; hide inactive panels.
- Active tab uses subtle filled surface/border, not loud solid fill.
- Tab strip uses `position: sticky; top: 0`, solid/mostly opaque theme-derived background, z-index above content.
- Header, modes, and status may scroll away; tabs stay docked. Scrolling labels must not show through sticky background.
- Preserve `tablist`, `tab`, `tabpanel`, `aria-selected`, visible keyboard focus, and useful text labels.

## Density and hierarchy

- Status normally shows overview, primary visualization, and operations together or with little scroll.
- Large specialist tabs use compact sections and collapsible expert groups.
- Use responsive two-column grids; one column on narrow screens.
- Avoid large headings, hero space, wide prose, excess padding. Target roughly 5-8 px primary spacing.
- Put one short muted explanation under label; move long education into help tooltip.
- Put compact editable value chip beside slider.
- Surfaces stay shallow: drawer background, faint bordered card, stronger nested/selected surface, theme field, opaque sticky navigation. Avoid heavy shadows.

Reference structure:

```css
--plugin-border: var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.16));
--plugin-surface: rgba(255, 255, 255, 0.045);
--plugin-surface-strong: rgba(255, 255, 255, 0.075);
--plugin-field: var(--SmartThemeBlurTintColor, rgba(18, 18, 24, 0.86));
--plugin-accent: var(--SmartThemeQuoteColor, #66b2ff);
--plugin-danger: #ff6b6b;
--plugin-warning: #f0b84a;
--plugin-radius: 8px;
```

Sibling plugin may change accent/icon motif. Accent decorates icons, focus, active borders, small data marks; never flood panels.

## Type and components

- Inherit body font/color; plugin root near `0.9em`.
- Small bold section titles pair with accent Font Awesome icon.
- Labels carry meaning; icons reinforce. Familiar icon-only actions still need tooltip/ARIA label.
- Secondary text stays smaller, muted, tight; numeric/status values use stronger contrast.
- Prefer plain operational names: Status, Memory, Settings, Prompts, Tools, Operations.

Signature patterns:

- Mode cards: semantic icon, short title/description, native radio, selected accent border/surface; row on desktop, stack narrow.
- Status strip: terse live facts separated by muted dots, quiet styling, wrapping allowed.
- Metrics: two/three-column small cards; show only important values.
- Process rail: linked blocks for pipeline/allocation; wrap as coherent rows.
- Capacity bar: total beside title, major label inside when space allows, compact text/value legend, gray unused space. Never rely on color alone.
- Operations: common actions at Status bottom in responsive row; danger only for destructive/interrupting actions.
- Settings: bordered groups, responsive grids, collapsed expert tuning, slider/value pairs, inline help, adjacent related selects.

## Responsive and identity

- Around 520 px, collapse grids and mode cards; tabs may stack icon over label.
- Buttons may wrap/share width. Keep roughly 30 px tab targets.
- Never add horizontal page scroll. Rails, legends, long values wrap or truncate safely.
- Test sticky tabs inside actual SillyTavern drawer scroll container.
- Family constants: compact bordered surfaces, sticky Status-first tabs, accent icons, muted help/strong values, grids/cards/meters, bottom operations, theme variables, accessible responsive states.
- Plugin identity may vary icon/name, restrained accent/palette, tab naming/order, domain visualization, wording, modes. Sibling, not clone.

## Reject

- Restored last tab on reload; scrolling-away tabs; transparent sticky bar.
- One huge settings page; oversized padding; permanent help paragraphs.
- Hard-coded page theme; accent-filled panels; unexplained icon-only navigation.
- Hidden essential status/actions inside diagnostics.
- Horizontal scrolling, clipped names, missing focus/disabled/warning/danger states.
- Copying Summaryception-specific labels or blue accent without domain reason.
