import { readFileSync, writeFileSync } from 'node:fs';
import { createDatabase } from '../db/pool.ts';
import { exportLedger, importLedger } from '../modules/knowledge-privacy.ts';

/**
 * The erasure ledger (ADR-0018): the log of erasures in knowledge, with places and legal bases
 * but no erased content. Keep the exported file OUTSIDE database backups (it must survive a
 * restore of an older backup), and import it right after any restore:
 *   MIGRATION_DATABASE_URL=… npm run -s platform:ledger -- export ledger.json
 *   MIGRATION_DATABASE_URL=… npm run -s platform:ledger -- import ledger.json
 * Import adds the log rows the backup lacked and re-applies every erasure.
 */
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL (schema owner) is required');
const [cmd, file] = process.argv.slice(2);
if (!['export', 'import'].includes(cmd ?? '') || !file) throw new Error('usage: erasure-ledger export|import <file>');
const db = createDatabase(url, 1);
try {
  if (cmd === 'export') {
    const l = await exportLedger(db);
    writeFileSync(file, JSON.stringify(l, null, 1));
    console.log(JSON.stringify({ level: 'info', exported: l.knowledgeRedactions.length, file }));
  } else {
    console.log(JSON.stringify({ level: 'info', ...(await importLedger(db, JSON.parse(readFileSync(file, 'utf8')))) }));
  }
} finally {
  await db.close();
}
