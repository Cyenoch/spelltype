import type { Difficulty } from '../shared/protocol';
import type { ServerClock } from './clock';
import type { Session } from './session';
import type { Tone } from './toast';

export type AuthMode = 'login' | 'register';

export type RoomLinkState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Everything a view may ask of the application shell. */
export interface AppContext {
  readonly session: Session;
  readonly clock: ServerClock;
  pendingInvite(): string | null;
  setPendingInvite(roomId: string | null): void;
  inviteUrl(roomId: string): string;
  goHome(): void;
  goGuide(): void;
  goAuth(mode?: AuthMode): void;
  goProfile(): void;
  goCreate(): void;
  goQueue(difficulty: Difficulty): void;
  openRoom(roomId: string): void;
  notify(message: string, tone?: Tone): void;
  reportGraphicsFailure(reason: string): void;
  handleAuthFailure(reason: string): void;
  setRoomConnection(state: RoomLinkState): void;
}

export interface View {
  readonly el: HTMLElement;
  /** Called after the view is mounted and whenever shared state changes. */
  update?(): void;
  destroy(): void;
}
