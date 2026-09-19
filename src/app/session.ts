import { useQuery, type QueryClient } from '@tanstack/solid-query';
import type { SessionInfo, User } from '../../shared/protocol';
import { sessionOptions } from './queries';

/** 账户角色，由会话文档提供（访客为 `null`）。 */
export type SessionRole = NonNullable<SessionInfo['role']>;

export interface Session {
  readonly user: User | null;
  /** 已登录账户为 'user' | 'admin'，访客为 null。仅供前端 UI 使用：服务端负责强制鉴权。 */
  readonly role: SessionRole | null;
  readonly pending: boolean;
  readonly error: Error | null;
  refresh(): Promise<SessionInfo>;
  clear(): void;
}

/** 基于 Cookie 的用户身份标识；Query 负责保鲜，Solid 负责响应式订阅。 */
export function createSession(client: QueryClient): Session {
  const query = useQuery(() => sessionOptions);
  function discardPrivateData() {
    void client.cancelQueries();
    client.removeQueries({ predicate: (entry) => entry.queryKey[0] !== 'session' });
  }
  return {
    get user() {
      return query.data?.user ?? null;
    },
    get role() {
      return query.data?.role ?? null;
    },
    get pending() {
      return query.isPending;
    },
    get error() {
      return query.error;
    },
    refresh: () => client.fetchQuery({ ...sessionOptions, staleTime: 0 }),
    clear() {
      discardPrivateData();
      client.setQueryData(sessionOptions.queryKey, { user: null, role: null });
    },
  };
}
