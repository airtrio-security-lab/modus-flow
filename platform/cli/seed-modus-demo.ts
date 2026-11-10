import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createDatabase, withAdminTx, type Database } from '../db/pool.ts';
import { migrate } from '../db/migrate.ts';
import type { OrgActor, OrgRole } from '../domain/model.ts';
import * as admin from '../modules/admin.ts';
import { submitItem, type SubmitInputT } from '../modules/intake.ts';
import * as wf from '../modules/workflow.ts';
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

  // ---- shift each item's history back in time, then run escalations -------
  await withAdminTx(db, async (c) => {
    await c.query(`SET LOCAL session_replication_role = replica`); // demo data only: skip triggers for the time shift
    for (const { n, days } of shifts) {
      const interval = `${days} days`;
      const id = (await c.query<{ id: string }>('SELECT id FROM ideas WHERE organization_id = $1 AND number = $2', [orgId, n])).rows[0]!.id;
      await c.query(
        `UPDATE ideas SET published_at = published_at - $2::interval, updated_at = updated_at - $2::interval,
                first_response_due_at = first_response_due_at - $2::interval, resolution_due_at = resolution_due_at - $2::interval,
                first_response_at = first_response_at - $2::interval,
                responsible_activity_at = responsible_activity_at - $2::interval WHERE id = $1`,
        [id, interval],
      );
      for (const t of ['idea_revisions', 'reviews', 'decisions', 'contributions', 'notifications', 'attachments']) {
        await c.query(`UPDATE ${t} SET created_at = created_at - $2::interval WHERE idea_id = $1`, [id, interval]);
      }
      await c.query(`UPDATE reviews SET resolved_at = resolved_at - $2::interval WHERE idea_id = $1 AND resolved_at IS NOT NULL`, [id, interval]);
      await c.query(
        `UPDATE verifications SET created_at = created_at - $2::interval, started_at = started_at - $2::interval,
                completed_at = completed_at - $2::interval WHERE idea_id = $1`,
        [id, interval],
      );
      await c.query(
        `UPDATE verification_evidence e SET created_at = e.created_at - $2::interval
           FROM verifications v WHERE v.id = e.verification_id AND v.idea_id = $1`,
        [id, interval],
      );
    }
  });
  const esc = await db.pool.query<{ n: number }>('SELECT escalate_overdue() AS n');

  const personas = [owner, ops, whHead, itLead, storekeeper, engineer, sysAdmin].map((p) => ({
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
