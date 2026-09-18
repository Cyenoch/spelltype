import { and, count, countDistinct, gte, lt, min, sum } from 'drizzle-orm';
import { readDatabaseUrl } from '../server/config';
import { openDatabase, results } from '../server/db';

const usage = 'Usage: bun run scripts/input-policy-report.ts --from-ms <integer> --to-ms <integer>';

try {
  const args = Bun.argv.slice(2);
  if (args.length !== 4) throw new Error(usage);
  let from: number | undefined;
  let to: number | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(usage);
    const timestamp = Number(value);
    if (!Number.isSafeInteger(timestamp)) throw new Error(usage);
    if (args[i] === '--from-ms' && from === undefined) from = timestamp;
    else if (args[i] === '--to-ms' && to === undefined) to = timestamp;
    else throw new Error(usage);
  }
  if (from === undefined || to === undefined || from >= to) throw new Error(usage);

  const database = await openDatabase(await readDatabaseUrl());
  try {
    const report = await database.db
      .select({
        input_policy_version: results.input_policy_version,
        input_policy_mode: results.input_policy_mode,
        matches: countDistinct(results.match_id),
        player_matches: count(),
        accepted_completions: sum(results.spells_cast),
        gate_hits: sum(results.input_gate_hits),
        recoveries: sum(results.input_recoveries),
        min_completion_ratio: min(results.input_min_completion_ratio),
        overloads: sum(results.input_overloads),
        recovered_completions: sum(results.input_recovered_completions),
        recovery_departures: sum(results.input_recovery_departures),
      })
      .from(results)
      .where(and(gte(results.created_at, from), lt(results.created_at, to)))
      .groupBy(results.input_policy_version, results.input_policy_mode)
      .orderBy(results.input_policy_version, results.input_policy_mode);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await database.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : usage);
  process.exitCode = 1;
}
