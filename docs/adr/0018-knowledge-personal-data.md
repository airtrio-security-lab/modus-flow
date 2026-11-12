# ADR-0018 · Personal data in organizational memory: checks at any length, erasure without losing history

**Status.** Accepted (owner brief 2026-11-11, stabilization). Migration `0013_knowledge_privacy.sql`, domain
`platform/domain/privacy.ts`, module `platform/modules/knowledge-privacy.ts`, CLI `platform:ledger`,
admin panel «Персональные данные в знаниях» (Settings). Tests: `test/platform/knowledge-privacy.test.ts`.

## Where personal data can sit in «Наследие» (audit)

| Place | Content | Before | Now |
|---|---|---|---|
| `knowledge_versions.title`, `.card`, `.change_reason` | free text of every version | append-only, never changeable | checked on write; erasable per (version, field) |
| `knowledge_versions.card.initiator / responsible` | references to people | kept forever | removed by pseudonymization |
| `knowledge_transitions.reason`, `knowledge_sources.note`, `knowledge_applications.note` | free text | append-only | checked on write; erasable per row |
| `knowledge_items.title` | copy of the current title | — | follows the erased version |
| Search | full-text GIN index on version text; trigram similarity computed on the fly | — | no separate copy: the index follows the rows; dead row versions are vacuumed by the daily job |
| `notifications` | ids and event type only, text built on reading | — | verified by a test: no text columns besides `event_type`, `dedupe_key` |
| `audit_events` for knowledge | kind, counts, version | — | erasure adds only the count of places |
| Names on the knowledge page (authors, actors, item author) | read from the directory | — | «Сотрудник (обезличен)» for a pseudonymized person |
| Database backups and WAL archives | everything as of the backup | — | see «Backups» below |

## Decision

* **Checks at any length.** A pattern detector (not AI) finds e-mail, phones, IIN/BIN and other long numbers,
  card and IBAN numbers, document numbers, dates of birth, addresses, health, pay, disciplinary details,
  employees' surnames and confidentiality markers. Applied to the title, every card field, version reasons,
  transition reasons and notes. Personal data is refused; confidentiality markers are refused where the text is
  organization-wide. Messages name the field and the kind, never the value. People are named through the
  card's people fields (references), so they can be pseudonymized.
* **Opening to the organization** re-checks every version and note — old versions remain readable in the
  history — and the closed source meeting's material: numbers and sensitive details from the meeting refuse
  opening at any length. Rights are checked before content, so a refusal does not reveal what is inside.
* **Erasure** — organization admin only, with a legal basis (subject request, consent withdrawn, retention
  expired, unlawful processing, authority order) and a request reference. The admin works from a content-free
  scan: places and kinds, titles only of knowledge they may read. Chosen places are overwritten with
  «[удалено: персональные данные]» in the targeted versions; rows, versions and transitions stay. The history
  gets a «personal_data_erased» step with the basis and the number of places.
* **Pseudonymization of an employee** — removes the person's references from every card version, erases text
  places with their surname in the same step, and shows «Сотрудник (обезличен)» wherever knowledge names them.
  Once per person.
* **The log keeps the fact, not the data.** `knowledge_redactions`: basis, reference, places (version and field
  or row id), counts, actor, time; for a person — their internal id, never a name. The reference itself is
  checked: no personal data, no words of the erased values.
* **Legal hold** on a source meeting blocks erasure (owner decision 3).
* **Backups.** The daily `platform:retention` job re-applies every logged erasure (content restored from a
  backup is erased again) and vacuums the affected tables. A backup older than an erasure lacks the log too,
  so the log is exported as a ledger (`platform:ledger export`) and kept outside database backups; after any
  restore — `platform:ledger import`, which brings back missing log rows and re-applies them.
* **Bypass.** The application role has no write access to knowledge; the purge switch works only inside the
  owner's functions; rows are never deleted.

## Limits (stated, not hidden)

* The detector is a set of patterns. It knows the organization's employees by surname; names of outsiders,
  first names alone, indirect identification («единственный кладовщик второй смены») are not detected. The
  admin panel and refusals say «по шаблонам, проверяет человек».
* Database backups and WAL archives keep erased content until they rotate. The backup retention must not exceed
  the shortest retention period and must be confirmed by the company's lawyers.
* Items, comments and council entries are outside the knowledge module: they follow the item workflow; no
  erasure procedure for them is built yet.
* An employee's account and directory entry are not deleted by pseudonymization in knowledge.
