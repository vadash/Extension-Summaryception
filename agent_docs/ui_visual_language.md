# Summaryception UI Visual Language

Use this document when building or restyling a SillyTavern plugin so it belongs to the same product family as Summaryception. Copy the design grammar, interaction patterns, and density—not the plugin name, exact section order, or every color/value literally. Sibling plugins should feel related while retaining their own identity.

The current implementation reference is `settings.html`, `style.css`, and `src/entry/ui-tabs.js`.

## Experience Goals

- **Operational at a glance:** The first view answers whether the plugin is enabled, what it is doing, and whether attention is needed.
- **Compact, not cramped:** Most primary tabs should fit within roughly one settings-panel viewport at common desktop sizes. Prefer summaries, grids, progressive disclosure, and short helper text over long vertical forms.
- **Calm technical console:** Present complex state as understandable cards, rails, meters, and terse labels rather than raw diagnostics.
- **Theme-native with a recognizable mark:** Inherit SillyTavern theme colors, then add a restrained plugin accent, icon language, surface hierarchy, and product-specific visualization colors.
- **Useful while scrolling:** Navigation remains available after the page header and mode controls scroll away.

## Required Information Architecture

Use this top-to-bottom order:

1. SillyTavern inline drawer header with plugin icon, name, and collapse control.
2. A compact global mode/enable control when the plugin has meaningful operating modes.
3. A one-line live status strip.
4. A sticky primary tab strip.
5. One active tab panel containing compact sections/cards.

Recommended primary tabs are conceptually:

- **Status:** current state, resource/context use, and common operations.
- **Data/Memory:** inspection and editing of the plugin's main stored artifact.
- **Settings:** normal configuration and advanced tuning.
- **Prompts/Templates:** editable text assets, only when relevant.
- **Tools:** diagnostics, maintenance, import/export, and destructive actions.

Rename or omit tabs to fit the plugin, but keep the progression from everyday use to specialist maintenance. Aim for three to five primary tabs. Do not put every control on one continuous page.

## Startup and Navigation Behavior

- **Status opens by default after every F5, extension initialization, or newly opened SillyTavern session.** Do not restore a previously selected settings tab on startup.
- Clicking a tab changes only the active panel; inactive panels are hidden.
- The active tab has a subtle filled surface and border, not a loud solid-color treatment.
- The tab strip uses `position: sticky; top: 0;` with a solid/mostly opaque theme-derived background and a z-index above tab content.
- As the user scrolls, the drawer title, mode selector, and status strip may leave the viewport. The primary tab strip then docks at the top and remains visible, as in the Settings screenshot.
- Sticky navigation must not be transparent enough for scrolling labels to become visually tangled behind it.
- Preserve accessible tab semantics: `role="tablist"`, `role="tab"`, `role="tabpanel"`, `aria-selected`, and a visible keyboard focus outline.

Summaryception's reference startup behavior is `activateSettingsTab('status')` in `src/entry/ui-tabs.js`; session storage may record clicks for incidental use, but it must not override the startup default.

## Viewport and Density Rules

- Design each everyday tab to fit in approximately one visible settings-panel screen whenever its content reasonably allows it.
- The **Status** tab should normally show its overview, primary visualization, and operation buttons together or with only a small scroll.
- Large specialist tabs may exceed one screen, but organize them into clear compact sections and collapsible expert groups.
- Use two-column responsive grids for related settings on ordinary widths. Collapse to one column on narrow/mobile widths.
- Avoid oversized headings, large empty padding, decorative hero areas, and full-width prose blocks.
- Keep the vertical rhythm tight: approximately 5–8 px between or inside primary surfaces in the current implementation.
- Put explanations directly under labels in smaller muted text. Prefer one short sentence; move detailed education into help tooltips.
- Use compact value chips beside sliders so the current value remains immediately scannable.

## Surface Hierarchy

The family look is created through several shallow layers rather than heavy shadows:

- **Plugin background:** supplied by the SillyTavern drawer.
- **Section/card:** faint translucent surface, 1 px theme border, about 8 px radius.
- **Nested item or selected state:** slightly stronger translucent surface.
- **Input field:** SillyTavern theme field/tint color.
- **Sticky navigation:** field color mixed toward black so content does not show through.

Reference tokens from `style.css`:

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

For another plugin, keep the same theme-derived structure but choose a restrained identity accent or icon motif. The accent should decorate icons, focus, active borders, and small data marks; it should not flood entire panels.

## Typography and Icon Language

- Inherit SillyTavern's body font and body color.
- Use compact type, around `0.9em` at the plugin root.
- Section titles are small, bold, and paired with a Font Awesome icon in the accent color.
- Labels carry meaning; icons reinforce it. Do not use unexplained icons as the only label except for familiar compact actions with a tooltip/ARIA label.
- Secondary descriptions use smaller text, reduced opacity, and a tight line height.
- Numeric/status values use stronger contrast and weight than their labels.
- Keep naming plain and operational: `Status`, `Memory`, `Settings`, `Prompts`, `Tools`, `Operations`.

