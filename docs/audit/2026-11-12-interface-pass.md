# Interface pass against `jakubkrehel/skills`

Date: 2026-11-12. Owner request: improve UX/UI, choosing the better of two public skill sets —
`jakubkrehel/skills` and `nextlevelbuilder/ui-ux-pro-max-skill`.

## Which set and why

**`jakubkrehel/skills`** was used as the method. `ui-ux-pro-max` was already applied on 2026-11-10
([`2026-11-10-ui-ux-pass.md`](2026-11-10-ui-ux-pass.md)); what it adds beyond that pass is a catalogue of
styles, palettes and font pairings — a restyle, which is the wrong move three days before the demo.

`jakubkrehel/skills` is a review method, not a style: six domain skills (`better-accessibility`,
`better-layout`, `better-writing`, `better-typography`, `better-colors`, `better-ui`) with exact values,
detection tables and a rule that every finding needs evidence and every fix is written in the project's
own tokens. It found things the first pass could not, because it measures the rendered result.

From `ui-ux-pro-max` nothing new was taken; its «Not done» list from 2026-11-10 is still open (below).

## Scope and evidence

All routes of the web app as three people (operations director, system administrator, storekeeper):
17 routes × desktop 1280 light, desktop 1280 dark, phone 390; plus 320 px width. The 3D city was
covered only by the stylesheet rules (hover, overscroll, focus), not re-inspected screen by screen.

- Detection tables of the six skills run over `web/src/styles.css` and `web/src/**/*.tsx`.
- `axe-core` (WCAG 2.0–2.2 A/AA + best practice) on every route in the three setups.
- A measuring script: size of every interactive element, horizontal overflow, ellipsis without a title.
- Screenshots before and after; keyboard focus captured in light, dark and forced-colours mode.

## Findings, fixed

| Sev. | Location | Before | After | Why |
|---|---|---|---|---|
| HIGH | `styles.css` `--focus`, `:focus-visible`, `.input:focus` | Focus ring `0 0 0 3px rgba(14,116,105,.35)`: 1.7:1 against the page (measured: `#a5c9c5` on `#f6f7f6`); `outline: none`, so nothing at all in forced-colours mode | Solid ring with a gap (`2px` surface + `2px` accent: 5.6:1 on white, 5.3:1 on the page, 7.8:1 in the dark theme), `outline: 2px solid transparent` under it | Visible focus must reach 3:1 and survive forced colours (WCAG 1.4.11, 2.4.7) |
| HIGH | `styles.css` `.unread-mark` | «новое» in `#8a1c1c` on the dark surface: 1.75:1 (axe, Inbox, dark) | `var(--red)` — the theme's own token (7.2:1 in the dark theme) | Text contrast; a hard-coded colour ignored the dark theme |
| HIGH | `Protocol.tsx:22,25`, `Meetings.tsx:99,102`, `Council.tsx:639,858`, `Meetings.tsx:1010` | `aria-pressed` on links and on `role="radio"` buttons (axe: critical, 16 nodes) | Links keep `aria-current`, radios keep `aria-checked`; styles follow those attributes | Invalid ARIA is announced wrongly or not at all |
| HIGH | `Kingdom.tsx` schematic map | `<svg role="img">` around focusable castles and envoys | `role="group"` | An image hides its focusable children from assistive technology |
| MED | `styles.css`, 48 rules | Every `:hover` style applied on touch too, where it latches after a tap and reads as «selected» | Each hover selector wrapped in `@media (hover: hover)`; focus and selected states untouched | Hover only where a pointer can hover |
| MED | `styles.css` `.segmented` | Focus ring of a segment clipped by the control's `overflow: hidden` | Ring drawn inside the segment | The ring existed but could not be seen |
| MED | `.back`, `.back-link`, `.howto-body a`, `.card-title`, `.attention li > a`, `.card .card-move`, `.segmented a`, `.select.compact` | 19–22 px tall targets (desktop below 24, phone below 44) | 24 px with a pointer, 44 px with a finger; text size unchanged | WCAG 2.5.8 and the project's own 44 px rule |
| MED | `.check input` | A long label squeezed the checkbox to 13 px wide on phones | `flex: none` | The box was visibly deformed |
| MED | `Mine.tsx` page head | Three filled «Подать обращение» on one screen (navigation, page head, empty state) | The page-head copy is a neutral button | One filled action per view |
| MED | `Board.tsx` | `role="list"` / `role="listitem"` on `<section>` columns (axe) | Sections stay labelled regions, list roles removed | Role not allowed on the element |
| MED | `Item.tsx` | Headings jump from `h1` to `h3` | `h2`, same look | Heading order is how screen-reader users navigate |
| LOW | `App.tsx` no-access and unknown page | No `h1` | «Раздел недоступен» / «Страница не найдена» | Every page has a name |
| LOW | `Settings.tsx` | Empty table header over the actions column | Hidden text «Действия» | Header cells need a name |
| LOW | dialogs, sheets, search results, 3D panels | Scrolling past the end scrolled the page behind | `overscroll-behavior: contain` | Contain scroll inside overlays |
| LOW | `.btn` | Pressed state was colour only | `scale: 0.96` over 150 ms, never when disabled, off with reduced motion and «облегчённая графика» | Press feedback, exact value from `better-ui` |
| LOW | root | Default font rendering | `-webkit-font-smoothing: antialiased` on `html` | Once on the root; makes text slightly lighter on macOS |
| LOW | `p, li, dd` | Lone last words | `text-wrap: pretty` | Progressive enhancement, ignored where unsupported |
| LOW | `.login` | `min-height: 100vh` | `100dvh` added | Mobile toolbar no longer covers the bottom |

