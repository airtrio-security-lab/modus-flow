import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advisorStatus } from '../../platform/modules/advisor.ts';
import { isRemote, modelConfigFromEnv, modelFetch, modelLabel, modelReachable, type ModelConfig } from '../../platform/modules/advisor-model.ts';

/**
 * Cloud language models (ADR-0028). They are paid and the text leaves the company, so they start only
 * behind explicit switches; the key is never shown; every provider is spoken to through one adapter,
 * so the checks after the call are the same for a local and a cloud model.
 */
const KEY = 'sk-test-0000';
const demo = { MODUS_DEMO_LOGIN: 'true' };

test('a cloud model starts only with explicit consent; real data needs a second, separate consent', () => {
  assert.equal(modelConfigFromEnv({}), null);
  assert.equal(modelConfigFromEnv({ MODUS_ADVISOR_PROVIDER: 'none', ANTHROPIC_API_KEY: KEY }), null, 'a key alone connects nothing');
  for (const provider of ['anthropic', 'openai']) {
    const key = provider === 'openai' ? { OPENAI_API_KEY: KEY } : { ANTHROPIC_API_KEY: KEY };
    const base = { MODUS_ADVISOR_PROVIDER: provider, MODUS_ADVISOR_MODEL: 'some-model', ...key };
    assert.throws(() => modelConfigFromEnv({ ...base, ...demo }), /MODUS_ADVISOR_ALLOW_REMOTE=true/, 'no silent sending outside');
    assert.throws(() => modelConfigFromEnv({ ...base, MODUS_ADVISOR_ALLOW_REMOTE: 'true' }), /MODUS_ADVISOR_ALLOW_REAL_DATA=true/, 'outside the demo real data would leave');
    assert.throws(() => modelConfigFromEnv({ MODUS_ADVISOR_PROVIDER: provider, MODUS_ADVISOR_MODEL: 'm', MODUS_ADVISOR_ALLOW_REMOTE: 'true', ...demo }), /не задан ключ/);
    assert.throws(() => modelConfigFromEnv({ MODUS_ADVISOR_PROVIDER: provider, MODUS_ADVISOR_ALLOW_REMOTE: 'true', ...demo, ...key }), /MODUS_ADVISOR_MODEL/);
    assert.throws(() => modelConfigFromEnv({ ...base, MODUS_ADVISOR_ALLOW_REMOTE: 'true', ...demo, MODUS_ADVISOR_URL: 'http://example.org' }), /https/);
    const cfg = modelConfigFromEnv({ ...base, MODUS_ADVISOR_ALLOW_REMOTE: 'true', ...demo })!;
    assert.deepEqual([cfg.provider, cfg.model, cfg.apiKey, isRemote(cfg)], [provider, 'some-model', KEY, true]);
    assert.ok(modelConfigFromEnv({ ...base, MODUS_ADVISOR_ALLOW_REMOTE: 'true', MODUS_ADVISOR_ALLOW_REAL_DATA: 'true' }), 'the owner may allow real data explicitly');
  }
  assert.throws(() => modelConfigFromEnv({ MODUS_ADVISOR_PROVIDER: 'gemini' }), /поддерживаются/);
  const local = modelConfigFromEnv({ MODUS_ADVISOR_PROVIDER: 'ollama', MODUS_ADVISOR_MODEL: 'qwen2.5:7b' })!;
  assert.deepEqual([local.provider, local.url, isRemote(local), local.apiKey], ['ollama', 'http://127.0.0.1:11434', false, undefined]);
});

const claude: ModelConfig = { provider: 'anthropic', url: 'https://api.anthropic.com', model: 'claude-haiku-5-5', apiKey: KEY };
const gpt: ModelConfig = { provider: 'openai', url: 'https://api.openai.com/v1', model: 'gpt-test', apiKey: KEY };
const ask = { method: 'POST', body: JSON.stringify({ model: 'x', stream: false, format: 'json', options: { temperature: 0 }, messages: [{ role: 'system', content: 'Верни только JSON' }, { role: 'user', content: 'Текст обращения' }] }) };
const recorder = (reply: unknown, status = 200) => {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> | null }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, impl };
};

test('Anthropic: the Messages API shape, no sampling parameters, thinking blocks skipped, JSON taken out of the text', async () => {
  const r = recorder({ content: [{ type: 'thinking', thinking: 'размышление' }, { type: 'text', text: 'Вот ответ:\n```json\n{"verdict":"unclear","summary":"Данных мало для оценки решения."}\n```' }] });
  const res = await modelFetch(claude, r.impl)(`${claude.url}/api/chat`, ask);
  const call = r.calls[0]!;
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.deepEqual([call.headers['x-api-key'], call.headers['anthropic-version']], [KEY, '2023-06-01']);
  assert.deepEqual(Object.keys(call.body!).sort(), ['max_tokens', 'messages', 'model', 'system']);
  assert.deepEqual([call.body!.model, call.body!.system, call.body!.messages], ['claude-haiku-5-5', 'Верни только JSON', [{ role: 'user', content: 'Текст обращения' }]]);
  const out = (await res.json()) as { message: { content: string } };
  assert.deepEqual(JSON.parse(out.message.content), { verdict: 'unclear', summary: 'Данных мало для оценки решения.' });
  const denied = await modelFetch(claude, recorder({ error: {} }, 401).impl)(`${claude.url}/api/chat`, ask);
  assert.equal(denied.status, 401);
});

test('OpenAI: the chat completions shape with a JSON answer', async () => {
  const r = recorder({ choices: [{ message: { content: '{"items":[]}' } }] });
  const res = await modelFetch(gpt, r.impl)(`${gpt.url}/api/chat`, ask);
  const call = r.calls[0]!;
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(call.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual([call.body!.model, call.body!.response_format], ['gpt-test', { type: 'json_object' }]);
  assert.equal((call.body!.messages as { role: string }[])[0]!.role, 'system');
  assert.equal(((await res.json()) as { message: { content: string } }).message.content, '{"items":[]}');
});

test('a local model is spoken to directly, as before', async () => {
  const r = recorder({ message: { content: '{}' } });
  const local: ModelConfig = { provider: 'ollama', url: 'http://127.0.0.1:11434', model: 'qwen' };
  assert.equal(modelFetch(local, r.impl), r.impl);
});

test('status: says the model is a cloud one and that the text leaves the company; the key is never shown', async () => {
  const listed = recorder({ data: [{ id: 'claude-haiku-5-5' }, { id: 'other' }] });
  assert.equal(await modelReachable(claude, listed.impl), true);
  assert.equal(listed.calls[0]!.url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(await modelReachable({ ...claude, model: 'absent' }, listed.impl), false);
  assert.equal(await modelReachable(claude, recorder({}, 401).impl), false);
  const st = await advisorStatus(claude, listed.impl);
  assert.deepEqual([st.model.configured, st.model.remote, st.model.reachable, st.model.model], [true, true, true, 'claude-haiku-5-5']);
  assert.match(st.note, /уходят за пределы компании/);
  assert.equal(JSON.stringify(st).includes(KEY), false);
  assert.equal(modelLabel(claude), 'облачная модель claude-haiku-5-5 (Anthropic)');
  const none = await advisorStatus(null);
  assert.deepEqual([none.model.configured, none.model.remote], [false, false]);
});
