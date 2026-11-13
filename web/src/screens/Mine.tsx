import { api, qs } from '../lib/api';
import { useLoad, useSession } from '../lib/session';
import { STATUS } from '../lib/status';
import type { ListItem } from '../lib/types';
import { ErrorBox, ItemList, Loading } from '../components/ui';
import { HowItWorks } from '../components/HowItWorks';
import { ExperienceHero, MetricStrip } from '../components/Experience';
import { Icon } from '../components/icons';

/** «Мои обращения»: what I raised, what stage it is at, what is waiting for me. */
export function Mine() {
  const s = useSession();
  const { data, error, loading, reload } = useLoad(() => api<ListItem[]>(`/orgs/${s.org}/ideas${qs({ mine: true, limit: 200 })}`), [s.org]);
  const items = data ?? [];
  const waiting = items.filter((i) => i.status === 'needs_info');
  const open = items.filter((i) => STATUS[i.status].open);
  const done = items.filter((i) => !STATUS[i.status].open);

  return (
    <div className="stack-lg">
      <ExperienceHero
        eyebrow="Ваш голос в Содружестве"
        icon="scroll"
        title="Мои обращения"
        description="Большие перемены начинаются с вашей идеи. Следите за её путём — от первого слова до воплощения."
      >
        <a className="btn primary" href="#/new">
          <Icon name="plus" /> Подать обращение
        </a>
        <a className="hero-link" href="#/kingdom">В город <Icon name="arrow" /></a>
      </ExperienceHero>
      <MetricStrip items={[
        { label: 'В работе', value: data ? open.length : '—', icon: 'scroll' },
        { label: 'Нужен ваш ответ', value: data ? waiting.length : '—', icon: 'hourglass' },
        { label: 'Завершено', value: data ? done.length : '—', icon: 'shield' },
      ]} />
      <HowItWorks />
      {error ? <ErrorBox error={error} retry={() => void reload()} /> : null}
      {loading && !data ? <Loading /> : null}
      {waiting.map((i) => (
        <a key={i.number} className="notice warn callout" href={`#/items/${i.number}`}>
          <b>Нужен ваш ответ.</b> {i.maintainer ?? 'Ответственный'} задал вопрос по обращению №{i.number} «{i.title}».
        </a>
      ))}
      {data && (
        <>
          <section className="stack">
            <h2 className="section-title">В работе ({open.length})</h2>
            <ItemList
              items={open}
              showAuthor={false}
              empty={
                <>
                  <p>Открытых обращений нет.</p>
                  <p className="small">Заметили проблему или знаете, как сделать лучше? Опишите своими словами — ответственный и срок назначатся сразу.</p>
                  <a className="btn primary" href="#/new">
                    Подать обращение
                  </a>
                </>
              }
            />
          </section>
          {done.length > 0 && (
            <section className="stack">
              <h2 className="section-title">Завершённые ({done.length})</h2>
              <ItemList items={done} showAuthor={false} empty={null} />
            </section>
          )}
        </>
      )}
    </div>
  );
}
