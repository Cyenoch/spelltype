import { z } from 'zod';

export const releaseIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const DEV_RELEASE_ID = 'dddddddddddddddddddddddddddddddd';
export type ReleaseState = 'staged' | 'active' | 'retiring' | 'retired';

export interface ReleaseInfo {
  activeReleaseId: string;
  updatedAt: number;
}

export interface RoomLocation {
  roomId: string;
  releaseId: string;
  state: ReleaseState;
  entryUrl: string;
}

export function gameApiBase(releaseId: string): string {
  return `/api/releases/${releaseIdSchema.parse(releaseId)}`;
}

const messages = {
  'release:update_required': '版本已更新，请更新页面后重试。',
  'release:room_retired': '这个房间已经结束，请返回首页开始新的对局。',
  'release:unavailable': '版本服务暂不可用，请稍后重试。',
} as const;

export type ReleaseCode = keyof typeof messages;

export class ReleaseError extends Error {
  readonly status: 409 | 503;

  constructor(
    readonly code: ReleaseCode,
    readonly activeReleaseId: string | null = null,
  ) {
    super(messages[code]);
    this.name = 'ReleaseError';
    this.status = code === 'release:unavailable' ? 503 : 409;
  }
}