## Verification (local only)

- `axe-core`: **7 rule types, 43 nodes before → 0 after**, on the same 54 route checks.
- Targets below the threshold: 8 kinds of control before → none after (native checkboxes remain small; their
  label is the target). Horizontal overflow at 320 px: none before or after.
- Forced colours: a focused button reports `outline: solid 2px` (was `none`).
- `npm run verify`: passed (8 prototype tests, 279 platform tests on PostgreSQL 16, web build with the
  contrast check).
- End-to-end flows, each on a fresh seed: `demo:e2e`, `demo:city`, `demo:councils`, `demo:meeting`,
  `demo:final`, `demo:messages`, `demo:legacy`, `demo:advisor`, `demo:world3d` — passed.
- `demo:kingdom` is **flaky and was before this change**: «XP 150 → 150, expected +100» in 2 of 5 runs on
  `main` without these edits and in 2 of 6 runs on `ab69746`; with the edits 3 of 4 runs passed. The
  step reads the castle's XP right after the implementation is confirmed. Not investigated here.
- GitHub CI did not run (the account's billing blocks the job).
- Where it ran: Linux, Chromium headless. **Not run:** Safari/iOS, a real phone, a screen reader.

## Not fixed (honest list)

- **Disabled submit buttons.** 14 buttons are disabled until their form is valid
  (`Item.tsx:362,385,452,491,508,573`, `Library.tsx:1034,1068`, `Board.tsx:373`, `Settings.tsx:240,353`,
  `Council.tsx:766`, `District.tsx:551`, `WarriorHall.tsx:176`). The rule is to keep the button enabled
  and say what is missing on submit, as `NewItem` already does. It changes validation flows of ten
  dialogs, so it was left for after the demo.
- `body { font-variant-numeric: tabular-nums }` makes digits in running text tabular too. Deliberate
  and harmless; left.
- 177 hex colours inside `.tsx` are illustration artwork (castles, scenes, seals), not interface colours;
  not tokenised.
- Colours of the 3D HUD (`--w-*`) and of the «Королевская аудиенция» card are outside the contrast
  script's 38 token pairs. axe found no failures on the screens it could reach; the 3D canvas itself
  cannot be checked this way.
- Still open from 2026-11-10: no screen-reader session, largest system text size, landscape.
