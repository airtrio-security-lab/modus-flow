# Kingdom, Council and rating: UX check

Date: 2026-11-11. Rules: the local «UI UX Pro Max» files read earlier (no downloaded code was run),
the owner brief of 2026-11-11 and the existing «Quiet Intelligence» tokens.

## Checked

| Rule | How it is met |
|---|---|
| No small text over a busy background | Every map label sits on a solid plate (dark text on #fffdf8, or light text on the dark «Совет» plate); envoy numbers too |
| Contrast ≥ 4.5:1 | Token pairs checked by `npm --prefix web run contrast` (38 pairs, light and dark); fixed map colours use dark ink on light plates; the item-to-kingdom note keeps fixed colours in dark theme |
| Obvious actions, none hidden in animation | All Council actions are buttons in the right panel; the circle only selects a participant |
| Many participants | > 10 seats or a narrow screen → compact list with the same roles and stances |
| No duplicated statuses | One status chip per item; the map says where the envoy is in words («на рассмотрении в Совете», «срок первого ответа прошёл») |
| Business words stay | «Обращение №…», «Решает», «Ведёт», «Принять решение»; game words only as section names |
| No endless animation | Envoys bob 4 times, flags wave 3 times, the construction runs once per level-up; none with reduced motion or «Облегчённая графика» |
| Slow computers | «Облегчённая графика» on by default with reduced motion, ≤ 4 CPU threads or ≤ 4 GB memory: no textures, vignette, shadows or animation, fewer trees |
| Touch targets | Sub-tabs, seat list rows, bell and tab bar ≥ 44 px |
| Keyboard and screen readers | Castles and seats are focusable buttons with full names (level, XP, role, stance); the XP bar is a `progressbar` with a text value; level-ups are announced in a live region |
| 30-second test | «Как это работает» on «Мои обращения» and «Королевство»: where to submit, where the status is, where the discussion is, who decides, what grows the castle |

Verified with Playwright screenshots at 1440 px and 390 px, light and dark, and with
`npm run demo:kingdom` and `npm run demo:e2e` on fresh demo data.

## Not done (honest list)

* No session with a real screen reader; no test with the largest system text size.
* Not tested on a real phone or a genuinely slow computer; the lite mode was checked by forcing it.
* The isometric castles are SVG drawn in code, not painted artwork.
* The AI advisor is not implemented (no AI service connected or approved).
