import { useState } from 'react';
import { date } from '../lib/format';

/**
 * «Путь решения» (ADR-0040): how a person's experience became the organization's knowledge.
 * Everything here is what the server assembled from recorded facts for THIS reader: the component
 * adds nothing, counts nothing and hides nothing — a failed proposal is drawn next to the successful
 * one, a source closed to the reader is a closed branch.
 *
 * One markup for every screen: branches are columns on a wide screen and a sequence of cards on a
 * phone (CSS only). Ordered lists carry the order to a screen reader; the tone of a status is always
 * written in words, never by colour alone.
 */
type Tone = 'ok' | 'no' | 'wait' | 'info';
export interface PathNode {
  type: string;
  kind: string;
  title: string;
  detail: string | null;
  at: string | null;
  status: { tone: Tone; label: string };
  source: string;
  link: string | null;
}
export interface PathBranch {
  source: { type: string; label: string; link: string | null; available: boolean };
  outcome: { tone: Tone; label: string };
  nodes: PathNode[];
  folded: number;
}
export interface PathUse {
  number: number;
  title: string;
  link: string;
  started: boolean;
  startedAt: string | null;
  recorded: boolean;
  status: { tone: Tone; label: string };
}
export interface SolutionPathData {
  branches: PathBranch[];
  foldedBranches: number;
  trunk: PathNode[];
  foldedTrunk: number;
  uses: PathUse[];
  foldedUses: number;
  note: string;
}

const GLYPH: Record<string, string> = {
  item: 'M5 4h14v12H9l-4 4z',
  council: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 4v4l3 2',
  meeting: 'M4 7h16v10H4zM8 7V4m8 3V4',
  finding: 'M11 4a7 7 0 1 0 4.4 12.5L20 21',
  decision: 'M5 12l4 4 10-10',
  verification: 'M9 3h6v5l4 10a2 2 0 0 1-2 3H7a2 2 0 0 1-2-3l4-10z',
  implementation: 'M4 20h16M6 20V9l6-5 6 5v11',
  effect: 'M4 18l5-6 4 3 7-9',
  knowledge: 'M6 4h11a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2z',
  library: 'M4 20V6l8-3 8 3v14M9 20v-7h6v7',
  application: 'M4 12a8 8 0 0 1 14-5m2-3v5h-5M20 12a8 8 0 0 1-14 5m-2 3v-5h5',
};

function Node({ n }: { n: PathNode }) {
  return (
    <li className="sp-node" data-tone={n.status.tone} data-type={n.type}>
      <span className="sp-dot" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16" focusable="false">
          <path d={GLYPH[n.type] ?? GLYPH.item} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <div className="sp-card">
        <p className="sp-kind">{n.kind}</p>
        <p className="sp-title">{n.link ? <a href={n.link}>{n.title}</a> : n.title}</p>
        {n.detail ? <p className="sp-detail">{n.detail}</p> : null}
        <p className="sp-foot">
          <span className="sp-status" data-tone={n.status.tone}>
            {n.status.label}
          </span>
          {n.at ? <time dateTime={n.at}>{date(n.at)}</time> : <span>дата не записана</span>}
          <span className="sp-source">Источник: {n.source}</span>
        </p>
      </div>
    </li>
  );
}

export function SolutionPath({ path, historyId }: { path: SolutionPathData; historyId: string }) {
  // Details are folded by default on a long path: the outline first, the events on request.
  const long = path.branches.reduce((n, b) => n + b.nodes.length, 0) > 12;
  const [open, setOpen] = useState(!long);
  const folded = path.branches.reduce((n, b) => n + b.folded, 0) + path.foldedTrunk;
  if (!path.branches.length && !path.trunk.length) return null;
  return (
    <section className="sp" aria-labelledby="sp-h">
      <header className="sp-head">
        <h2 className="gc-h" id="sp-h">
          Путь решения
        </h2>
        <p className="sp-lead">Как этот опыт стал знанием: от обращений и обсуждения до решения, проверки и Библиотеки.</p>
        {long ? (
          <button type="button" className="btn quiet small" aria-expanded={open} aria-controls="sp-body" onClick={() => setOpen((v) => !v)}>
            {open ? 'Свернуть события' : 'Раскрыть события'}
          </button>
        ) : null}
      </header>

      <div id="sp-body" className="sp-branches" data-count={Math.min(path.branches.length, 3)} data-open={open ? 'yes' : 'no'}>
        {path.branches.map((b, i) => (
          <article key={i} className="sp-branch" data-available={b.source.available ? 'yes' : 'no'} aria-label={`Источник ${i + 1} из ${path.branches.length}: ${b.source.label}. Итог: ${b.outcome.label}`}>
            <header className="sp-branch-head">
              <p className="sp-branch-no">Источник {i + 1}</p>
              <p className="sp-branch-name">{b.source.link ? <a href={b.source.link}>{b.source.label}</a> : b.source.label}</p>
              <p className="sp-status" data-tone={b.outcome.tone}>
                Итог: {b.outcome.label}
              </p>
            </header>
            {b.source.available ? (
              open ? (
                <ol className="sp-nodes">
                  {b.nodes.map((n, j) => (
                    <Node key={j} n={n} />
                  ))}
                </ol>
              ) : (
                <p className="sp-fold">Событий: {b.nodes.length + b.folded}</p>
              )
            ) : (
              <p className="sp-closed">Этот источник закрыт для вас: его название и события здесь не показываются.</p>
            )}
            {open && b.folded ? (
              <p className="sp-fold">
                Ещё событий в этой ветви: {b.folded} — в <a href={`#${historyId}`}>истории изменений</a>.
              </p>
            ) : null}
          </article>
        ))}
      </div>
      {path.foldedBranches ? <p className="sp-fold">Ещё источников: {path.foldedBranches} — полный список в разделе «Доказательства и источники».</p> : null}

      {path.trunk.length ? (
        <div className="sp-trunk">
          <p className="sp-join" aria-hidden="true" />
          <h3 className="sp-sub">Что стало с этим знанием</h3>
          <ol className="sp-nodes">
            {path.trunk.map((n, j) => (
              <Node key={j} n={n} />
            ))}
          </ol>
        </div>
      ) : null}
      <p className="sp-note">
        {path.note}
        {folded ? ` Свернуто событий: ${folded}.` : ''}
      </p>
    </section>
  );
}

/** Items started from this knowledge and its recorded re-applications — with what is actually known about each. */
export function MethodUses({ uses, folded }: { uses: PathUse[]; folded: number }) {
  if (!uses.length) return <p className="gc-none">На основе этого знания обращений пока не создавали.</p>;
  return (
    <>
      <ul className="plain k-list sp-uses">
        {uses.map((u) => (
          <li key={u.number}>
            <a href={u.link}>
              №{u.number} «{u.title}»
            </a>
            <div className="sp-use-foot">
              <span className="sp-status" data-tone={u.status.tone}>
                {u.status.label}
              </span>
              <span className="xs muted">
                {u.started ? `начато автором на основе метода${u.startedAt ? `, ${date(u.startedAt)}` : ''}` : 'записано как повторное применение'}
                {u.started && u.recorded ? '; повторное применение записано' : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {folded ? <p className="sp-fold">Ещё обращений: {folded}.</p> : null}
    </>
  );
}
