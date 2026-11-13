import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createDatabase } from '../../../platform/db/pool.ts';
import { createApp } from '../../../platform/http/app.ts';
import { DevTokenAuthenticator } from '../../../platform/http/authn.ts';
import { demoConfigFromEnv } from '../../../platform/http/demo.ts';
import { DEFAULT_LIMITS } from '../../../platform/modules/voice-realtime.ts';

/**
 * TEST HARNESS — not a demo, not a product mode (ADR-0043).
 *
 * The real MODUS FLOW server with the voice advisor switched on, but with OpenAI replaced by a
 * provider that issues a session and then REFUSES the WebRTC connection (HTTP 503). It lets a real
 * browser check, without any paid call: microphone denied, microphone granted, the server session,
 * the SDP relay, an unavailable provider, and that every media stream is released. Nothing here
 * can produce a voice answer: there is no simulated speech.
 *
 *   DATABASE_URL=… MODUS_DEMO_PERSONAS=.demo/personas.json PLATFORM_PORT=3198 node test/platform/support/voice-harness.ts
 */
if (process.env.NODE_ENV === 'production') throw new Error('voice-harness is a test harness');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const secret = randomBytes(32).toString('hex');
const authenticator = new DevTokenAuthenticator(secret);
const demo = demoConfigFromEnv({ ...process.env, MODUS_DEMO_LOGIN: 'true', MODUS_AUTH_SECRET: secret }, authenticator);

const providerDown = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith('/realtime/client_secrets')) return new Response(JSON.stringify({ value: 'ek_harness_only', expires_at: Math.floor(Date.now() / 1000) + 60 }), { status: 200 });
  if (url.endsWith('/realtime/calls')) return new Response('{"error":"unavailable"}', { status: 503 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;

/**
 * Second mode — the real ElevenLabs agent without a server key: VOICE_HARNESS_SIGNED_URL holds one signed
 * URL of a conversation (obtained by the developer; valid for minutes). Everything else is real: the agent,
 * its voice, the tools, the data. Used once to check the ElevenLabs path end to end (ADR-0043).
 */
const signed = process.env.VOICE_HARNESS_SIGNED_URL;
const elevenVoice = signed
  ? {
      provider: 'elevenlabs' as const,
      url: 'https://api.elevenlabs.io/v1',
      model: 'ElevenLabs Agents',
      voice: 'Альфред',
      apiKey: 'harness-key-never-real',
      agentId: 'agent_harness000000',
      wsOrigin: new URL(signed).origin.replace(/^https/, 'wss'),
      limits: DEFAULT_LIMITS,
    }
  : null;
const signedOnly = (async () => new Response(JSON.stringify({ signed_url: signed }), { status: 200 })) as typeof fetch;

const handler = createApp({
  db: createDatabase(databaseUrl),
  authenticator,
  demo,
  staticDir: 'web/dist',
  voice: elevenVoice ?? { provider: 'openai', url: 'https://provider.invalid/v1', model: 'harness', voice: 'cedar', apiKey: 'harness-key-never-real', limits: DEFAULT_LIMITS },
  voiceFetch: elevenVoice ? signedOnly : providerDown,
  log: (e) => (e.voice ? console.log(JSON.stringify(e)) : undefined),
});
const port = Number(process.env.PLATFORM_PORT ?? 3198);
createServer((req, res) => void handler(req, res)).listen(port, '127.0.0.1', () => console.log(JSON.stringify({ harness: `${elevenVoice ? 'ElevenLabs signed URL' : 'voice provider DOWN'} on 127.0.0.1:${port}` })));
