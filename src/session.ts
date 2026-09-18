import { api, ApiError } from './api';
import type { User } from '../shared/protocol';

export interface SessionState {
  user: User | null;
  aiConfigured: boolean;
}

type Listener = (state: SessionState) => void;

/** Cookie-backed identity. No token is ever stored in the frontend. */
export class Session {
  private state: SessionState = { user: null, aiConfigured: false };
  private readonly listeners = new Set<Listener>();

  get user(): User | null {
    return this.state.user;
  }

  get aiConfigured(): boolean {
    return this.state.aiConfigured;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  async refresh(): Promise<SessionState> {
    const response = await api.session();
    this.state = { user: response.user ?? null, aiConfigured: Boolean(response.aiConfigured) };
    this.publish();
    return this.state;
  }

  setUser(user: User): void {
    this.state = { ...this.state, user };
    this.publish();
  }

  /** Called after logout or when the server rejects the session. */
  clear(): void {
    this.state = { ...this.state, user: null };
    this.publish();
  }

  static isAuthFailure(error: unknown): boolean {
    return error instanceof ApiError && error.isAuthFailure;
  }
}
