import type { QueryClient } from '@tanstack/solid-query';
import type { ServerClock } from './clock';
import type { NotificationService } from './notifications';
import type { ReleaseService } from './releases';
import type { Session } from './session';
import type { Tone } from '../ui/toast';

export type AuthMode = 'login' | 'register';
export type RoomLinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Application services; page state belongs to Solid components. */
export interface AppContext {
  readonly session: Session;
  readonly queryClient: QueryClient;
  readonly clock: ServerClock;
  /** Game-event reminders; one instance, owned by the session. */
  readonly notifications: NotificationService;
  /** The deployment's release pointer; the shell renders update guidance from it. */
  readonly release: ReleaseService;
  pendingInvite(): string | null;
  setPendingInvite(roomId: string | null): void;
  /** The stable deep link of one room: its own release's entry resolves it. */
  roomEntryUrl(roomId: string): string;
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
