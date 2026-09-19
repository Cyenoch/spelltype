import { and, eq, gt } from 'drizzle-orm';
import { roomSessions, sessions } from '../../db/schema';
import type { QueryDatabase } from '../../db';
import type { RoomQuery } from './query';

/**
 * 记录该会话在 `roomId` 中持有活跃席位，以便撤销会话时能够同时撤销该席位授权的套接字。
 * 当会话不再存在或已过期时返回 `false`：此时房间必须拒绝握手，
 * 因为该注册在与登出操作的竞态中落败。
 *
 * 活跃会话检查对会话数据行获取 `FOR SHARE` 共享锁，并持有至调用方事务结束。
 * 因此，并发登出的失效标记（`UPDATE sessions SET expires_at = 0`）要么在注册读取该行之前提交
 * —— 注册操作随后予以拒绝 —— 要么等待注册提交，
 * 随后登出的席位扫描便能观察到全新的 `room_sessions` 行并撤销该新套接字。
 * 绝不存在注册成功却未被登出操作感知的交错执行情况。
 */
export async function registerSessionRoom(
  db: QueryDatabase,
  tokenHash: string,
  roomId: string,
  now = Date.now(),
): Promise<boolean> {
  const live = await db
    .select({ token_hash: sessions.token_hash })
    .from(sessions)
    .where(and(eq(sessions.token_hash, tokenHash), gt(sessions.expires_at, now)))
    .for('share')
    .limit(1);
  if (live.length === 0) return false;
  await db
    .insert(roomSessions)
    .values({ session_hash: tokenHash, room_id: roomId })
    .onConflictDoNothing();
  return true;
}

/** 移除单条席位记录。移除一个已经不存在的席位不会报错。 */
export async function unregisterSessionRoom(
  db: RoomQuery,
  tokenHash: string,
  roomId: string,
): Promise<void> {
  await db
    .delete(roomSessions)
    .where(and(eq(roomSessions.session_hash, tokenHash), eq(roomSessions.room_id, roomId)));
}

/** 查询会话令牌是否仍对应一个有效活跃的会话。 */
export async function sessionIsLive(
  db: RoomQuery,
  tokenHash: string,
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .select({ token_hash: sessions.token_hash })
    .from(sessions)
    .where(and(eq(sessions.token_hash, tokenHash), gt(sessions.expires_at, now)))
    .limit(1);
  return rows.length > 0;
}
