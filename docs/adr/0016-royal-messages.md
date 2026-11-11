# ADR-0016 · «Королевские послания»: personal, functional notifications on the existing mechanism

**Status.** Accepted (owner brief 2026-11-11). No new notification service: the existing `notifications` table,
the proof-of-event functions (`app_notify`, `app_notify_meeting`) and the existing per-event subscriptions
(`notification_subscriptions`, `app_notification_enabled`) are extended.

**Decision.**
* **Personal address.** The reader chooses the style — game («королевский») or plain business — and the form
  of address: by title, «Милорд», «Миледи», «Мастер» or neutral «Коллега». By title: King → «Ваше Величество»,
  Regent → «Регент», castle head → «Глава замка «…»», guild member → the guild title. The gender is never
  guessed from a name: «Милорд»/«Миледи» is only the person's own choice. The title changes words, never rights.
* **Business text always.** Every message carries the plain business sentence (who did what with which item);
  decisions and deadlines are always readable without the game.
* **Council invitation.** Topic, organizer, date and time, related item, why this person is invited (decides,
  leads the item, raised it, heads the castle…), what to do. «Участие ожидается» only when the organizer has
  the authority (decision owner or admin for the royal council, the castle head for a small council);
  otherwise «по желанию». Actions: «Войти в Совет», «Подтвердить участие», «Не могу присутствовать»,
  «Ознакомиться с вопросом». The headline «Король созывает Совет» appears only when the real sender holds the
  King title; nothing imitates a message of the King.
* **Events** (game headline / real action): Совет созван; заседание перенесено / отменено; требуется заключение
  (pilot owner); в замок прибыл посол (new item); решение Совета ждёт вас (decision needed); получено поручение;
  приближается срок (once per deadline, by the escalation job); Совет просит уточнить; решение зафиксировано;
  внедрение завершено; замок получил XP (once per award); замок повысил уровень. Decision results reach
  everyone who argued at the council of the item or sat at a meeting about it.
* **Reliability.** Every message is proven by a record of the event (database functions refuse otherwise);
  `(recipient, dedupe_key)` is unique, so repeats are not duplicated; a rescheduling produces one message per new
  time; a cancelled meeting accepts no answers and no further invitations; a removed participant loses access
  and receives nothing more — the old invitation shows only that access is closed, not the meeting's content.
* **Settings.** Grouping of repeats; optional messages (castle XP and levels; comments and progress; council
  recommendations, recording and findings) can be switched off; decisions, deadlines, assignments, invitations
  and requests for clarification cannot (enforced in the database). Channel: in the app only; e-mail and
  messengers are shown as not connected (they need the owner's approval and setup).
* **Interface.** A notification center with a scroll-and-seal icon per category, headline, the game sentence,
  the business sentence, facts, time, read state, filters (Совет, Обращения, Решения и поручения, Сроки,
  Замок, непрочитанные) and actions. An urgent unread message unfolds once (380 ms, not blocking); no
  animation with reduced motion or in the light mode; no background animation. Readable on a 390 px phone.

**Consequences.**
+ The game layer sits on the real events and rights; switching it off leaves an ordinary business inbox.
− «Отменить» и «перенести» есть только до начала записи; after recording, the meeting is history.
− Frequency settings beyond grouping make sense only with external channels, which are not connected.
