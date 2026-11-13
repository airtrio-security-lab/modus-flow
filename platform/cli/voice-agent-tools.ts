import { elevenLabsToolSpecs } from '../modules/voice-tools.ts';

/**
 * Prints the client tools of the ElevenLabs agent «Альфред» (ADR-0043) as JSON — the list to create or
 * compare in the ElevenLabs workspace. No key, no network: the list is generated from the server's schemas.
 *   npm run -s voice:agent-tools
 */
console.log(JSON.stringify(elevenLabsToolSpecs(), null, 2));
