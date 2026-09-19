import { HTTPException } from 'hono/http-exception';
import type { ServerServices } from '../contracts';
import { deleteSession, tombstoneSession } from '../auth/sessions';

/** 关闭失败时仍会保留墓碑状态和 Cookie，以便后续如实重试。 */
export async function revokeSession(services: ServerServices, tokenHash: string): Promise<void> {
  await tombstoneSession(services.database, tokenHash);
  const runtime = services.rooms;
  if (!runtime) throw new HTTPException(503, { message: '退出失败，请重试' });
  try {
    await runtime.revokeSession(tokenHash);
    // 已被替换的进程无法代表其后继进程确认连接关闭。
    await services.database.transaction((tx) => runtime.assertOwnership(tx));
  } catch {
    throw new HTTPException(503, { message: '退出失败，请重试' });
  }
  await deleteSession(services.database, tokenHash);
}
