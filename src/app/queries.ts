import { queryOptions } from '@tanstack/solid-query';
import { parseResponse } from 'hono/client';
import { client } from './client';

/** 会话是外层壳组件始终读取的唯一入口：访客身份返回 200 且 `user: null`。 */
export const sessionOptions = queryOptions({
  queryKey: ['session'],
  queryFn: ({ signal }) => parseResponse(client.api.session.$get({}, { init: { signal } })),
  staleTime: 30_000,
  retry: false,
  // 封禁中的账号以固定节奏重查会话：限时封禁到期后界面自动恢复，无需手动刷新。
  refetchInterval: (query) => (query.state.data?.ban ? BAN_RECHECK_INTERVAL_MS : false),
});

/** 封禁账号重查会话的节奏；决定了限时封禁到期后恢复使用的最长等待。 */
const BAN_RECHECK_INTERVAL_MS = 15_000;

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
