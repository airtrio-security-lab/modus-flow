# ADR-0013 · MODUS ADVISOR: minimal assistant, honest about how it works

**Status.** Accepted for the demo (owner brief 2026-11-11: «приоритет — работающий вертикальный сценарий
на тестовом протоколе совещания с подтверждением фактов человеком»; «не делай вид, что обычный текстовый
поиск является полноценным AI-анализом»; «не подключай платные сервисы без моего разрешения»).

**Context.** The original advisor brief lists a short employee questionnaire, a competence and preference
card, working capacity, import of a meeting protocol, extracting tasks from text, keeping the source
evidence, executor recommendations, human confirmation and a seat for the advisor at the round table.
No AI service is connected to the project, and paid APIs (Anthropic, OpenAI and similar) need the
owner's approval, which has not been given.

**Decision.**
* **The advisor proposes; a person decides.** It never closes items, never awards XP, never assigns
  credit and never sets the implementer. Database rights enforce this, not only the UI.
* **Default method: transparent rules, labelled «Разбор по шаблону (без ИИ)».** Lines with markers
  («решили», «нужно», «не работает», «предлагаю»…) and bullets under «Решили:» become candidates.
  Executors are matched by questionnaire skills found in the item text, then by current load. Every
  screen that shows these results says «без ИИ» / «Правила, без ИИ».
* **Optional local model (Ollama), off by default.** `MODUS_ADVISOR_PROVIDER=ollama`,
  `MODUS_ADVISOR_MODEL`, `MODUS_ADVISOR_URL` (default `http://127.0.0.1:11434`). A non-local URL is
  refused unless `MODUS_ADVISOR_ALLOW_REMOTE=true`, because meeting notes would leave the machine.
  The model output is kept only where its quote is literally present in the protocol; offsets are
  computed by the server, never taken from the model. No paid provider is wired in.
* **Evidence.** `meeting_protocols` stores the source verbatim with SHA-256, append-only.
  `protocol_candidates` keeps the quote and its offsets; a trigger refuses a quote that is not the exact
  protocol text, evidence never changes, a decision (accepted / dismissed) is made once and kept.
* **Human confirmation.** A lead (maintainer, decision owner or admin, full member) checks kind,
  title, wording and who raised it; only then an ordinary item is created through the same intake path
  (`source_channel = 'meeting'`, routed by the usual rules, credit `issue_found` to the person named).
  For a proposal the problem field starts empty: the protocol rarely states it, nothing is invented.
* **Questionnaire** (`employee_profiles`): skills (≤ 12), preferences, hours a week. Visible to the
  person and to leads, not to colleagues; only the person writes it.
* **Executor confirmation** (`executor_confirmations`, append-only): the item's maintainer or decision
  owner, not an originator, confirms a suggested person once. The decision form preselects the latest
  confirmed person; the decision owner still names the implementer in the decision.
* **Seat at the round table:** a dashed chair «Помощник Совета · без права голоса» below the table; it
  opens the suggestion panel. It has no stance and is not counted among participants.

**Consequences.**
+ A working vertical scenario with no external service and no cost: protocol → confirmed items →
  executor suggestion → decision.
+ The interface cannot be mistaken for AI analysis while no model is connected.
− The template misses tasks phrased without markers; the page says so and offers the one-by-one form.
− Skill matching is word-prefix matching, not semantics; capacity is the hours the person stated and
  the number of items they are implementing, not a calculated workload.
− The Ollama path is tested with a stub server only; it has not been run against a real model here.
