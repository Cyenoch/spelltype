import { useQuery, type QueryClient } from '@tanstack/solid-query';
import type { SessionInfo, User } from '../../shared/protocol';
import { sessionOptions } from './queries';

/** The account's role, as the session document reports it (`null` for guests). */
export type SessionRole = NonNullable<SessionInfo['role']>;

export interface Session {
  readonly user: User | null;
  /** 'user' | 'admin' for signed-in accounts, null for guests. UI only: the server enforces. */
  readonly role: SessionRole | null;
  readonly pending: boolean;
  readonly error: Error | null;
  refresh(): Promise<SessionInfo>;
  clear(): void;
}

/** Cookie-backed identity; Query owns freshness and Solid owns subscriptions. */
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
