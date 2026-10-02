# SanoVids design language (Apple-inspired)

User request (2026-10-02): "tối ưu lại giao diện người dùng tham khảo phong cách thiết kế của Apple, thêm chuyển chế độ sáng tối".
Reference: Apple Human Interface Guidelines (macOS/iPadOS apps such as Final Cut Pro, Keynote, Freeform, Photos).
Goal: calm, content-first, precise. The user's images and videos are the stars; chrome recedes.

## Appearance
- Two themes: **Tối** (default) and **Sáng**, plus **Theo hệ thống**. `src/lib/theme.ts` sets `<html data-theme>`; all colors come from tokens in `src/styles/base.css`. **No hard-coded colors in component CSS** (use `var(--…)`, `color-mix(in srgb, var(--x) N%, transparent)` for tints). Check every component in both themes.
- React Flow: pass `colorMode` from the theme; canvas background `var(--canvas-bg)` with dots `var(--canvas-dot)`.

## Tokens (see base.css)
- Surfaces: `--bg` window, `--panel` sidebars/cards, `--panel-2` raised controls, `--panel-3` hover/pressed, `--bg-elev` fields; `--hover`/`--pressed` overlays for rows and icon buttons.
- Materials (vibrancy): `.material` (translucent + `backdrop-filter: var(--blur)`) for floating things: top bar, canvas toolbar, popovers, menus, toasts, hover previews, the queue drawer bar.
- Lines: hairlines `--border` (1px); `--border-strong` only for inputs/controls.
- Text: `--text` (primary), `--text-dim` (secondary), `--text-faint` (tertiary/placeholder).
- Tint: `--accent` (system orange) for the ONE primary action per area (Run, Download, Create). Semantics: `--ref` teal (images), `--video` purple (videos), `--save` indigo (folder nodes and the wires that save videos into them), `--ok`, `--warn`, `--danger`, `--info`, each with a `-soft` fill. Text on accent fills uses `--on-accent`.
- Radii: `--radius-xs 6` (chips, small thumbs), `--radius-sm 8` (buttons, inputs), `--radius 12` (cards, menus), `--radius-lg 16` (dialogs, large cards), `--radius-xl 20`.
- Depth: `--shadow-sm` (cards at rest), `--shadow` (hover, popovers), `--shadow-lg` (dialogs). Prefer hairline + soft shadow over heavy borders.
- Focus: `box-shadow: var(--focus-ring)` on `:focus-visible` for every interactive element.

## Typography
- System font stack `--font` (SF Pro on Apple, Segoe UI Variable on Windows, Be Vietnam Pro fallback; Vietnamese diacritics must render well). Display headings `--font-display`. Numbers/tokens `--mono`.
- Scale: 11 (caption/labels), 12 (secondary), 13 (body — default), 15 (section titles), 17 (dialog titles), 22+ (empty-state headlines). Weights 400/500/600 (avoid 700+ except big numbers). Section labels: 11px, 600, letter-spacing .02em, sentence case (not ALL CAPS shouting) — Apple uses small caps sparingly.
- Line height 1.45 body, 1.25 headings. Truncate with ellipsis, never overflow.

## Layout & spacing
- 4/8 pt grid: paddings 8/12/16/20/24. Sidebar sections 16px side padding; list rows 6–8px vertical.
- Hit targets ≥ 28px (desktop), icon buttons 28–32px, primary buttons 32–36px, the big "Tải video" 36px.
- Generous whitespace; group with spacing and subtle background, not boxes inside boxes.

