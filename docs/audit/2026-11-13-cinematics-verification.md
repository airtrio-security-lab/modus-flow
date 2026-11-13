# Проверка роликов кинематографических уведомлений

Дата: 2026-11-13. Источник: `MODUS_FLOW_cinematics_for_Claude.zip` (17 MP4, манифест, отчёт архива). Решение — [ADR-0037](../adr/0037-cinematic-notifications.md); машиночитаемо — [`docs/cinematics/manifest.json`](../cinematics/manifest.json).

## Как проверялось

- **Целостность:** SHA-256 каждого файла сверен с манифестом архива — 17 из 17 совпали.
- **Техника (ffprobe):** все файлы H.264 High, yuv420p, 1080×1920, 24 к/с, AAC-LC 48 кГц стерео; длительность 3,92 или 4,96 с.
- **Изображение:** по четыре кадра из каждого ролика. Текста, вшитого в кадр, нет — кнопки делает интерфейс.
- **Речь:** faster-whisper 1.2.1 локально, язык `ru`, модели `small` и `large-v3` (int8, CPU); для спорного ролика 01 — ещё и `medium`. Веб-версии после перекодирования распознаны повторно (`small`).
- **Человеком не прослушано.** Голос с утверждённым образцом не сравнивался.

## Все 17 оригиналов

| Файл | Догадка архива | Речь (large-v3) | Речь (small) | Речь, с | Решение |
|---|---|---|---|---|---|
| `01_knowledge_archived.mp4` | `knowledge_archived` | Этот принят в высший архив. | Метод принят в высший архив. | 2.54 из 3.92 | connected as knowledge-archived |
| `02_envoy_accepted.mp4` | `royal_audience_accepted` | Внедрение одобрено. | Внедрение одобрено. | 1.54 из 4.96 | connected as implementation-approved |
| `03_implementation_completed.mp4` | `implemented_confirmed` | Внедрение успешно завершено. | Внедрение успешно завершено. | 4.10 из 4.96 | connected as implementation-completed |
| `04_contribution_recognized.mp4` | `contribution_confirmed` | Ваш вклад признан. | Ваш вклад признан. | 2.54 из 3.92 | not connected — Событие contribution_confirmed объявлено, но сервер его нигде не создаёт |
| `05_castle_level_up.mp4` | `castle_level_up` | Замок достиг нового уровня! | Замок достиг нового уровня! | 2.56 из 3.92 | connected as castle-level-up |
| `06_proposal_under_review.mp4` | `idea_review_started` | Предложение на рассмотрение. | Предложение на рассмотрение. | 2.06 из 4.96 | not connected — Автору не приходит отдельное событие «обращение взято на рассмотрение» |
| `07_assignment_created.mp4` | `assigned` | Вам поручено дело! | Вам поручено дело. | 2.06 из 3.92 | connected as assignment |
| `08_implementation_approved.mp4` | `authorized_implementation_decision` | Король принял вашего посла. | Король принял вашего посла! | 2.68 из 4.96 | connected as envoy-accepted |
| `09_knowledge_library_alt.mp4` | `knowledge_in_library` | Решение внесено в библиотеку. | Решение внесено в библиотеку. | 2.28 из 3.92 | not connected — Второй вариант для knowledge_in_library; одно событие — одна сцена |
| `10_knowledge_in_library.mp4` | `knowledge_in_library` | Новое знание пополнило библиотеку. | Новое знание пополнило библиотеку. | 2.78 из 3.92 | connected as knowledge-in-library |
| `11_envoy_arrived.mp4` | `royal_audience_received` | Милорд, к вам прибыл посол! | Милорд! К вам прибыл посол! | 3.94 из 4.96 | connected as envoy-arrived |
| `12_changes_requested.mp4` | `changes_requested` | Совет просит уточнений. | Совет просит уточнений. | 3.40 из 3.92 | connected as changes-requested |
| `13_envoy_sent.mp4` | `royal_audience_requested` | Ваш посол отправлен! | Ваш посол отправлен! | 2.06 из 4.96 | connected as envoy-sent |
| `14_council_invitation.mp4` | `meeting_called` | Вас приглашают обсудить вопрос на совете. | Вас приглашают обсудить вопрос на Совете. | 3.78 из 4.96 | connected as council-invitation |
| `15_great_council_gathered.mp4` | `meeting_started_verified` | Великий Совет собран! | Великий Совет Собран | 2.24 из 4.96 | not connected — Нет проверенного серверного факта «заседание началось»; приглашение им не является |
| `16_notification_variant_a.mp4` | `notification_unread` | К вам пришло уведомление. Хотите посмотреть сейчас? | К вам пришло уведомление. Хотите посмотреть сейчас? | 4.08 из 4.96 | connected as notification |
| `17_notification_variant_b.mp4` | `notification_unread` | К вам пришло уведомление. Хотите посмотреть сейчас? | К вам пришло уведомление. Хотите посмотреть сейчас? | 4.18 из 4.96 | not connected — Второй вариант общего уведомления; выбран вариант A |

