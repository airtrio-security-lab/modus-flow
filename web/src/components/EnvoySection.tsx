import { useState } from 'react';
import { date } from '../lib/format';
import type { EnvoyCard } from '../lib/types';
import { StatusChip } from './ui';
import { EnvoyAvatar, avatarWords } from './EnvoyAvatar';
import { roman } from './EnvoyRankUp';

/**
 * «Мой посол» / «Посол» on the person card (ADR-0032, ADR-0036). One person — one envoy: the rank and
 * the attire are those of the person, the same on every item on the map. Everything is computed by the
 * server from confirmed events; every line names its basis and links to the item. Looking at the seven
 * stages opens nothing and awards nothing: future stages stay «ещё не достигнут».
 */
const KIND_WORDS = { implementation: 'внедрение подтверждено', effect: 'эффект измерен и одобрен', resolution: 'проблема решена' } as const;

export function EnvoySection({ e }: { e: EnvoyCard }) {
  const [stages, setStages] = useState(false);
  const toNext = e.next === null ? null : e.next - e.xp;
  // Featured merits: the items that brought the most confirmed XP, with what exactly was confirmed.
  const byItem = new Map<number, { title: string | null; xp: number; kinds: Set<keyof typeof KIND_WORDS> }>();
  for (const h of e.history) {
    if (h.number === null) continue;
    const x = byItem.get(h.number) ?? { title: h.title, xp: 0, kinds: new Set() };
    x.xp += h.xp;
    x.kinds.add(h.kind);
    byItem.set(h.number, x);
  }
  const featured = [...byItem.entries()].sort((a, b) => b[1].xp - a[1].xp || b[0] - a[0]).slice(0, 3);
  const reached = e.ranks.filter((r) => r.rank > 1 && r.reachedAt);
  return (
    <div className="envoy-card">
      <div className="envoy-card-head">
        <div className="envoy-hero">
          <EnvoyAvatar civ={e.civilization} rank={e.rank} variant="profile" size={230} label={avatarWords(e.civilization, e.rank)} />
        </div>
        <div className="stack-sm">
          <p className="envoy-rank-line">
            <span className="envoy-rank-num">{roman(e.rank)}</span> <b>{e.name}</b>
          </p>
          <p className="small muted">
            {e.civilizationName}: {e.attire.toLowerCase()}. Одеяние — по стилю подразделения{e.department ? ` «${e.department}»` : ''}; при переводе меняется одежда, опыт и ранг сохраняются.
          </p>
          <dl className="envoy-facts">
            <div>
              <dt>Опыт посла</dt>
              <dd className="tnum">{e.xp} XP</dd>
            </div>
            <div>
              <dt>Внедрено</dt>
              <dd className="tnum">{e.results.implemented}</dd>
            </div>
            <div>
              <dt>Измеренный эффект</dt>
              <dd className="tnum">{e.results.effects}</dd>
            </div>
          </dl>
          <div className="envoy-progress">
            <progress max={1} value={e.progress} aria-label={e.nextName ? `Прогресс до ранга «${e.nextName}»` : 'Высший ранг'} />
            <span className="small muted tnum">
              {e.nextName ? `До ранга «${e.nextName}»: ${toNext} XP (${e.xp} из ${e.next})` : 'Высший ранг. Опыт продолжает учитываться, ранг выше VII не растёт.'}
            </span>
          </div>
          <button type="button" className="btn small" aria-expanded={stages} aria-controls="envoy-stages" onClick={() => setStages((v) => !v)}>
            {stages ? 'Скрыть развитие посла' : 'Показать развитие посла'}
          </button>
        </div>
      </div>

      {stages ? (
        <div id="envoy-stages" className="stack-sm">
          <ol className="envoy-ladder" aria-label="Семь рангов посла">
            {e.ranks.map((r) => {
              const got = r.rank <= e.rank;
              return (
                <li key={r.rank} className={`${got ? 'is-reached' : 'is-locked'}${r.rank === e.rank ? ' is-current' : ''}`} aria-current={r.rank === e.rank ? 'step' : undefined}>
                  <EnvoyAvatar civ={e.civilization} rank={r.rank} variant="profile" size={84} />
                  <span className="small">
                    <b>
                      {roman(r.rank)} · {r.name}
                    </b>
                    <span className="muted tnum"> от {r.xp} XP</span>
                  </span>
                  <span className="small muted">
                    {r.rank === 1 ? 'с начала пути' : got && r.reachedAt ? `с ${date(r.reachedAt)}${r.number ? `, обращение №${r.number}` : ''}` : got ? 'достигнут' : '🔒 ещё не достигнут'}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="small muted">Просмотр ступеней ничего не открывает и не начисляет: ранг растёт только от подтверждённых результатов.</p>
        </div>
      ) : null}

      <h3 className="realm-sub-h">Избранные заслуги</h3>
      {featured.length ? (
        <ul className="envoy-merits">
          {featured.map(([n, x]) => (
            <li key={n}>
              <a href={`#/items/${n}`}>
                <span className="num">№{n}</span> {x.title ?? 'обращение'}
              </a>
              <span className="small muted">
                {[...x.kinds].map((k) => KIND_WORDS[k]).join(' · ')} — <span className="tnum">+{x.xp} XP</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Подтверждённых заслуг пока нет: посол начинает путь Гонцом.</p>
      )}

      <h3 className="realm-sub-h">История достижений</h3>
      {reached.length ? (
        <ul className="district-list">
          {reached.map((r) => (
            <li key={r.rank}>
              <span>
                Ранг {roman(r.rank)} — {r.name}
                {r.number ? (
                  <>
                    {' '}
                    за обращение <a href={`#/items/${r.number}`}>№{r.number}</a>
                  </>
                ) : null}
              </span>
              <span className="small muted">{date(r.reachedAt!)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Повышений пока не было.</p>
      )}

      <h3 className="realm-sub-h">Основания начислений</h3>
      {e.history.length ? (
        <ul className="district-list">
          {e.history.map((h) => (
            <li key={h.id}>
              {h.number !== null ? <a href={`#/items/${h.number}`}>{h.text}</a> : <span>{h.text}</span>}
              <span className="small muted">{date(h.at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Начислений пока нет. Опыт приходит только с подтверждённым результатом.</p>
      )}

      <h3 className="realm-sub-h">Послания этого посла</h3>
      {e.items.length ? (
        <ul className="district-list">
          {e.items.map((i) => (
            <li key={i.number}>
              <a href={`#/items/${i.number}`}>
                <span className="num">№{i.number}</span> {i.title}
              </a>
              <span className="row-tight">
                <StatusChip status={i.status} />
                {i.xp ? <span className="small muted tnum">послу +{i.xp} XP</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Обращений пока нет.</p>
      )}

      <details className="envoy-rules">
        <summary>Как растёт посол</summary>
        <ul className="plain small">
          {e.rules.map((r) => (
            <li key={r.kind}>
              {r.enabled ? `+${r.xp} XP — ${r.label}` : `${r.label} — пока не начисляется: в процессе нет отдельного проверяемого события, ждём решения владельца`}
            </li>
          ))}
          <li>0 XP — {e.noXp.join(', ')}.</li>
          <li>Один сотрудник — один посол: все его обращения на карте несут один и тот же ранг и одно одеяние.</li>
          <li>Одно обращение приносит каждое начисление один раз и одному человеку — тому, чей это вопрос.</li>
        </ul>
      </details>
      <p className="small muted">Ранг посла отражает подтверждённый вклад и не даёт права решать, утверждать, созывать Совет или видеть больше данных.</p>
    </div>
  );
}
