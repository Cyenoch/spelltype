import { useQuery, type QueryClient } from '@tanstack/solid-query';
import type { SessionInfo, User } from '../../shared/protocol';
import { sessionOptions } from './queries';

export interface Session {
  readonly user: User | null;
  readonly aiConfigured: boolean;
  readonly pending: boolean;
  readonly error: Error | null;
  refresh(): Promise<SessionInfo>;
  setUser(user: User): void;
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
    get aiConfigured() {
      return Boolean(query.data?.aiConfigured);
    },
    get pending() {
      return query.isPending;
    },
    get error() {
      return query.error;
    },
    refresh: () => client.fetchQuery({ ...sessionOptions, staleTime: 0 }),
    setUser(user: User) {
      discardPrivateData();
      client.setQueryData(sessionOptions.queryKey, (previous) => ({
        user,
        aiConfigured: previous?.aiConfigured ?? false,
      }));
    },
    clear() {
      discardPrivateData();
      client.setQueryData(sessionOptions.queryKey, (previous) => ({
        user: null,
        aiConfigured: previous?.aiConfigured ?? false,
      }));
    },
  };
}
