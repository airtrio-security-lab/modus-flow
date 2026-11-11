# MODUS FLOW · Google Flow: cinematic audience production

**Status:** Visual production plan only. **The animation currently embedded in README is the existing in-browser SVG prototype recreated as a looping GitHub preview, not a Google Flow render, 3D gameplay capture, or an actual confirmed employee interaction.**

## Product rule

MODUS FLOW is first a **corporate workflow service** for employee feedback, responsible decisions, implementation and knowledge. An animated envoy is only an artistic visualization of an auditable business event. The game layer must never grant access, change the status of an issue, create a meeting or award XP.

Current implementation is in [PR #14](https://github.com/airtrio-security-lab/modus-flow/pull/14), isolated from `main`. The event `royal_audience.accepted` is the only valid trigger of the sender's acknowledgement scene. Approval, implementation and summoning the Council remain separate authorized actions.

## Target: cinematic shot generated with Google Flow

Use [Google Flow](https://labs.google/fx/tools/flow) as the planned video-generation workflow, **not as a claimed current renderer**. Replace the SVG preview with actual approved, exported media when available.

**Master visual direction:** physically plausible architectural fantasy; serious cinematic period drama; premium stone, brushed bronze and dark timber; golden-hour shaft of light; restrained tones; no toy-like buildings, exaggerated faces or direct copies of existing games. Original medieval-inspired audience hall of the Great Commonwealth. No GTA, Shogun or other copyrighted visual assets, logos or recognizable character likenesses.

**Mandatory people policy:** **NO visible human faces at any time.** Only fully anonymous, faceless clothed silhouettes from the back or distant side angles, in shadow. No close-ups of facial features, eyes, nose, mouth, portraits, photographs, real employee likenesses or recognizable actors.

### Six-second storyboard (desktop 16:9)

| Time | Shot |
|---|---|
| 0.0–1.2 s | Slow establishing push into the vaulted ceremonial hall; distant King is a faceless silhouette at the throne |
| 1.2–3.0 s | A solitary envoy in a cloak, face hidden, enters along the stone aisle carrying a sealed letter |
| 3.0–4.5 s | Envoy bows from the back; King raises an arm to acknowledge receipt; warm rim light on architecture |
| 4.5–6.0 s | Elegant hold on the audience; overlay message added **in MODUS FLOW UI**: “Король принял вашего посла” |

**Mobile variant:** portrait 9:16 reframing that keeps the two silhouettes recognizable and preserves an unobstructed region for the UI caption. The same six-second narrative and server event. Always offer **Skip**, `prefers-reduced-motion` static fallback, silent-by-default playback and subtitles. Avoid cinematic takeover of essential workflow actions.

### Suggested Flow generation prompt

> Cinematic architectural fantasy film sequence, 6 seconds, original historic-inspired vaulted royal hall built from weathered stone, aged dark wood and brushed bronze, physically credible scale, subdued atmospheric fog, warm golden shaft of sunlight and deep navy shadows. A single completely faceless, anonymous cloaked envoy approaches the throne from behind carrying a sealed parchment. The seated King is seen only as a small fully faceless silhouette, from behind or in deep shadow, never showing any facial features. Envoy comes to a stop, performs a restrained bow, King acknowledges with a slight hand gesture. Slow cinematic dolly, realistic materials, restrained motion, nuanced lighting, sophisticated art direction, solemn but hopeful. No war, no combat, no fantasy magic, no cartoon or toy aesthetics, no identifiable people, no frontal faces, no close-up portraits, no logos, no text inside the generation.

Add text, controls and real issue number later using the application UI, **not inside generated footage**.

## Asset and review checklist

- Export approved clips as `royal-audience-desktop.mp4` and `royal-audience-mobile.mp4` with poster image and small looping GIF/WebP preview for GitHub README.
- Maintain original copyrighted artwork rights and the provider's applicable usage terms; keep source prompts and version references.
- Verify no faces, no unrealistic anatomy, no continuity breaks and clear, understated visual direction.
- Test autoplay restrictions, mobile performance, muted playback, reduced-motion preference and easy exit.
- Label any generated scenes in documentation as **illustrative cinematic visualization**; never present them as filmed real-world events or evidence of a completed implementation.
- Trigger the video only after confirmation of `accepted_at` by the authenticated server, with deduplication and access checks.
