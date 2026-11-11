import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDatabase, withAdminTx, type Database } from '../db/pool.ts';
import { saveMyProfile } from '../modules/advisor.ts';
import { assignTitle, setGuildTitles } from '../modules/titles.ts';
import { createMeeting, setConsent } from '../modules/meetings.ts';
import * as legacy from '../modules/legacy.ts';
import { savePreferences } from '../modules/notifications.ts';
import { migrate } from '../db/migrate.ts';
import type { OrgActor, OrgRole } from '../domain/model.ts';
import * as admin from '../modules/admin.ts';
import { submitItem, type SubmitInputT } from '../modules/intake.ts';
import * as wf from '../modules/workflow.ts';
import * as progressMod from '../modules/progress.ts';
import * as council from '../modules/council.ts';
import { uploadAttachment } from '../modules/attachments.ts';
import { addMember, createOrganization, createUser } from '../modules/provisioning.ts';

/**
 * Demo data for the hackathon finale: a FICTIONAL organization modelled on a
 * physical-security integrator (departments, roles, typical questions). All
 * people, names and cases are invented. Every history is produced through the
 * real services (so all rules apply); afterwards each item's timeline is
 * shifted back in time as a whole, with triggers disabled for that one step,
 * so the dashboard shows realistic ages, overdue items and escalations.
 *
 * Usage: MIGRATION_DATABASE_URL=… MODUS_DEMO_PERSONAS=.demo/personas.json node platform/cli/seed-modus-demo.ts
 * Writes the persona list (user ids, roles) used by the demo login screen.
 */
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
const personasPath = process.env.MODUS_DEMO_PERSONAS ?? '.demo/personas.json';
const db: Database = createDatabase(url, 4);

type Person = OrgActor & { name: string; title: string; department: string; persona?: string };

const ORG_SLUG = 'modus-demo';
const ORG_NAME = 'Модус Трейд — демо';

