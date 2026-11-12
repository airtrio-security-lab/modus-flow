# ADR-0017 · «Наследие Королевства»: one knowledge model in three halls

**Status.** Accepted (owner brief 2026-11-11, «Наследие Королевства»). Migration `0012_legacy.sql`,
module `platform/modules/legacy.ts`, domain `platform/domain/legacy.ts`, screen `web/src/screens/Library.tsx`.

**Goal.** An employee can see not only WHAT the company decided, but WHY, WHAT came of it and WHAT was learned.

## Decision

* **One model, three levels.** `knowledge_items` has a `level` (`chronicle` → `library` → `archive`), a `status`
  (`active`, `needs_review`, `outdated`) and a pending `review`. The card lives in append-only
  `knowledge_versions` (each with `change_reason`); provenance in `knowledge_sources`; re-applications in
  `knowledge_applications`; every step in append-only `knowledge_transitions`. No three separate databases.
* **The card** (all written by a person): problem, options, arguments for and against, decision, initiator and
  responsible people, reasons, actions and due dates, results, positive and negative experience, evidence; for
  the Higher Archive — category, proof, applicability, date of the last check, grounds of inclusion.
* **Летопись (chronicle).** An entry needs at least one source the author can open: an item, a meeting, a
  meeting finding, other knowledge. Its chronology is assembled from the real records of the sources — item
  published, council arguments and recommendations, decision, implementation report, effect approval, meeting,
  finding confirmed — plus the knowledge's own transitions. Nothing is typed into the chronology by hand.
* **Библиотека решений.** A curator proposes (the card must state problem, decision and reasons); the archivist
  — not the proposer — accepts after checking provenance, evidence and classification, or returns it.
* **Высший Архив.** The archivist prepares the conclusion (a new version: proof, applicability, last check,
  grounds, category). A method or a re-applied solution needs at least one re-application on another item whose
  implementation report was filed; an improvement needs the effect of its item approved by the decision owner;
  a lesson needs the negative experience. A decision owner or an admin — not the author of the conclusion —
  approves. Archived knowledge is not edited quietly: first «повторная проверка», then a new conclusion.
* **No automatic transitions.** The application role has no INSERT/UPDATE on any knowledge table; every change
  goes through `app_knowledge_*` functions that check the person's role. Likes, XP and views do not exist as
  inputs. «Давно не проверялось» (> 365 days) is a hint in the list, never a transition.
* **Revision without destruction.** `reverify_requested` and `outdated` change the status with a reason; all
  versions and transitions stay; deleting knowledge rows is refused by triggers.
* **Roles.** «Архивариус» is a system role (admin grants and revokes it, audited) for curation only. Neither it
  nor any game title opens material: knowledge is visible to full members who can open every source (closed
  meeting ⇒ its participants), unless an approver opened the retold card to the organization with a reason. Even
  then the meeting itself stays participant-only and is shown as «Закрытое заседание — доступно только участникам».
  The Higher Archive is not public by default.
* **Retention.** Knowledge references sources, it never stores a transcript. A card that repeats ≥ 12
  consecutive words of a meeting transcript or a finding quote is refused (shorter quotes are citations). When
  a transcript is purged on schedule, provenance says «расшифровка удалена по сроку хранения; подтверждённые
  выводы сохранены» and the retold card stays.
* **Royal messages** (on the existing mechanism, ADR-0016): `knowledge_submitted` → approvers («…Архивариус
  представил новое знание для рассмотрения Советом»), `knowledge_in_library` → the people whose decision it
  records («Ваше решение … внесено в Библиотеку»), `knowledge_archived` → the same people, archivists and the
  conclusion's author («Совет утвердил включение метода … в Высший Архив»), `knowledge_reverify` → the same plus
  those who recorded re-applications («…ранее принятый метод требует повторной проверки»). Each is proven by the
  actor's transition (`app_notify_knowledge`), goes only to readers who may see the knowledge and opens it.
* **Helper, honestly named.** «Помощник Архивариуса» finds similar knowledge and related items by word
  similarity (pg_trgm), flags «возможное противоречие» (similar problem, differently worded decision) and builds
  a short note from card fields by a template. Every output is labelled «не AI». The AI archivist is not
  connected: there is no permitted model integration; the slot reports `ai.connected = false`.
* **UI.** «Великая библиотека» building on the Kingdom map; three arched hall doors with counts; one search over
  all halls showing hall and verification level; cards; the knowledge page with provenance, chronicle, versions,
  transitions, role-dependent actions. After a confirmed approval the hall doors open and the volume takes its
  shelf place; in light graphics or with reduced motion the picture is static.

## Not done (P1/P2)

* AI-assisted classification and linking — needs a permitted model (local Ollama path exists for the advisor, not
  wired here).
* Automatic detection of outdated methods beyond the «давно не проверялось» hint; comparative analysis of decisions.
* Knowledge sources from work chats — no chat integration exists.
* Removal of a person's personal data inside a retold card (for example, a name typed in the text) is manual:
  an admin revises the card with a reason; the older version keeps the text. A per-field redaction procedure is
  not built.
