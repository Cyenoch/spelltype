// One-shot maintenance entry for the host-side deploy runner (baked into the
// image as dist/server/maintenance.js). It inspects durable maintenance state,
// closes admission (clearing waiting tickets), or reopens with revision/epoch
// CAS. It applies no migrations, acquires no runtime ownership, and never
// forcibly terminates matches. The host runner invokes it inside the app
// container or in a one-shot container from the same image during recovery.
// Host Docker privilege authorizes this entry; it does not use the separate
// maintenance-only bearer credential supported by /api/ops/maintenance.
//
// Modes (exactly one per invocation):
//   --status                       print the DrainStatus as JSON (read-only)
//   --drain --expected-revision N  enterMaintenance CAS; prints MaintenanceInfo JSON
//   --resume --expected-revision N --expected-runtime-epoch E
//                                  leaveMaintenance CAS; the runner must have
//                                  proven E against public /health immediately
//                                  before (a live runtime lease is enforced)
//   --check                        print the entry/build identity as JSON and
//                                  exit without touching the database

import { z } from 'zod';
import { openDatabase } from './db';
import { readDatabaseUrl } from './config';
import {
  enterMaintenance,
  inspectMaintenance,
  leaveMaintenance,
  MaintenanceConflict,
} from './maintenance/control';

declare const __SPELLTYPE_BUILD_ID__: string;

const log = console.error;

const revisionSchema = z.coerce.number().int();

function buildId(): string {
  return typeof __SPELLTYPE_BUILD_ID__ === 'undefined' ? 'development' : __SPELLTYPE_BUILD_ID__;
}

function parseRevisions(argv: string[]): {
  expectedRevision?: number;
  expectedRuntimeEpoch?: number;
} {
  let expectedRevision: number | undefined;
  let expectedRuntimeEpoch: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--expected-revision' && value !== undefined) {
      expectedRevision = revisionSchema.parse(value);
      i++;
    } else if (flag === '--expected-runtime-epoch' && value !== undefined) {
      expectedRuntimeEpoch = revisionSchema.parse(value);
      i++;
    } else {
      throw new Error(`unknown or incomplete option ${flag}`);
    }
  }
  return { expectedRevision, expectedRuntimeEpoch };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const actions = ['--status', '--drain', '--resume', '--check'].filter((flag) =>
    argv.includes(flag),
  );
  if (actions.length !== 1) {
    log(
      'usage: bun server/maintenance-cli.ts <--status | --drain --expected-revision N | --resume --expected-revision N --expected-runtime-epoch E | --check>',
    );
    return 2;
  }
  const action = actions[0];
  const { expectedRevision, expectedRuntimeEpoch } = parseRevisions(
    argv.filter((arg) => arg !== action),
  );

  if (action === '--check') {
    console.log(JSON.stringify({ entry: 'maintenance', buildId: buildId() }));
    return 0;
  }

  const url = await readDatabaseUrl();
  // Strictly read-only on the schema: maintenance never migrates.
  const opened = await openDatabase(url, { migrate: false });
  try {
    if (action === '--status') {
      console.log(JSON.stringify(await inspectMaintenance(opened.db), null, 2));
      return 0;
    }
    if (action === '--drain') {
      if (expectedRevision === undefined) {
        log('--drain requires --expected-revision N');
        return 2;
      }
      // Refusing repeated/stale drains is the durable control row's job; a
      // conflict exits 3 so the runner can re-read instead of forcing.
      const info = await enterMaintenance(opened.db, expectedRevision);
      console.log(JSON.stringify(info));
      return 0;
    }
    if (expectedRevision === undefined || expectedRuntimeEpoch === undefined) {
      log('--resume requires --expected-revision N and --expected-runtime-epoch E');
      return 2;
    }
    const info = await leaveMaintenance(opened.db, expectedRevision, expectedRuntimeEpoch);
    console.log(JSON.stringify(info));
    return 0;
  } catch (error) {
    if (error instanceof MaintenanceConflict) {
      log(`maintenance CAS conflict: ${error.message}`);
      return 3;
    }
    throw error;
  } finally {
    await opened.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    log(`maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
