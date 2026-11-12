import { date } from '../lib/format';
import { outfit, outfitWords } from '../lib/envoy-outfits';
import type { EnvoyCard } from '../lib/types';
import { StatusChip } from './ui';
import { EnvoyPortrait } from './EnvoyFigure';
import { roman } from './EnvoyRankUp';

/**
 * «Мой посол» / «Посол» on the person card (ADR-0032). Everything here is computed by the server from
 * confirmed events; every line of XP names its basis and links to the item. No invented achievements:
 * with no awards the envoy is «Гонец» and the history says so.
 */
export function EnvoySection({ e }: { e: EnvoyCard }) {
  const o = outfit(e.civilization, e.rank);
  const toNext = e.next === null ? null : e.next - e.xp;
  return (
    <div className="envoy-card">
      <div className="envoy-card-head">
        <EnvoyPortrait civ={e.civilization} rank={e.rank} size={156} label={`Посол ранга ${e.name}, одеяние: ${outfitWords(o)}`} walking />
        <div className="stack-sm">
          <p className="envoy-rank-line">
            <span className="envoy-rank-num">{roman(e.rank)}</span> <b>{e.name}</b>
          </p>
          <p className="small muted">
            {e.civilizationName}: {outfitWords(o)}
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
        </div>
      </div>

      <ol className="envoy-ladder" aria-label="Семь рангов посла">
        {e.ranks.map((r) => {
          const reached = r.rank <= e.rank;
          return (
            <li key={r.rank} className={`${reached ? 'is-reached' : ''}${r.rank === e.rank ? ' is-current' : ''}`} aria-current={r.rank === e.rank ? 'step' : undefined}>
              <EnvoyPortrait civ={e.civilization} rank={r.rank} size={64} />
              <span className="small">
                <b>
                  {roman(r.rank)} · {r.name}
                </b>
                <span className="muted tnum"> от {r.xp} XP</span>
              </span>
              <span className="small muted">
                {r.rank === 1 ? 'с начала пути' : r.reachedAt ? `с ${date(r.reachedAt)}${r.number ? `, обращение №${r.number}` : ''}` : 'ещё впереди'}
              </span>
            </li>
          );
        })}
      </ol>

      <h3 className="realm-sub-h">История подтверждённых начислений</h3>
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
        <p className="muted">Начислений пока нет: посол начинает путь Гонцом. Опыт приходит только с подтверждённым результатом.</p>
      )}

      <h3 className="realm-sub-h">Обращения посла</h3>
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
          <li>Одно обращение приносит каждое начисление один раз и одному человеку — тому, чей это вопрос.</li>
          <li>Смена стиля подразделения меняет одеяние, но не опыт и не ранг.</li>
        </ul>
      </details>
      <p className="small muted">Ранг посла отражает подтверждённый вклад и не даёт права решать, утверждать, созывать Совет или видеть больше данных.</p>
    </div>
  );
}
