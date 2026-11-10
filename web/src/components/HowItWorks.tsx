import { useState } from 'react';

/**
 * Five steps that answer, without instructions, where to submit, where the
 * status is, where it is discussed, who decides and what moves the castle.
 * The person may hide it; the choice is kept on this device.
 */
const KEY = 'modus.howto.hidden';

const STEPS = [
  { title: 'Подайте обращение', text: 'Кнопка «Подать обращение» — проблема или идея своими словами.', href: '#/new', link: 'Подать' },
  { title: 'Следите за статусом', text: 'Раздел «Обращения»: этап, ответственный и срок ответа.', href: '#/', link: 'Мои обращения' },
  { title: 'Обсуждение — в Совете', text: 'За круглым столом коллеги дают аргументы и рекомендации.', href: '#/council', link: 'Совет' },
  { title: 'Решает ответственный', text: 'Его имя — в карточке и в Совете. Рекомендации не заменяют решение.', href: null, link: null },
  { title: 'Внедрение растит замок', text: 'Подтверждённое внедрение даёт подразделению опыт и новый уровень.', href: '#/kingdom', link: 'Королевство' },
];

export function HowItWorks() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = (v: boolean) => {
    setHidden(v);
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      /* not kept */
    }
  };
  if (hidden)
    return (
      <button type="button" className="btn small quiet howto-show" onClick={() => toggle(false)}>
        Как это работает
      </button>
    );
  return (
    <section className="howto" aria-labelledby="howto-title">
      <div className="howto-head">
        <h2 id="howto-title">Как это работает</h2>
        <button type="button" className="btn small quiet" onClick={() => toggle(true)}>
          Скрыть
        </button>
      </div>
      <ol>
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="howto-n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="howto-body">
              <b>{s.title}</b>
              <span>{s.text}</span>
              {s.href ? <a href={s.href}>{s.link}</a> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