## Components
- **Buttons**: primary = filled tint, `--on-accent` text, radius 8; secondary = `--panel-2` fill, no border (light theme: subtle hairline); tertiary/plain = text-only tint; destructive = `--danger` text, `--danger-soft` on hover. Pressed state scales 0.98. Disabled 40% opacity.
- **Segmented control** (view switch, edge mode, take display, theme): pill track `--panel-2`, selected segment raised (`--panel` light / `--panel-3` dark) with `--shadow-sm`, 6px inner radius, smooth 150 ms slide.
- **Inputs/selects/textareas**: `--bg-elev` fill, hairline border, radius 8, focus ring. Placeholder `--text-faint`.
- **Lists/rows** (library, takes, queue, projects): rounded hover background (`--hover`), selected = `--accent-soft` fill + tint text/indicator; no zebra.
- **Cards on the canvas**: radius 14, `--panel` fill, hairline border, `--shadow-sm`; hover lifts to `--shadow`; selected = 2px `--accent` ring (+ soft glow). Headers with quiet secondary text; one tinted primary action (Run / Tải video).
- **Popovers, menus, hover previews, toasts**: `.material`, radius 12, `--shadow-lg`, 1px hairline, 8px padding, items 28px tall with rounded hover.
- **Toasts** stack at the top center, just below the top bar (`--topbar-h` + 10px), newest closest to it, sliding down as they appear — never over the canvas toolbar or the queue drawer at the bottom.
- **Dialogs (sheets)**: radius 16, `--panel`, `--shadow-lg`, title 17/600 left aligned, footer buttons right aligned (Cancel secondary, primary tinted), backdrop `--scrim` with slight blur.
- **Top bar**: unified toolbar, `.material`, hairline bottom border, centered segmented view switch, quiet icon buttons; app mark + project name on the left.
- **Sidebar & inspector**: `--panel` with hairline separators; section headers collapsible with chevrons; inspector fields in grouped "inset" style (label above control, 12px gaps).
- **Icons**: lucide at 16px (toolbar 16–18px), stroke 1.75, `--text-dim` until hover/active.
- **Motion**: 120–200 ms ease-out for hovers/presses, 200–250 ms for panels/sheets; respect `prefers-reduced-motion`.
- **Empty states**: centered SF-style glyph, 15px title, 13px secondary text, one primary action.

## Do / Don't
- Do keep one accent per view; let images/videos carry color.
- Do keep wires thin (1.5px) and calm; highlight on hover/selection only.
- Wire motion (`components/canvas/wires.css`): a click on a wire cuts it (scissors cursor) — the wire splits at the click and both halves retract to their cards with a fading ring (~280 ms ease-out); a new wire draws itself from its source (~340 ms); a dragged wire marches dashes in its source color, turns solid with a ring when it snaps to a card that accepts it, grey when it cannot land. 'Giảm bớt' = fades only, 'Tắt' = none; OS reduce-motion = 'Giảm bớt'.
- Storyboard reorder (`components/views/views.css`): the dragged card lifts (scale 1.03, `--shadow-lg`, accent ring) and follows the pointer; the others glide aside (~220 ms) around a dashed accent slot, with a `→ S05` pill for the code it will get; on drop it settles with a slight overshoot (~300 ms) and a fading accent ring. 'Giảm bớt': cards stay put, an accent insertion bar marks the place, no slides; 'Tắt': no transitions at all.
- Settings sheet (`components/dialogs/SettingsDialog.tsx`): a sticky toolbar with the "Cơ bản / Nâng cao" segmented control and a search field (Ctrl+F); grouped inset sections in two columns (one under 760 px); while searching, matches from "Cơ bản" on the left and "Nâng cao" on the right. The sheet keeps one height while it is open (it never shrinks or re-centres under the caret as results change). Every row = label + one-line hint + a native control (switch, segmented, slider, field); changes apply at once, no Save button. Destructive rows ("Khôi phục cài đặt mặc định") confirm inline with Huỷ focused and offer Hoàn tác in a toast. "Hiệu ứng chuyển động" is app-wide: `<html data-motion>` 'reduced' keeps fades/colors only (sheets and toasts fade instead of sliding), 'off' removes every transition and animation.
- Don't use pure black/white text on colored fills except `--on-accent`; don't stack borders; don't use ALL CAPS paragraphs.
