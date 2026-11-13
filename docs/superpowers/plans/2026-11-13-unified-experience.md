# Unified Modus Flow experience

Goal: connect the immersive city and working pages through one visual language and one stable navigation.

Design: forest green surfaces, antique gold details, bundled Prata display type and IBM Plex Sans body type. Keep explicit light theme support. One five-item dock: City, Appeals, Submit, Council, Profile. Secondary destinations remain available through a shared section menu and desktop rail. Use a generated council panorama and existing city artwork; keep all business content and counts real.

- [x] Reproduce the city/work navigation mismatch at phone and tablet widths.
- [x] Share navigation across city and work; reserve dock clearance and synchronize breakpoints.
- [x] Add themed SVG icons, reusable artwork heroes, real summary metrics and responsive profile layout.
- [x] Apply shared surface, type, spacing, button and motion tokens; retain reduced-motion and keyboard support.
- [x] Verify build, contrast, phone/tablet/desktop route transitions, secondary navigation and horizontal overflow.

Validation: production build; 46 contrast pairs across explicit light/dark palettes; browser regression at 375, 565, 768, 880, 1024 and 1440 pixels; landscape controls; menu dismissal by Escape; actual menu navigation to Library; actual dock clicks to Submit and Appeals; route scroll reset. Reviewed by a separate agent: fixed landscape camera positioning and light-theme unread contrast on the dark rail.

The already-running demo on port 3100 belongs to the separate voice worktree. Use this checkout's Vite on 5173 with its API proxy; do not change the other worktree or replace its voice implementation.
