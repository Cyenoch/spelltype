import process from 'node:process';

const usage = 'Usage: bun run scripts/input-policy-report.ts --from-ms <integer> --to-ms <integer>';

try {
  const args = process.argv.slice(2);
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

  // Validated decimal bounds are the only substitutions; no credentials or database access.
  console.log(`SELECT
  input_policy_version,
  input_policy_mode,
  COUNT(DISTINCT match_id) AS matches,
  COUNT(*) AS player_matches,
  SUM(spells_cast) AS accepted_completions,
  SUM(input_gate_hits) AS gate_hits,
  SUM(input_recoveries) AS recoveries,
  MIN(input_min_completion_ratio) AS min_completion_ratio,
  SUM(input_overloads) AS overloads,
  SUM(input_recovered_completions) AS recovered_completions,
  SUM(input_recovery_departures) AS recovery_departures
FROM results
WHERE created_at >= ${from} AND created_at < ${to}
GROUP BY input_policy_version, input_policy_mode
ORDER BY input_policy_version, input_policy_mode;`);
} catch (error) {
  console.error(error instanceof Error ? error.message : usage);
  process.exitCode = 1;
}
