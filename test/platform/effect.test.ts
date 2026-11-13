import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectLines, effectMeasured, effectSentences, type Measurement } from '../../platform/domain/effect.ts';

/** Measured effect (ADR-0031): the rules that keep a missing or incomparable measurement from looking like a result. */
let n = 0;
const m = (kind: 'baseline' | 'result' | 'reference', metric: string | null, value: number | null, unit: string | null, extra: Partial<Measurement> = {}): Measurement => ({
  id: `e${++n}`,
  kind,
  metric,
  value,
  unit,
  period: null,
  source: null,
  goal: null,
  comparable: null,
  createdAt: new Date(Date.UTC(2026, 10, 1, 9, n)).toISOString(),
  ...extra,
});

test('no measurements, only a «before» or only an «after»: not measured, never zero', () => {
  assert.deepEqual(effectLines([]), []);
  assert.equal(effectMeasured([]), false);
  const before = effectLines([m('baseline', 'Время пусконаладки', 95, 'мин', { goal: 'decrease' })]);
  assert.deepEqual([before[0]!.state, before[0]!.reason, before[0]!.delta, before[0]!.percent, before[0]!.verdict], ['not_measured', 'no_result', null, null, null]);
  const after = effectLines([m('result', 'Время пусконаладки', 70, 'мин', { comparable: true })]);
  assert.deepEqual([after[0]!.state, after[0]!.reason, after[0]!.delta], ['not_measured', 'no_baseline', null]);
  assert.equal(effectMeasured([...before, ...after]), false);
  // An observation without a number is not a measurement.
  assert.deepEqual(effectLines([m('baseline', 'Время', null, 'мин'), m('reference', null, null, null)]), []);
});

test('different units or conditions not stated as comparable: no difference and no percent', () => {
  const units = effectLines([m('baseline', 'Время пусконаладки', 95, 'мин', { goal: 'decrease' }), m('result', 'время  ПУСКОНАЛАДКИ ', 1.2, 'ч', { comparable: true })]);
  assert.equal(units.length, 1, 'the same metric is matched without regard to case and spacing');
  assert.deepEqual([units[0]!.state, units[0]!.reason, units[0]!.delta, units[0]!.percent, units[0]!.verdict], ['incomparable', 'units', null, null, null]);
  for (const comparable of [null, false]) {
    const cond = effectLines([m('baseline', 'Повторные выезды', 6, 'шт'), m('result', 'Повторные выезды', 2, 'шт', { comparable })]);
    assert.deepEqual([cond[0]!.state, cond[0]!.reason, cond[0]!.delta, cond[0]!.percent], ['incomparable', 'conditions', null, null]);
    assert.equal(effectMeasured(cond), false);
    assert.deepEqual(effectSentences(cond), [], 'nothing unmeasured is carried into the knowledge draft');
  }
});

test('a comparable pair: difference, percent and a verdict only when the direction is named', () => {
  const [down] = effectLines([m('baseline', 'Время пусконаладки', 96, 'мин', { goal: 'decrease' }), m('result', 'Время пусконаладки', 72, 'мин', { comparable: true })]);
  assert.deepEqual([down!.state, down!.delta, down!.percent, down!.verdict], ['measured', -24, -25, 'improved']);
  const [worse] = effectLines([m('baseline', 'Ошибки', 4, 'шт', { goal: 'decrease' }), m('result', 'Ошибки', 5, 'шт', { comparable: true })]);
  assert.deepEqual([worse!.delta, worse!.percent, worse!.verdict], [1, 25, 'worsened']);
  const [up] = effectLines([m('baseline', 'Сдано с первого раза', 10, 'объектов', { goal: 'increase' }), m('result', 'Сдано с первого раза', 13, 'объектов', { comparable: true })]);
  assert.deepEqual([up!.delta, up!.percent, up!.verdict], [3, 30, 'improved']);
  const [plain] = effectLines([m('baseline', 'Заявки', 10, 'шт'), m('result', 'Заявки', 12, 'шт', { comparable: true })]);
  assert.equal(plain!.verdict, 'changed', 'without a named direction the change is not called an improvement');
  const [zero] = effectLines([m('baseline', 'Простои', 0, 'ч', { goal: 'decrease' }), m('result', 'Простои', 2, 'ч', { comparable: true })]);
  assert.deepEqual([zero!.delta, zero!.percent], [2, null], 'no percent of a zero baseline');
  const [same] = effectLines([m('baseline', 'Ожидание', 30, 'мин', { goal: 'decrease' }), m('result', 'Ожидание', 30, 'мин', { comparable: true })]);
  assert.equal(same!.verdict, 'unchanged');
});

test('metrics are never summed: lower costs and higher revenue stay two separate lines', () => {
  const lines = effectLines([
    m('baseline', 'Затраты на выезды', 400000, 'тенге', { goal: 'decrease' }),
    m('baseline', 'Выручка сервиса', 900000, 'тенге', { goal: 'increase' }),
    m('result', 'Затраты на выезды', 300000, 'тенге', { comparable: true }),
    m('result', 'Выручка сервиса', 990000, 'тенге', { comparable: true }),
  ]);
  assert.deepEqual(lines.map((l) => [l.metric, l.delta, l.percent, l.verdict]), [
    ['Затраты на выезды', -100000, -25, 'improved'],
    ['Выручка сервиса', 90000, 10, 'improved'],
  ]);
  assert.equal(Object.keys(lines[0]!).includes('total'), false);
  assert.equal(effectSentences(lines).length, 2);
});

test('the latest baseline and the latest result after it are compared; an older result is not', () => {
  const lines = effectLines([
    m('result', 'Время', 50, 'мин', { comparable: true }),
    m('baseline', 'Время', 90, 'мин', { goal: 'decrease' }),
  ]);
  assert.deepEqual([lines[0]!.state, lines[0]!.reason], ['not_measured', 'no_result'], 'a result recorded before the baseline is not its «after»');
  const again = effectLines([
    m('baseline', 'Время', 90, 'мин', { goal: 'decrease' }),
    m('result', 'Время', 80, 'мин', { comparable: true }),
    m('result', 'Время', 60, 'мин', { comparable: true }),
  ]);
  assert.equal(again[0]!.after!.value, 60);
  assert.match(effectSentences(again)[0]!, /^Время: было 90 мин, стало 60 мин \(−33,3%\)/);
});
