import { sql } from 'drizzle-orm';
import { accounts, results } from '../db/schema';

/** 用户战绩与对局详情共用；只选择展示字段，不携带认证标识。需左连接 accounts。 */
export const adminResultColumns = {
  match_id: results.match_id,
  theme: results.theme,
  opponent_kind: results.opponent_kind,
  damage_dealt: results.damage_dealt,
  hp_remaining: results.hp_remaining,
  spells_cast: results.spells_cast,
  correct_chars: results.correct_chars,
  duration_ms: results.duration_ms,
  rank: results.rank,
  cpm: results.cpm,
  accuracy: results.accuracy,
  created_at: results.created_at,
  input_policy_version: results.input_policy_version,
  input_policy_mode: results.input_policy_mode,
  input_gate_hits: results.input_gate_hits,
  input_recoveries: results.input_recoveries,
  input_min_completion_ratio: results.input_min_completion_ratio,
  input_overloads: results.input_overloads,
  input_recovered_completions: results.input_recovered_completions,
  input_recovery_departures: results.input_recovery_departures,
  userId: results.user_id,
  username: sql<string>`coalesce(${accounts.username}, '')`,
  accountExists: sql<boolean>`${accounts.id} is not null`,
  roomId: results.room_id,
};
