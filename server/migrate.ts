// One-shot production schema migration entry (baked into the image as
// dist/server/migrate.js). It applies Drizzle migrations forward-only, then
// guarantees durable draining maintenance, and closes the database. It never
// reopens maintenance, never rewrites or removes user data, and never leaves
// maintenance — resuming is always an explicit runner operation against a
// healthy running app (dist/server/maintenance.js). The production app starts
// with auto-migration disabled, so this entry is the only sanctioned way the
// production schema moves, and it always runs with admission closed.
//
// Modes:
//   (default)  apply migrations, ensure draining maintenance, close.
//   --check    executable check: print the entry/build identity as JSON and
//              exit without touching the database. Used by scripts/deploy.ts
//              to prove a candidate image can run before any maintenance.

import { openDatabase } from './db';
import { readDatabaseUrl } from './config';
import { enterMaintenance, MaintenanceConflict, readMaintenance } from './maintenance/control';

declare const __SPELLTYPE_BUILD_ID__: string;

const log = console.error;

function buildId(): string {
  return typeof __SPELLTYPE_BUILD_ID__ === 'undefined' ? 'development' : __SPELLTYPE_BUILD_ID__;
}

async function main(): Promise<number> {
  const flags = process.argv.slice(2);
  const hasCheck = flags.includes('--check');
  if (flags.some((flag) => flag !== '--check')) {
    log('usage: bun server/migrate.ts [--check]');
    return 2;
  }
  if (hasCheck) {
    console.log(JSON.stringify({ entry: 'migrate', buildId: buildId() }));
    return 0;
  }

  const url = await readDatabaseUrl();
  const opened = await openDatabase(url);
  try {
    log('applying forward migrations');
    const current = await readMaintenance(opened.db);
    if (current.mode === 'draining') {
      // A deploy that already drained through the maintenance entry lands
      // here: never re-enter and never reopen — that is the whole point.
      log(`maintenance already draining (revision ${current.revision}); migrations applied`);
      return 0;
    }
    try {
      const entered = await enterMaintenance(opened.db, current.revision);
      log(`maintenance draining (revision ${entered.revision}); migrations applied`);
    } catch (error) {
      if (error instanceof MaintenanceConflict) {
        log(
          'maintenance changed concurrently (CAS conflict); another operator moved the control row — re-read status and retry deliberately',
        );
        return 1;
      }
      throw error;
    }
    return 0;
  } finally {
    await opened.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    log(`migrate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