**Названия 02 и 08 перепутаны:** звук говорит обратное названию. Обе сцены — рука ставит печать на документ, по кадрам их не различить.

**Ролик 01:** первое слово — «Этот» (large-v3, 0,57), «Этот» (medium, 0,40) или «Метод» (small, 0,69); остальная фраза «принят в Высший Архив» распознана уверенно всеми моделями.

Во всех роликах фраза заканчивается до конца файла (запас 0,5–3,4 с) — обрезанной речи нет.

## Веб-версии в репозитории (`web/public/cinematics/`)

Кодирование: 720x1280 H.264 High@4.0 yuv420p CRF 25 maxrate 2 Mbit/s +faststart; AAC-LC 96 kbit/s 48 kHz stereo; poster = frame 0.35 s before the end, 540x960 JPEG.

| Сцена | Из файла | Событие | Кадр, длительность | Размер | Речь в веб-версии |
|---|---|---|---|---|---|
| `council-invitation` | `14_council_invitation.mp4` | notification:meeting_called | 720×1280, 4.96 с | 0.95 МБ | Вас приглашают обсудить вопрос на Совете. |
| `changes-requested` | `12_changes_requested.mp4` | notification:changes_requested | 720×1280, 3.92 с | 0.46 МБ | Совет просит уточнений. |
| `assignment` | `07_assignment_created.mp4` | notification:assigned | 720×1280, 3.92 с | 0.54 МБ | Вам поручено дело. |
| `castle-level-up` | `05_castle_level_up.mp4` | notification:castle_level_up | 720×1280, 3.92 с | 0.88 МБ | Замок достиг нового уровня! |
| `implementation-approved` | `02_envoy_accepted.mp4` | notification:idea_merged | 720×1280, 4.96 с | 0.83 МБ | Внедрение одобрено! |
| `implementation-completed` | `03_implementation_completed.mp4` | notification:implemented | 720×1280, 4.96 с | 0.86 МБ | Внедрение успешно завершено. |
| `knowledge-in-library` | `10_knowledge_in_library.mp4` | notification:knowledge_in_library | 720×1280, 3.92 с | 0.69 МБ | Новое знание пополнило библиотеку. |
| `knowledge-archived` | `01_knowledge_archived.mp4` | notification:knowledge_archived | 720×1280, 3.92 с | 0.68 МБ | Метод принят в высший архив. |
| `envoy-sent` | `13_envoy_sent.mp4` | audience:sender/requested | 720×1280, 4.96 с | 1.08 МБ | Ваш посол отправлен! |
| `envoy-arrived` | `11_envoy_arrived.mp4` | audience:king/requested | 720×1280, 4.96 с | 0.95 МБ | Милорд, к вам прибыл посол! |
| `envoy-accepted` | `08_implementation_approved.mp4` | audience:sender/accepted | 720×1280, 4.96 с | 0.84 МБ | Король принял вашего посла! |
| `notification` | `16_notification_variant_a.mp4` | notification:urgent without own scene | 720×1280, 4.96 с | 0.62 МБ | К вам пришло уведомление. Хотите посмотреть сейчас? |

Итого 12 сцен — 9,7 МБ (оригиналы — 55 МБ). У каждой есть неподвижная заставка `.jpg` (последний кадр) для уменьшения движения и облегчённой графики.

## Дополнение: решения владельца и сцены 04, 15 ([ADR-0042](../adr/0042-contribution-confirmed-and-great-council.md))

Ответы владельца 2026-11-13: ролик 15 — к началу заседания Большого Круглого стола; для ролика 04 создать
событие там, где вклад подтверждают; первое слово ролика 01 владелец проверит на слух сам; варианты 10
вместо 09 и 16 вместо 17 подтверждены.

| Сцена | Из файла | Событие | Кадр, длительность | Размер | Речь в веб-версии |
|---|---|---|---|---|---|
| `contribution-recognized` | `04_contribution_recognized.mp4` | notification:contribution_confirmed (новое действие «Подтвердить вклад») | 720×1280, 3.92 с | 0.53 МБ | Ваш вклад признан. |
| `great-council-gathered` | `15_great_council_gathered.mp4` | notification:meeting_recording_started, только Большой Круглый стол, не завершено, участник не отказался, ≤ 12 ч | 720×1280, 4.96 с | 1.29 МБ | Великий Совет Собран |

SHA-256 исходников 04 и 15 совпали с манифестом архива. Теперь 14 сцен — 11,5 МБ. Не подключены: 06 (нет
события «взято на рассмотрение» для автора), 09 и 17 (вторые варианты).
