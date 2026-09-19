import type { QueryClient } from '@tanstack/solid-query';
import type { ServerClock } from './clock';
import type { MaintenanceService } from './maintenance';
import type { NotificationService } from './notifications';
import type { Session } from './session';
import type { Tone } from '../ui/toast';

/** Login failures the server bounces back onto /auth; the auth view renders them retryably. */
export type WechatLoginError = 'wechat_failed' | 'wechat_unavailable';
export type RoomLinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Application services; page state belongs to Solid components. */
export interface AppContext {
  readonly session: Session;
  readonly queryClient: QueryClient;
  readonly clock: ServerClock;
  /** Game-event reminders; one instance, owned by the session. */
  readonly notifications: NotificationService;
  /** The deployment's maintenance status; the shell renders guidance from it. */
  readonly maintenance: MaintenanceService;
  pendingInvite(): string | null;
  setPendingInvite(roomId: string | null): void;
  notify(message: string, tone?: Tone): void;
  reportGraphicsFailure(reason: string): void;
  handleAuthFailure(reason: string): void;
  setRoomConnection(state: RoomLinkState): void;
}

export interface AppRouterContext {
  readonly app: AppContext;
  notice(): string;
  connection(): RoomLinkState;
  graphicsFailed(): boolean;
}