async function main() {
  await migrate(db);
  const existing = await db.pool.query('SELECT 1 FROM organizations WHERE slug = $1', [ORG_SLUG]);
  if (existing.rowCount) throw new Error(`Organization "${ORG_SLUG}" already exists — use a fresh database`);
  const orgId = await createOrganization(db, ORG_SLUG, ORG_NAME);

  const mk = async (name: string, title: string, department: string, roles: OrgRole[], persona?: string): Promise<Person> => {
    const userId = await createUser(db, name);
    const membershipId = await addMember(db, orgId, userId, roles, { department, jobTitle: title });
    return { userId, orgId, membershipId, roles, access: 'member', name, title, department, persona };
  };

  // ---- people (fictional) -------------------------------------------------
  const owner = await mk('Ерлан Касымов', 'Собственник компании', 'Руководство', ['employee', 'decision_owner', 'org_admin'], 'Собственник: видит всё, получает эскалации');
  const ops = await mk('Айгерим Нурланова', 'Операционный директор', 'Руководство', ['employee', 'maintainer', 'decision_owner'], 'Операционный директор: принимает решения');
  const itLead = await mk('Дмитрий Орлов', 'Руководитель ИТ-разработки', 'ИТ-разработка', ['employee', 'maintainer'], 'Руководитель ИТ: ведёт обращения по ИТ');
  const whHead = await mk('Олег Киселев', 'Начальник склада', 'Склад и логистика', ['employee', 'maintainer', 'decision_owner'], 'Руководитель подразделения: рассматривает и решает');
  const svcHead = await mk('Тимур Ахметов', 'Руководитель сервиса', 'Сервис', ['employee', 'maintainer', 'decision_owner']);
  const salesHead = await mk('Сауле Бекова', 'Руководитель отдела продаж', 'Продажи', ['employee', 'maintainer', 'decision_owner']);
  const pnrHead = await mk('Нурлан Абенов', 'Руководитель пусконаладки', 'Пусконаладка', ['employee', 'maintainer', 'decision_owner']);
  const storekeeper = await mk('Асель Темирова', 'Кладовщик', 'Склад и логистика', ['employee'], 'Сотрудник: подаёт обращения и следит за статусом');
  const engineer = await mk('Руслан Исаев', 'Сервисный инженер', 'Сервис', ['employee'], 'Сервисный инженер: работает на объектах');
  const manager = await mk('Мадина Жумабаева', 'Менеджер по продажам', 'Продажи', ['employee']);
  const buyer = await mk('Виктория Ким', 'Специалист по закупкам', 'Закупки', ['employee']);
  const designer = await mk('Данияр Сейткали', 'Инженер-проектировщик', 'Проектирование', ['employee']);
  const sysAdmin = await mk('Гульнара Ахметжанова', 'Администратор системы', 'ИТ-разработка', ['employee', 'org_admin'], 'Администратор: категории, правила, сроки');
  const archivistBase = await mk('Лейла Садыкова', 'Архивариус', 'Руководство', ['employee'], 'Архивариус: проверяет знания, закрытых заседаний не видит');

  // ---- reference data -----------------------------------------------------
  const dep = async (name: string, head?: Person) => (await admin.createDepartment(db, sysAdmin, { name, head: head?.membershipId ?? null })).id;
  const D = {
    mgmt: await dep('Руководство'),
    sales: await dep('Продажи', salesHead),
    purchasing: await dep('Закупки', ops),
    design: await dep('Проектирование'),
    service: await dep('Сервис', svcHead),
    pnr: await dep('Пусконаладка', pnrHead),
    warehouse: await dep('Склад и логистика', whHead),
    it: await dep('ИТ-разработка', itLead),
  };
  // Fictional department sizes: only for the normalized rating (XP per 10 people).
  const sizes: [string, number][] = [[D.mgmt, 4], [D.sales, 12], [D.purchasing, 6], [D.design, 9], [D.service, 15], [D.pnr, 11], [D.warehouse, 18], [D.it, 7]];
  for (const [id, headcount] of sizes) await admin.updateDepartment(db, sysAdmin, id, { headcount });
  const cat = async (name: string, description: string, sortOrder: number) =>
    (await admin.createCategory(db, sysAdmin, { name, description, sortOrder })).id;
  const C = {
    process: await cat('Процессы и согласования', 'Регламенты, согласования, взаимодействие отделов', 10),
    it: await cat('ИТ и инструменты', 'Программы, оборудование, доступы', 20),
    warehouse: await cat('Склад и логистика', 'Приёмка, хранение, отгрузка, доставка', 30),
    clients: await cat('Работа с заказчиками', 'Сроки, качество, коммуникация с заказчиками и интеграторами', 40),
    safety: await cat('Охрана труда', 'Безопасность на объектах и в офисе', 50),
    knowledge: await cat('Обучение и знания', 'Обучение, база знаний, наставничество', 60),
    docs: await cat('Документы и отчётность', 'Акты, исполнительная документация, счета', 70),
  };
  await admin.createRule(db, sysAdmin, { categoryId: C.it, maintainer: itLead.membershipId, decisionOwner: ops.membershipId, firstResponseHours: 8, resolutionDays: 10 });
  await admin.createRule(db, sysAdmin, { categoryId: C.warehouse, maintainer: whHead.membershipId, firstResponseHours: 24 });
  await admin.createRule(db, sysAdmin, { categoryId: C.clients, maintainer: salesHead.membershipId, escalateTo: owner.membershipId, firstResponseHours: 24, resolutionDays: 7 });
  await admin.createRule(db, sysAdmin, { categoryId: C.process, maintainer: ops.membershipId, priority: 200 });
  await admin.updateSettings(db, sysAdmin, { escalationMembershipId: owner.membershipId, defaultFirstResponseHours: 48, defaultResolutionDays: 14, staleDays: 7 });

  // ---- items ----------------------------------------------------------------
  let k = 0;
  const key = () => `seed-${Date.now().toString(36)}-${++k}`;
  const submit = async (who: Person, input: Partial<SubmitInputT> & Pick<SubmitInputT, 'title' | 'problem' | 'kind'>) =>
    (await submitItem(db, who, { sourceChannel: 'app', ...input } as SubmitInputT, key())).body.item.number;
  const comment = (who: Person, n: number, body: string) => wf.addReview(db, who, n, { kind: 'comment', body });
  const ask = async (who: Person, n: number, body: string) => (await wf.addReview(db, who, n, { kind: 'request_changes', body })).body.id;
  const progress = (who: Person, n: number, body: string) => wf.addReview(db, who, n, { kind: 'progress', body });
  const shifts: { n: number; days: number }[] = [];
  const age = (n: number, days: number) => shifts.push({ n, days });

  // 1. Implemented quickly by the head of the warehouse (hybrid powers).
  const n1 = await submit(storekeeper, {
    kind: 'idea',
    title: 'Разметить зоны приёмки и отгрузки на складе',
    problem: 'Новые сотрудники и водители путают, где принимать товар, а где готовить отгрузку. Коробки с разных заказов перемешиваются.',
    proposal: 'Нанести цветную разметку на пол (приёмка, контроль, отгрузка) и повесить таблички над каждой зоной.',
    categoryId: C.warehouse,
    departmentId: D.warehouse,
  });
  const q1 = await ask(whHead, n1, 'Сколько зон нужно и хватит ли места у ворот №2?');
  await wf.revise(db, storekeeper, n1, {
    baseRevision: 1,
    title: 'Разметить зоны приёмки и отгрузки на складе',
    problem: 'Новые сотрудники и водители путают, где принимать товар, а где готовить отгрузку. Коробки с разных заказов перемешиваются.',
    proposal: 'Три зоны: приёмка у ворот №1, контроль качества в центре, отгрузка у ворот №2. Около 20 литров краски, работы в субботу.',
    rationale: 'Уточнила количество зон и объём работ',
  });
  await wf.resolveReview(db, whHead, n1, q1, { outcome: 'resolved', note: 'Объём понятен, места хватает' });
  await wf.decide(db, whHead, n1, { outcome: 'merge', rationale: 'Недорого и сразу уберёт путаницу на приёмке', implementer: storekeeper.membershipId });
  await progress(storekeeper, n1, 'Краска закуплена, разметку наносим в субботу');
  await uploadAttachment(db, storekeeper, n1, { fileName: 'план-зон.png', contentType: 'image/png', data: TINY_PNG });
  // The author implemented it, so the head of department (not an originator) confirms completion.
  await wf.completeImplementation(db, whHead, n1, { report: 'Разметка нанесена, таблички висят. Пересортов за неделю не было.' });
  // The decision owner confirms the documented effect: the warehouse castle has 150 XP (Крепость).
  await progressMod.approveEffect(db, whHead, n1, {
    xp: 50,
    rationale: 'За месяц после разметки пересортов не было (до этого шесть в месяц), акт инвентаризации приложен',
  });
  age(n1, 24);

  // 2. IT problem with a field check: positive result, one negative observation kept.
  const n2 = await submit(storekeeper, {
    kind: 'problem',
    title: 'Терминалы сбора данных зависают при приёмке',
    problem: 'При сканировании больших партий ТСД зависают, приходится перезагружать и вводить коды вручную. Приёмка одной машины затягивается на час.',
    successCriteria: 'Приёмка машины без зависаний и ручного ввода кодов',
    categoryId: C.it,
    departmentId: D.warehouse,
  });
  await comment(itLead, n2, 'Похоже на старую прошивку. Проверим обновление на трёх терминалах.');
  const v2 = (
    await wf.startVerification(db, itLead, n2, {
      plan: 'Обновить прошивку на трёх ТСД из восьми, неделю принимать товар на них и сравнить с остальными',
      successCriteria: 'Нет зависаний на обновлённых терминалах при приёмке партий до 500 позиций',
      owner: engineer.membershipId,
    })
  ).body.id;
  await wf.recordEvidence(db, engineer, n2, v2, { kind: 'baseline', body: 'До обновления: в среднем 4 зависания за смену', metric: 'зависаний за смену', value: 4, unit: 'шт' });
  await wf.recordEvidence(db, engineer, n2, v2, { kind: 'result', body: 'После обновления: 0–1 зависание за смену', metric: 'зависаний за смену', value: 0.4, unit: 'шт' });
  await wf.recordEvidence(db, engineer, n2, v2, { kind: 'negative_observation', body: 'Один терминал после обновления перестал видеть складскую Wi-Fi сеть — потребовалась перенастройка' });
  await wf.concludeVerification(db, itLead, n2, v2, { outcome: 'positive', conclusion: 'Зависания практически ушли. Перед массовым обновлением нужна инструкция по настройке Wi-Fi.' });
  await wf.decide(db, ops, n2, { outcome: 'merge', rationale: 'Обновляем все терминалы по инструкции, с учётом проблемы Wi-Fi', implementer: itLead.membershipId });
  await progress(itLead, n2, 'Инструкция готова, обновлено 5 из 8 терминалов');
  age(n2, 16);

  // 3. Sales idea: clarification asked; the author objects and adds detail.
  const n3 = await submit(manager, {
    kind: 'idea',
    title: 'Шаблон коммерческого предложения для типовых объектов видеонаблюдения',
    problem: 'Каждое КП для типового объекта (склад, магазин, школа) собирается с нуля, на это уходит до двух дней.',
    proposal: 'Сделать три шаблона КП с типовыми спецификациями, чтобы менеджер менял только количество и адрес.',
    categoryId: C.clients,
    departmentId: D.sales,
  });
  const q3 = await ask(salesHead, n3, 'Какие объекты считать типовыми? У школ сейчас отдельные требования по проекту.');
  await wf.addReview(db, manager, n3, {
    kind: 'objection',
    parentReviewId: q3,
    body: 'Школы можно вынести отдельно, но склады и магазины — 60% наших КП за квартал, для них шаблон точно сработает.',
  });
  age(n3, 5);

  // 4. Service problem nobody answered: overdue and escalated.
  const n4 = await submit(engineer, {
    kind: 'problem',
    title: 'Выезжаем на объекты без актуальной исполнительной документации',
    problem: 'На прошлой неделе дважды приехали на объект со старыми схемами: потеряли полдня на поиск, где проложен кабель.',
    departmentId: D.service,
    categoryId: C.docs,
  });
  age(n4, 4);

  // 5. Raised at a planning meeting, recorded on behalf of the engineer; nobody owns it yet.
  const n5 = await submit(pnrHead, {
    kind: 'problem',
    title: 'Нет общей базы знаний по настройке оборудования',
    problem: 'Инженеры хранят инструкции и настройки у себя в телефонах. Когда опытный инженер в отпуске, новички звонят ему на объект.',
    categoryId: C.knowledge,
    sourceChannel: 'meeting',
    sourceNote: 'Планёрка пусконаладки',
    raisedBy: engineer.membershipId,
  });
  age(n5, 9);

  // 6. Rejected with a clear reason.
  const n6 = await submit(buyer, {
    kind: 'idea',
    title: 'Закупать кабель только у одного поставщика',
    problem: 'Кабель берём у четырёх поставщиков, цены и сроки разные, документы приходят в разном виде.',
    proposal: 'Перейти на одного поставщика с годовым договором и скидкой.',
    categoryId: C.process,
    departmentId: D.purchasing,
  });
  await comment(ops, n6, 'Идея понятная, но на гособъектах нам нужна страховка по срокам.');
  await wf.decide(db, ops, n6, {
    outcome: 'reject',
    rationale: 'Один поставщик — риск срыва сроков на гособъектах. Вместо этого сократим список до двух и унифицируем документы.',
  });
  age(n6, 12);

  // 7. Design idea in review with a colleague's suggested version (co-authorship).
  const n7 = await submit(designer, {
    kind: 'idea',
    title: 'Библиотека типовых узлов для проектов СКУД',
    problem: 'Одни и те же узлы (турникет, шлагбаум, точка доступа) каждый проектировщик рисует по-своему, проверка занимает много времени.',
    proposal: 'Собрать библиотеку типовых узлов в формате блоков для САПР и обязательный чек-лист проверки.',
    categoryId: C.process,
    departmentId: D.design,
  });
  await wf.suggest(db, pnrHead, n7, {
    baseRevision: 1,
    title: 'Библиотека типовых узлов для проектов СКУД',
    problem: 'Одни и те же узлы (турникет, шлагбаум, точка доступа) каждый проектировщик рисует по-своему, проверка занимает много времени.',
    proposal: 'Собрать библиотеку типовых узлов для САПР, чек-лист проверки и добавить в каждый узел требования к пусконаладке.',
    rationale: 'На ПНР часто не хватает информации о питании и линиях связи в узле',
  });
  await comment(ops, n7, 'Поддерживаю, давайте сначала соберём 10 самых частых узлов.');
  age(n7, 3);

  // 8. Duplicate-looking problem → recurring cluster with #2.
  const n8 = await submit(buyer, {
    kind: 'problem',
    title: 'Терминалы сбора данных зависают при инвентаризации',
    problem: 'При инвентаризации ТСД зависают на больших стеллажах, пересчитываем вручную.',
    categoryId: C.it,
    departmentId: D.warehouse,
  });
  await comment(itLead, n8, 'Похоже на ту же причину, что в обращении #' + n2 + '. Включим эти терминалы в обновление.');
  // The Council discussed it and the IT lead handed it to the operations director for a decision.
  await council.addEntry(db, buyer, n8, { kind: 'argument_for', body: 'Инвентаризация склада идёт на два часа дольше из-за зависаний' });
  await council.addEntry(db, whHead, n8, { kind: 'argument_for', body: 'На приёмке та же беда, решать стоит вместе с обращением о ТСД при приёмке' });
  await council.addEntry(db, pnrHead, n8, { kind: 'argument_against', body: 'Сначала дождаться результата пилота прошивки на приёмке, иначе закупим лишнее' });
  await council.addEntry(db, svcHead, n8, {
    kind: 'recommendation',
    recommendation: 'pilot',
    body: 'Включить два терминала инвентаризации в текущий пилот прошивки и сравнить число зависаний',
  });
  await council.handoff(db, itLead, n8, { summary: 'За: два довода, против: один. Рекомендация Совета: пилот на двух терминалах.' });
  age(n8, 2);

  // 9. Safety: implemented by the service head.
  const n9 = await submit(engineer, {
    kind: 'problem',
    title: 'Не хватает касок и жилетов для выездов на стройку',
    problem: 'На стройплощадку не пускают без СИЗ, а в сервисе два комплекта на пятерых инженеров.',
    categoryId: C.safety,
    departmentId: D.service,
  });
  await wf.decide(db, svcHead, n9, { outcome: 'merge', rationale: 'Закупаем по комплекту на каждого инженера', implementer: svcHead.membershipId });
  await wf.completeImplementation(db, svcHead, n9, { report: 'Пять комплектов выданы под роспись' });
  age(n9, 20);

  // 10. Commissioning checklist: decided, in progress.
  const n10 = await submit(engineer, {
    kind: 'idea',
    title: 'Чек-лист пусконаладки пожарной сигнализации',
    problem: 'После ПНР заказчик находит мелкие недочёты, приходится выезжать повторно.',
    proposal: 'Единый чек-лист из 25 пунктов, который инженер заполняет на объекте и прикладывает к акту.',
    departmentId: D.pnr,
    categoryId: C.docs,
  });
  await wf.decide(db, pnrHead, n10, { outcome: 'merge', rationale: 'Повторные выезды стоят дороже, внедряем', implementer: engineer.membershipId });
  await progress(engineer, n10, 'Черновик чек-листа готов, проверяем на двух объектах');
  age(n10, 10);

  // 11. Arrived by e-mail, recorded by the admin; head of purchasing answered.
  const n11 = await submit(sysAdmin, {
    kind: 'problem',
    title: 'Счета поставщиков теряются в общей почте',
    problem: 'Счета приходят на общий ящик, часть пропускаем — были просрочки оплаты и штрафы.',
    categoryId: C.docs,
    departmentId: D.purchasing,
    sourceChannel: 'email',
    sourceNote: 'Письмо от отдела закупок',
    raisedBy: buyer.membershipId,
  });
  await comment(ops, n11, 'Предлагаю отдельный ящик для счетов и правило пересылки. Обсудим с ИТ.');
  age(n11, 6);

  // 12. Phone call recorded by the sales head (cannot lead it herself): unrouted, overdue.
  const n12 = await submit(salesHead, {
    kind: 'problem',
    title: 'Заказчик не получил акт пусконаладки вовремя',
    problem: 'Генподрядчик по телефону сообщил, что акт по объекту пришёл на неделю позже, это задержало их сдачу.',
    categoryId: C.clients,
    sourceChannel: 'phone',
    sourceNote: 'Звонок генподрядчика',
    raisedBy: pnrHead.membershipId,
  });
  age(n12, 3);

  // 13–15. Fresh items for volume.
  const n13 = await submit(manager, {
    kind: 'idea',
    title: 'Демо-стенд для показа заказчикам',
    problem: 'Заказчики хотят увидеть работу системы до покупки, а показать нам нечего, кроме презентации.',
    proposal: 'Собрать в офисе небольшой стенд: две камеры, контроллер доступа, датчик и пульт.',
    categoryId: C.clients,
    departmentId: D.sales,
  });
  await comment(salesHead, n13, 'Хорошая идея, посчитаем бюджет вместе с закупками.');
  age(n13, 1);
  await submit(engineer, {
    kind: 'problem',
    title: 'Пропуска на объекты оформляются в последний день',
    problem: 'Списки на пропуск отправляем заказчику накануне выезда, из-за этого дважды не попали на объект.',
    categoryId: C.process,
    departmentId: D.pnr,
  });
  await submit(designer, {
    kind: 'idea',
    title: 'Наставник для новых инженеров на первые три месяца',
    problem: 'Новые инженеры учатся сами, на это уходит до трёх месяцев, первые объекты делают с ошибками.',
    proposal: 'Закреплять за каждым новичком наставника и сделать план обучения по неделям.',
    categoryId: C.knowledge,
  });

  // 16. Forwarded from the warehouse WhatsApp chat by the head, credited to the storekeeper.
  const n16 = await submit(whHead, {
    kind: 'problem',
    title: 'На второй смене не хватает сканеров',
    problem: 'В чате склада написали: на второй смене два сканера на шесть человек, у стола приёмки очередь.',
    categoryId: C.it,
    departmentId: D.warehouse,
    sourceChannel: 'messenger',
    sourceNote: 'Чат «Склад» в WhatsApp',
    raisedBy: storekeeper.membershipId,
  });
  age(n16, 2);

  // ---- shift each item's history back in time, then run escalations -------
  await withAdminTx(db, async (c) => {
    await c.query(`SET LOCAL session_replication_role = replica`); // demo data only: skip triggers for the time shift
    for (const { n, days } of shifts) {
      // Spread the item's real history (milliseconds long) over its demo age:
      // t' = start + age·0.85·((t - p0) / real)², so first responses and decisions get
      // realistic gaps. Deadlines keep their SLA distance from publication.
      const id = (await c.query<{ id: string }>('SELECT id FROM ideas WHERE organization_id = $1 AND number = $2', [orgId, n])).rows[0]!.id;
      const span = await c.query<{ p0: Date; e: Date }>(
        `SELECT i.published_at AS p0, greatest(i.published_at + interval '1 millisecond',
                  (SELECT max(t) FROM (SELECT created_at t FROM reviews WHERE idea_id = i.id
                    UNION ALL SELECT resolved_at FROM reviews WHERE idea_id = i.id
                    UNION ALL SELECT created_at FROM decisions WHERE idea_id = i.id
                    UNION ALL SELECT completed_at FROM verifications WHERE idea_id = i.id) x)) AS e
           FROM ideas i WHERE i.id = $1`,
        [id],
      );
      const { p0, e } = span.rows[0]!;
      const start = new Date(Date.now() - days * 86400e3);
      // Activity fills ~85 % of the item's age; an item with no activity is only shifted.
      const real = (e.getTime() - p0.getTime()) / 1000;
      const target = real > 0.005 ? days * 86400 * 0.85 : 0;
      // Quadratic: early steps (first answer) stay hours after publication, later ones spread out.
      const f = (col: string) =>
        `${col} = CASE WHEN ${col} IS NULL THEN NULL ELSE $2::timestamptz + make_interval(secs => $4::float8 * power(least(1.0, greatest(0.0, extract(epoch FROM ${col} - $3::timestamptz)::float8 / $5::float8)), 2)) END`;
      const sh = (col: string) => `${col} = ${col} + ($2::timestamptz - $3::timestamptz)`;
      const args = [id, start, p0, target, Math.max(real, 0.001)];
      await c.query(
        `UPDATE ideas SET ${f('published_at')}, ${f('updated_at')}, ${sh('first_response_due_at')}, ${sh('resolution_due_at')},
                ${f('first_response_at')}, ${f('responsible_activity_at')} WHERE id = $1`,
        args,
      );
      for (const t of ['idea_revisions', 'reviews', 'decisions', 'contributions', 'notifications', 'attachments', 'xp_awards', 'effect_approvals', 'council_entries']) {
        await c.query(`UPDATE ${t} SET ${f('created_at')} WHERE idea_id = $1`, args);
      }
      await c.query(`UPDATE reviews SET ${f('resolved_at')} WHERE idea_id = $1 AND resolved_at IS NOT NULL`, args);
      await c.query(`UPDATE verifications SET ${f('created_at')}, ${f('started_at')}, ${f('completed_at')} WHERE idea_id = $1`, args);
      await c.query(
        `UPDATE verification_evidence e SET ${f('e.created_at').replace('e.created_at =', 'created_at =')}
           FROM verifications v WHERE v.id = e.verification_id AND v.idea_id = $1`,
        args,
      );
    }
  });
  const esc = await db.pool.query<{ n: number }>('SELECT escalate_overdue() AS n');

  // ---- questionnaires for MODUS ADVISOR (fictional, filled «by the people themselves») ----
  await saveMyProfile(db, itLead, { skills: ['Сканеры', 'Принтеры этикеток', 'Настройка ТСД', '1С склад'], preferences: 'Автоматизация рутинных операций', weeklyHours: 6 });
  await saveMyProfile(db, engineer, { skills: ['Сканеры', 'Ремонт оборудования', 'Принтеры'], preferences: 'Выездные работы, оборудование', weeklyHours: 3 });
  await saveMyProfile(db, storekeeper, { skills: ['Приёмка', 'Этикетки', 'Инвентаризация'], preferences: 'Утренние смены', weeklyHours: 2 });
  await saveMyProfile(db, designer, { skills: ['Чертежи', 'Спецификации'], weeklyHours: 0 });

  // ---- game titles (ADR-0014): decoration only, no rights; editable by the admin ----
  const guilds: [string, string[]][] = [
    [D.warehouse, ['Хранитель крепости', 'Мастер запасов', 'Смотритель']],
    [D.sales, ['Магистр торговли', 'Мастер переговоров', 'Посланник']],
    [D.it, ['Архимаг технологий', 'Архитектор систем', 'Мастер механизмов']],
    [D.service, ['Мастер-наладчик', 'Механик гильдии', 'Подмастерье']],
    [D.purchasing, ['Верховный казначей', 'Казначей', 'Хранитель бюджета']],
    [D.design, ['Главный зодчий', 'Зодчий', 'Чертёжник']],
    [D.pnr, ['Мастер пуска', 'Наладчик', 'Подмастерье']],
  ];
  for (const [d, titles] of guilds) await setGuildTitles(db, sysAdmin, d, { titles });
  await assignTitle(db, sysAdmin, owner.membershipId, { rank: 'king' });
  await assignTitle(db, sysAdmin, ops.membershipId, { rank: 'regent' });
  await assignTitle(db, sysAdmin, storekeeper.membershipId, { rank: 'guild', title: 'Мастер запасов' });

  // ---- forms of address chosen by the people themselves (fictional; never guessed from names) ----
  await savePreferences(db, whHead, { style: 'royal', addressForm: 'milord', groupRepeats: true, muted: [] });
  await savePreferences(db, salesHead, { style: 'royal', addressForm: 'milady', groupRepeats: true, muted: [] });

  // ---- a council meeting called in advance; each participant gave consent themselves (fictional) ----
  const planerka = (
    await createMeeting(db, whHead, {
      title: 'Планёрка склада: приёмка и этикетки',
      departmentId: D.warehouse,
      participants: [storekeeper.membershipId, engineer.membershipId, itLead.membershipId],
      organizerConsent: true,
    })
  ).body.id;
  for (const p of [storekeeper, engineer, itLead]) await setConsent(db, p, planerka, 'given');

  // ---- «Наследие Королевства» (ADR-0017): the archivist role is granted by the admin; two real entries ----
  await legacy.setArchivist(db, sysAdmin, archivistBase.membershipId, true);
  const archivist: Person = { ...archivistBase, roles: ['employee', 'archivist'] };
  const zones = await legacy.register(db, whHead, {
    kind: 'improvement',
    title: 'Цветная разметка зон приёмки и отгрузки',
    card: {
      problem: 'Новые сотрудники и водители путали зоны приёмки и отгрузки; коробки разных заказов перемешивались — около шести пересортов в месяц.',
      options: 'Таблички без разметки; цветная разметка пола и таблички; отдельный сотрудник-распределитель у ворот.',
      argumentsFor: 'Дёшево (около 20 литров краски), делается за одну субботу, понятно без обучения.',
      argumentsAgainst: 'Разметка стирается под погрузчиками — нужно обновлять раз в полгода.',
      decision: 'Три зоны с цветной разметкой: приёмка у ворот №1, контроль качества в центре, отгрузка у ворот №2, таблички над каждой зоной.',
      reasons: 'Самый дешёвый вариант, который убирает путаницу без дополнительных людей.',
      initiator: storekeeper.membershipId,
      responsible: [whHead.membershipId, storekeeper.membershipId],
      actions: [{ what: 'Нанести разметку и повесить таблички', due: '2026-10-18' }],
      results: 'За месяц после разметки пересортов не было (до этого шесть в месяц) — по акту инвентаризации.',
      positive: 'Новые сотрудники ориентируются с первого дня.',
      negative: 'Через два месяца разметка у ворот №1 стёрлась — обновление нужно внести в план работ.',
    },
    sources: [{ type: 'idea', number: n1 }],
    reason: 'Итог внедрения на складе',
  });
  await legacy.act(db, whHead, zones.id, { action: 'library_proposed', reason: 'Решение внедрено, эффект подтверждён актом' });
  await legacy.act(db, archivist, zones.id, { action: 'library_accepted', reason: 'Проверила отчёт о внедрении и акт инвентаризации' });
  await legacy.register(db, svcHead, {
    kind: 'problem',
    title: 'Нехватка СИЗ для выездов на стройку',
    card: {
      problem: 'На стройплощадку не пускают без касок и жилетов, а в сервисе было два комплекта на пятерых инженеров.',
      decision: 'Закупить по комплекту на каждого инженера.',
      results: 'Пять комплектов выданы под роспись.',
    },
    sources: [{ type: 'idea', number: n9 }],
    reason: 'Записано по итогам решения',
  });

  const personas = [owner, ops, whHead, salesHead, itLead, storekeeper, engineer, archivistBase, sysAdmin].map((p) => ({
    userId: p.userId,
    name: p.name,
    title: p.title,
    department: p.department,
    hint: p.persona ?? p.title,
  }));
  await mkdir(dirname(personasPath), { recursive: true });
  await writeFile(personasPath, JSON.stringify({ organization: ORG_SLUG, organizationName: ORG_NAME, personas }, null, 2));
  console.log(JSON.stringify({ organization: ORG_SLUG, items: k, escalations: esc.rows[0]!.n, personas: personasPath }));
}

// 1×1 transparent PNG (valid signature) used as a stand-in photo.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

try {
  await main();
} finally {
  await db.close();
}
