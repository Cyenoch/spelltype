import { randomUUID } from 'node:crypto';
import type { Difficulty } from '../shared/protocol';

/** Room identity: 24 lowercase hex characters (`roomIdSchema`), generated with a secure RNG. */
export function newRoomId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

/** Shard names: one matchmaking coordinator per account, one queue per difficulty. */
export const USER_SHARD_PREFIX = 'u:';
export const QUEUE_SHARD_PREFIX = 'q:';

export function userShardName(userId: string): string {
  return `${USER_SHARD_PREFIX}${userId}`;
}

export function queueShardName(difficulty: Difficulty): string {
  return `${QUEUE_SHARD_PREFIX}${difficulty}`;
}
