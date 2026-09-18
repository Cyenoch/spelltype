import type { Element } from '../../../shared/protocol';
import type { SqlStore } from '../../sql';

export interface PendingCast {
  attackerId: string;
  spellIndex: number;
  element: Element;
  power: number;
}

export interface PendingVolley {
  matchId: string;
  endsAt: number;
  roster: string[];
  casts: PendingCast[];
}

type VolleyRow = {
  match_id: string;
  ends_at: number;
  roster_json: string;
  casts_json: string;
};

/** Only one window can be open: overdue damage is applied before accepting input. */
export function readVolley(sql: SqlStore): PendingVolley | null {
  const row = sql.exec<VolleyRow>('SELECT * FROM combat_volley WHERE singleton = 1').toArray()[0];
  if (!row) return null;
  return {
    matchId: row.match_id,
    endsAt: row.ends_at,
    roster: JSON.parse(row.roster_json) as string[],
    casts: JSON.parse(row.casts_json) as PendingCast[],
  };
}

/** The caller advances the spell cursor synchronously with this durable commitment. */
export function queueCast(sql: SqlStore, volley: PendingVolley, cast: PendingCast): void {
  volley.casts.push(cast);
  sql.exec(
    `INSERT INTO combat_volley (singleton, match_id, ends_at, roster_json, casts_json)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(singleton) DO UPDATE SET casts_json = excluded.casts_json`,
    volley.matchId,
    volley.endsAt,
    JSON.stringify(volley.roster),
    JSON.stringify(volley.casts),
  );
}

export function clearVolley(sql: SqlStore): void {
  sql.exec('DELETE FROM combat_volley');
}
