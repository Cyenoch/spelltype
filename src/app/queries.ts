import { queryOptions } from '@tanstack/solid-query';
import { parseResponse } from 'hono/client';
import { client } from './client';

/** 会话是外层壳组件始终读取的唯一入口：访客身份返回 200 且 `user: null`。 */
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

/** 首页公开的活动计数；访客亦可读取，因此该轮询绝不依赖登录会话。 */
export const activityOptions = queryOptions({
  queryKey: ['activity'],
  queryFn: ({ signal }) => parseResponse(client.api.activity.$get({}, { init: { signal } })),
  staleTime: 5_000,
  refetchInterval: 10_000,
  retry: false,
});
