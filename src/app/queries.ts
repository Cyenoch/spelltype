import { queryOptions } from '@tanstack/solid-query';
import { parseResponse } from 'hono/client';
import { client, gameClient } from './client';
import { RELEASE_ID } from './release-id';

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

/** Public homepage counters; guests read them too, so the poll never depends on a session. */
export const activityOptions = queryOptions({
  queryKey: ['activity'],
  queryFn: ({ signal }) => parseResponse(client.api.activity.$get({}, { init: { signal } })),
  staleTime: 5_000,
  refetchInterval: 10_000,
  retry: false,
});

/** Capability belongs to this game runtime, never to the stable identity service. */
export const gameHealthOptions = queryOptions({
  queryKey: ['game-health', RELEASE_ID],
  queryFn: ({ signal }) => parseResponse(gameClient.health.$get({}, { init: { signal } })),
  staleTime: 5_000,
  refetchInterval: 10_000,
  retry: false,
});