## Signature Components

### Mode cards

For mutually exclusive operating modes, use a row of selectable cards with:

- a colored semantic icon on the left;
- a bold short title and one-sentence description;
- the native radio control on the right;
- a subtle accent border and stronger surface for the selected card.

Three modes can sit in one row on normal widths and collapse on narrow screens. Summaryception uses `Off`, `Easy`, and `Advanced`; other plugins should use modes meaningful to their own workflow.

### Live status strip

Place a terse, single-line console-like summary above the tabs. Separate facts with muted centered dots. Example structure:

`Advanced · Idle · 24 snippets · 367 ghosted`

Use current values, avoid sentences, allow wrapping when necessary, and keep the strip visually quieter than the content cards.

### Overview metrics

Show the few most important values as a two- or three-column grid of small nested cards. Each metric has a muted label and a stronger value. Do not turn the status page into a dashboard of marginal statistics.

### Process/payload rail

Use linked compact blocks and arrows to explain an ordered pipeline, allocation, or context composition. Each block can contain an icon, name, and concise value. Allow wrapping; a wrapped item should become a coherent full-width row rather than an orphaned label.

### Capacity bars and legends

- Use horizontal segmented bars for budgets/capacity.
- Put the total at the right of the subsection title, such as `31k / 32k`.
- Label the largest/most important segment inside the bar when space permits.
- Repeat colors in a compact legend below the bar.
- Reserve gray for free/unused space and stable semantic colors for data categories.
- Never rely on color alone; include text labels and values.

### Operations

Keep the most common actions at the bottom of Status in a single responsive button row. Buttons use an icon plus short verb phrase. Destructive or interrupting actions receive the danger treatment; ordinary actions remain theme-native.

### Settings groups

- Group related controls in bordered sections, then use responsive two-column grids inside them.
- Put rarely changed or risky controls in a collapsed `Expert Tuning`/advanced disclosure.
- Pair sliders with compact editable value chips.
- Use inline help icons/tooltips for definitions that would otherwise make the page tall.
- Put related select controls side by side when there is enough width.

## Responsive Behavior

- At narrow widths (the current reference breakpoint is about 520 px), collapse multi-column settings, mode cards, and tuning grids to one column.
- Tabs may stack icon above label to preserve touch targets and avoid clipped names.
- Buttons may wrap or share width evenly.
- Preserve at least a roughly 30 px tab target on narrow screens.
- Never introduce horizontal page scrolling. Rails, legends, and long values must wrap or truncate safely.
- Test sticky tabs inside the actual SillyTavern drawer; the scroll container matters more than standalone browser behavior.

## Family Resemblance vs. Plugin Identity

Keep these consistent across the plugin family:

- compact bordered surfaces and radii;
- sticky tab navigation;
- Status-first startup;
- accent-colored section/tab icons;
- muted helper text and strong values;
- grids, mode cards, status strips, meters, and bottom operation rows;
- SillyTavern theme-variable inheritance;
- responsive collapse rules and accessible states.

Vary these per plugin:

- plugin icon and name;
- accent hue or a small secondary visualization palette;
- tab names and section order;
- domain-specific visualization (timeline, queue, budget, routing map, etc.);
- wording and operating modes.

The result should look like a sibling product, not a reskin or clone of Summaryception.

## Anti-Patterns

- Restoring the last active tab after reload instead of opening Status.
- Letting the tab bar scroll out of view on long panels.
- Making the sticky bar translucent enough that underlying content reduces readability.
- One enormous Settings page with no tabs, sections, or expert disclosure.
- Excessive vertical padding that pushes routine controls across several screens.
- Hard-coded light/dark colors that ignore SillyTavern theme variables.
- Using the accent as a large background fill everywhere.
- Long permanent help paragraphs beside every control.
- Icon-only navigation without text labels.
- Hiding essential status or routine actions in a diagnostics tab.
- Copying Summaryception-specific labels or blue accent when they do not fit the sibling plugin's identity.

## Implementation Checklist

- [ ] Inline drawer header uses a distinct plugin icon and clear name.
- [ ] Status is activated explicitly during each UI initialization.
- [ ] Live operational summary appears above the tabs.
- [ ] Primary tab list is sticky at the top of the drawer scroll viewport.
- [ ] Sticky background remains readable over scrolling content.
- [ ] Three to five tabs separate routine, configuration, editing, and specialist tasks.
- [ ] Status contains the key state, one primary visualization, and routine operations.
- [ ] Most routine tabs target one-screen density.
- [ ] Expert controls use progressive disclosure.
- [ ] Colors derive from SillyTavern theme variables, with restrained plugin identity accents.
- [ ] Active, hover, keyboard focus, disabled, warning, and danger states are distinct.
- [ ] Layout collapses cleanly around 520 px without horizontal scrolling.
- [ ] Controls retain labels, help text/tooltips, ARIA state, and adequate touch targets.
- [ ] Visual identity differs from Summaryception while the interaction grammar remains recognizable.
