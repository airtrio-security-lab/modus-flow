/**
 * Smoke check of the real speech-to-text path (ADR-0015): MODUS FLOW → local faster-whisper
 * server (scripts/whisper-server.py) → transcript labelled «engine» → findings by template.
 * Needs: the whisper server running, the demo server started with MODUS_TRANSCRIBE_* set,
 * a freshly seeded demo database, and an audio file (with consent!) as the first argument:
 *   npm run asr:smoke -- path/to/meeting.ogg
 */
import { readFileSync } from 'node:fs';
const AUDIO = process.argv[2] ?? (() => { throw new Error('usage: npm run asr:smoke -- path/to/audio'); })();
const B = `${process.env.BASE ?? 'http://127.0.0.1:3100'}/api/v1`;
const people = JSON.parse(readFileSync('.demo/personas.json', 'utf8')).personas;
const wh = people.find((p) => p.title === 'Начальник склада');
const tok = (await (await fetch(`${B}/demo/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: wh.userId }) })).json()).token;
const h = (extra = {}) => ({ authorization: `Bearer ${tok}`, 'idempotency-key': crypto.randomUUID(), ...extra });
const O = `${B}/orgs/modus-demo`;
const eng = await (await fetch(`${O}/engines`, { headers: h() })).json();
console.log('engine:', JSON.stringify(eng.transcription));
const list = await (await fetch(`${O}/meetings`, { headers: h() })).json();
const id = list.find((m) => m.title.startsWith('Планёрка склада')).id;
const up = await fetch(`${O}/meetings/${id}/recording`, { method: 'POST', headers: h({ 'content-type': AUDIO.endsWith('.wav') ? 'audio/wav' : AUDIO.endsWith('.mp3') ? 'audio/mpeg' : AUDIO.endsWith('.webm') ? 'audio/webm' : 'audio/ogg', 'x-recording-source': 'upload' }), body: readFileSync(AUDIO) });
console.log('upload:', up.status);
const t0 = Date.now();
const tr = await fetch(`${O}/meetings/${id}/transcribe`, { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: '{}' });
console.log('transcribe:', tr.status, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
const v = await (await fetch(`${O}/meetings/${id}`, { headers: h() })).json();
const t = v.transcripts.at(-1);
console.log('source:', t.source, '| engine:', t.engine);
console.log(t.text);
const an = await (await fetch(`${O}/meetings/${id}/analyses`, { method: 'POST', headers: h({ 'content-type': 'application/json' }), body: JSON.stringify({ transcriptId: t.id, method: 'rules' }) })).json();
console.log('analysis:', JSON.stringify(an));
if (t.source !== 'engine') { console.error('✗ the transcript is not from the engine'); process.exit(1); }
console.log('✓ запись распознана локальным движком и помечена как автоматическая расшифровка');
