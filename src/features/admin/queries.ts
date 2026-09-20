import { queryOptions } from '@tanstack/solid-query';
import { parseResponse } from 'hono/client';
import type { AdminListSearch } from '../../../shared/admin';
import { client } from '../../app/client';
import { parseMatchPhase } from './search';

export const adminOverviewOptions = () =>
  queryOptions({
    queryKey: ['admin', 'overview'],
    queryFn: ({ signal }) =>
      parseResponse(client.api.admin.overview.$get({}, { init: { signal } })),
    staleTime: 10_000,
    retry: false,
  });

export const adminUsersOptions = (search: AdminListSearch) =>
  queryOptions({
    queryKey: ['admin', 'users', search],
    queryFn: ({ signal }) =>
      parseResponse(
        client.api.admin.users.$get(
          { query: { page: String(search.page), q: search.q } },
          { init: { signal } },
        ),
      ),
    staleTime: 10_000,
    retry: false,
  });

export const adminUserOptions = (userId: string, page: number) =>
  queryOptions({
    queryKey: ['admin', 'user', userId, page],
    queryFn: ({ signal }) =>
      parseResponse(
        client.api.admin.users[':userId'].$get(
          { param: { userId }, query: { page: String(page) } },
          { init: { signal } },
        ),
      ),
    staleTime: 10_000,
    retry: false,
  });

export const adminMatchesOptions = (search: AdminListSearch & { phase: string }) =>
  queryOptions({
    queryKey: ['admin', 'matches', search],
    queryFn: ({ signal }) =>
      parseResponse(
        client.api.admin.matches.$get(
          {
            query: {
              page: String(search.page),
              q: search.q,
              phase: parseMatchPhase(search.phase) || undefined,
            },
          },
          { init: { signal } },
        ),
      ),
    staleTime: 5_000,
    retry: false,
  });

export const adminMatchOptions = (matchId: string) =>
  queryOptions({
    queryKey: ['admin', 'match', matchId],
    queryFn: ({ signal }) =>
      parseResponse(
        client.api.admin.matches[':matchId'].$get({ param: { matchId } }, { init: { signal } }),
      ),
    staleTime: 5_000,
    retry: false,
  });

export const adminBooksOptions = (search: AdminListSearch) =>
  queryOptions({
    queryKey: ['admin', 'books', search],
    queryFn: ({ signal }) =>
      parseResponse(
        client.api.admin.books.$get(
          { query: { page: String(search.page), q: search.q } },
          { init: { signal } },
        ),
      ),
    staleTime: 10_000,
    retry: false,
  });

export const adminBookOptions = (theme: string, page: number) =>
  queryOptions({
    queryKey: ['admin', 'book', theme, page],
    queryFn: ({ signal }) =>
      parseResponse(
        client.api.admin.books[':theme'].$get(
          { param: { theme }, query: { page: String(page) } },
          { init: { signal } },
        ),
      ),
    staleTime: 10_000,
    retry: false,
  });
