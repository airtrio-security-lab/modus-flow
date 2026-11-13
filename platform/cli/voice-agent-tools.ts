import { ELEVENLABS_AGENT_PROMPT } from '../modules/voice.ts';
import { elevenLabsToolSpecs } from '../modules/voice-tools.ts';

/**
 * Prints the configuration of the ElevenLabs agent «Альфред» (ADR-0043) as JSON: the fixed prompt (with its
 * three variables) and the client tools — what to create or compare in the ElevenLabs workspace.
 * No key, no network: both come from the server's own code.
 *   npm run -s voice:agent-tools
 */
console.log(JSON.stringify({ prompt: ELEVENLABS_AGENT_PROMPT, dynamic_variables: ['address', 'reply_language', 'council_number'], tools: elevenLabsToolSpecs() }, null, 2));
