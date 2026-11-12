# ADR-0024 · Interactive Camelot town: buildings as navigation

**Status:** pilot on an isolated feature branch; not merged or field-tested.
**Owner approval:** 2026-11-12 — Heroes-style panoramic department city with clickable functional buildings. Start with Camelot.

## Scope

- Entering a Camelot department at #/castles/:id opens its panoramic town by default.
- The additional tab «Город» retains the panorama; other civilizations keep their existing district layout.
- Original generated MODUS FLOW art is versioned as web/public/towns/camelot.webp (1448 × 1086, ~365 kB). Vite copies it to web/dist and the production static handler serves image/webp.
- Accessible HTML links overlay the illustration. Native links support keyboard focus and Ctrl/Cmd-click. A 330 ms camera push accompanies ordinary clicks, but reduced motion skips it.
- On a narrow screen, the panorama scrolls horizontally and an independent list of eight large links remains available.
- Level and XP come from the real district payload. Functional buildings are never gated by the cosmetic level.
- A self-contained original SVG fallback keeps navigation working if the optional image request fails.

## Clickable buildings

| Building | Coordinates (percent) | Real route |
|---|---|---|
| Великая библиотека | 19, 29 | department Legacy tab |
| Зал Совета | 51, 31 | department Council tab |
| Высший Архив | 85, 29 | Great Library filtered to Archive |
| Зал воинов | 30, 52 | personal notes and council discussions, dependent on PR #15 |
| Гильдия | 78, 49 | Staff tab |
| Мастерские | 87, 62 | Tasks / Kanban tab |
| Площадь инициатив | 50, 62 | Initiatives tab |
| Цитадель | 51, 15 | Growth / XP tab |

This is an interactive 2.5D illustration, not a 3D-engine interior. All business actions use existing endpoints with unchanged server permissions, audit, authorship and workflow rules.

## Acceptance

1. Build web with TypeScript/Vite: npm run web:build.
2. On a freshly seeded demo DB run npm run demo:city: the script now changes warehouse style to Camelot, tests the panorama, eight building links and routes to Warrior Hall and Council.
3. Check image/webp MIME, image load, missing-image fallback, keyboard, mobile scroll, reduced-motion, light-mode and real low-powered hardware.
4. Verify XP and access-control behaviors are unchanged by the cosmetic switch.

## Future work

Roman civilization replacing Mongolia needs a separately reviewed registry + database migration. Japanese, Kazakh and Roman town scenes, separate arts for levels 1–5 and interior panoramas are follow-ups, not claimed as finished.
