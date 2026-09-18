import { queryOptions } from '@tanstack/solid-query';
import { parseResponse } from 'hono/client';
import { client } from './client';

/** The session is the one entry the shell always reads: a guest is a 200 with `user: null`. */
export const sessionOptions = queryOptions({
  queryKey: ['session'],
  queryFn: ({ signal }) => parseResponse(client.api.session.$get({}, { init: { signal } })),
  staleTime: 30_000,
  retry: false,
});

export const profileOptions = (userId: string) =>
  queryOptions({
    queryKey: ['profile', userId],
    queryFn: ({ signal }) => parseResponse(client.api.profile.$get({}, { init: { signal } })),
    enabled: Boolean(userId),
    staleTime: 30_000,
    retry: false,
  });
