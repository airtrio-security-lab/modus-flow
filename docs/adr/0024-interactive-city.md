# ADR-0024 · Interactive panoramic department city (Camelot pilot)

Status: feature branch prototype, pending integration tests and product review.

A department is entered via an original cinematic panorama with clickable buildings, following the navigation mechanics of classic strategy game town screens without copying any game assets.

## Camelot first
- Original panorama: web/public/media/camelot-city.webp (WebP, 1448 x 1086, embedded in the app distribution, not loaded from third-party URLs).
- Reusable hotspot schema with eight named buildings; coordinate percentages match the scene. CSS overlay anchors are keyboard accessible and each has a named text alternative.
- Buildings open existing routes: staff, tasks, initiatives, Council, legacy, Warriors, growth and the Great Archive library filter. There is no duplicate process or backend permission change.
- Every entry into a Camelot department opens a town tab by default; other styles retain the existing department view until their panoramas are created.
- Navigation list remains usable on small screens and when the panoramic image cannot load. Mobile can pan horizontally. Prefers-reduced-motion disables transitions.
- The panorama is an illustration. XP and business states come from existing server facts. Level information is overlaid from the department record; the scene does not invent buildings to represent undocumented achievements.

## Remaining work
- Capture a visual regression at 390px/desktop and keyboard navigation in Playwright.
- Validate each hotspot against scene geometry and verify no overlaid label occludes critical buildings.
- Produce three original panoramas for Japan, the Kazakh Khanate and Rome; replacing the Mongolian registry entry requires separate additive migration and historical audit compatibility.
- Consider level-specific visual layers, but never let buildings block baseline work features.
