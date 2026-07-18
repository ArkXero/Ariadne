# Design system

Ariadne uses a compact shared palette across interactive setup, the terminal UI, and generated HTML reports. The source of truth is `src/theme.ts`; presentation code should consume its semantic roles rather than introduce color literals. The TUI adds restrained status and focus accents to the original report palette so dense dashboards remain scannable.

## Palette

| Token | Value | Role |
| --- | --- | --- |
| Coral | `#F6453C` | Brand identity, TUI frames, and errors or failures |
| Warning Orange | `#F59E0B` | Warnings, caution states, and nonzero warning counts |
| Success Green | `#4ADE80` | Passed checks and healthy states in the TUI |
| Info Cyan | `#22D3EE` | Running states, selected rows, and key hints |
| Snow | `#FCF7F8` | Primary terminal text, report surfaces, and text on Coral |
| Pale Slate | `#CED3DC` | Inactive or secondary text and the report canvas |
| Deep Slate | `#64748B` | Reserved low-emphasis structure |

The palette is deliberately small. Status meaning must always remain visible in words such as `Passed`, `Failed`, and `Warning`; color is reinforcement, never the only signal.

## Terminal surfaces

Interactive Init keeps Clack's established layout and input behavior. A scoped output adapter maps its semantic ANSI colors to Coral, Warning Orange, Snow, and Pale Slate, then restores the original output writer after the session. `--no-color` and `NO_COLOR` bypass the adapter.

The Ink TUI uses Coral for every pane frame, brand identity, and failures; Cyan for selected rows, running states, and command keys; Green for passed states; Orange for warnings or waiting; Snow for primary values; and Pale Slate for metadata. Counts inherit the role of the field they describe. Unicode and ASCII layouts share the same meanings, and every color-coded state also carries a word and a symbol.

The top bar and footer are each one terminal row. Unicode panes use rounded corners and adjacent panes use zero-cell gutters; ASCII fallbacks remain square. Footer commands use two spaces between complete `key label` groups; lower-priority groups disappear when they do not fit instead of being clipped mid-command.

## Generated reports

Run and workflow HTML reports embed shared CSS custom properties from `src/theme.ts`:

- Pale Slate canvas
- Snow cards and sections
- Coral typography, outlines, and errors
- Warning Orange warning callouts
- Deep Coral code surfaces with Snow code text

Do not add standalone hex values to report renderers. Extend the shared semantic tokens when a genuinely new role is required.

## Voice and structure

- Use sentence case and plain language.
- Keep the line frames, whitespace, and keyboard hints that communicate structure.
- Avoid decorative system prefixes, pseudo-military terminology, and color-only status.
- Preserve readable output under `--no-color`, `NO_COLOR`, redirected output, and ASCII fallback.
