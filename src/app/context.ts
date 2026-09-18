import type { QueryClient } from '@tanstack/solid-query';
import type { ServerClock } from './clock';
import type { Session } from './session';
import type { Tone } from '../ui/toast';

export type AuthMode = 'login' | 'register';
export type RoomLinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Application services; page state belongs to Solid components. */
export interface AppContext {
  readonly session: Session;
  readonly queryClient: QueryClient;
  readonly clock: ServerClock;
  pendingInvite(): string | null;
  setPendingInvite(roomId: string | null): void;
  inviteUrl(roomId: string): string;
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
