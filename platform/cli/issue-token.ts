import { assertSecret, issueToken } from '../http/auth.ts';

// Usage: MODUS_AUTH_SECRET=... node platform/cli/issue-token.ts <user-uuid> [ttl-seconds]
const [userId, ttl] = process.argv.slice(2);
if (!userId) {
  console.error('usage: issue-token.ts <user-uuid> [ttl-seconds]');
  process.exit(2);
}
console.log(issueToken(assertSecret(process.env.MODUS_AUTH_SECRET), userId, ttl ? Number(ttl) : undefined));
