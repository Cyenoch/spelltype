import { createEffect, createSignal, onCleanup } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { useMutation, useQuery } from '@tanstack/solid-query';
import type { MatchTicket } from '../../../shared/protocol';
import { parseResponse, DetailedError } from 'hono/client';
import { client } from '../../app/client';
import { messageOf, toast } from '../../ui/toast';
import type { AppContext } from '../../app/context';

const POLL_INTERVAL_MS = 2000;
const TICK_INTERVAL_MS = 250;

/** Where the search stands. Only `waiting` is a live search. */
export type QueueState = 'waiting' | 'matched' | 'cancelled' | 'blocked';

const STATE_MESSAGES: Record<QueueState, string> = {
  waiting: '正在为你寻找对手…',
  matched: '已找到对手，正在进入房间…',
  cancelled: '已取消本次匹配。',
  blocked: '这次请求没能加入排队。',
};

const STATE_HINTS: Record<QueueState, string> = {
  waiting: '匹配成功后自动进入房间。',
  matched: '正在连接对手，准备对决。',
  cancelled: '可以重新排队，或返回首页。',
  blocked: '已有其他排队或对局。请取消已有排队，或返回原对局页面。',
};

export interface MatchQueue {
  state(): QueueState;
  message(): string;
  hint(): string;
  error(): string | null;
  retry(): boolean;
  paused(): boolean;
  /** Real elapsed waiting time, and it stops the moment the search does. */
  elapsed(): number;
  cancelPending(): boolean;
  cancel(): void;
  requeue(): void;
  toggleMotion(): void;
}

/**
 * The matchmaking lease and its one clock.
 *
 * The queue is a lease owned by the server: `POST /api/match` is the poll *and* the request, so
 * every status comes from a real round trip (the ticket refreshes its own expiry). It is therefore
 * a query with a `refetchInterval` rather than a hand-rolled timer — but one that must never be
 * served from the cache, and one that stops the moment the search ends.
 */
export function createMatchQueue(props: { ctx: AppContext }): MatchQueue {
  const navigate = useNavigate();
  let destroyed = false;
  let pendingPoll: Promise<MatchTicket> | undefined;
  /** Last ticket the server returned; a started match is what makes a cancel refuse. */
  let lastTicket: MatchTicket | null = null;
  /** Last payload already painted, so a re-run of the effect cannot paint it twice. */
  let handled: MatchTicket | null = null;
  let failure: unknown = null;

  const [state, setState] = createSignal<QueueState>('waiting');
  /** Explicit status line (retry notice, or the refusal that ended the search). */
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [retry, setRetry] = createSignal(false);
  const [paused, setPaused] = createSignal(false);
  const [polling, setPolling] = createSignal(true);
  const [startedAt, setStartedAt] = createSignal(Date.now());
  const [elapsed, setElapsed] = createSignal(0);

  const waiting = () => state() === 'waiting';

  // The only clock is real elapsed waiting time, and it stops the moment the search does.
  createEffect(() => {
    if (!waiting()) return;
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt()), TICK_INTERVAL_MS);
    onCleanup(() => window.clearInterval(timer));
  });

  const ticketQuery = useQuery(() => ({
    queryKey: ['match', 'ticket'],
    queryFn: () => (pendingPoll = parseResponse(client.api.match.$post())),
    enabled: polling() && waiting(),
    /**
     * A ticket is only ever valid as the answer to a fresh poll: the entry is a lease the server
     * extends per request, and a started match answers the same poll with `matched` + its reserved
     * room. Cached or retried answers would report a status nobody asked for, so this query neither
     * reuses data (`staleTime`/`gcTime` 0) nor repeats a failed call on its own (`retry` false) —
     * a slow service is retried by the next poll, at half speed, exactly as the status line says.
     */
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: true,
    refetchInterval: () => (retry() ? POLL_INTERVAL_MS * 2 : POLL_INTERVAL_MS),
  }));

  // Aborting a fetch cannot undo a server-side enqueue; cancel after it settles.
  const cancelLease = async () => {
    await pendingPoll?.catch(() => undefined);
    return parseResponse(client.api.match.$delete());
  };
  const cancelMatch = useMutation(() => ({ mutationFn: cancelLease }));

  /** Paint a state once: status line, hint and the actions. */
  const settle = (next: QueueState, override?: string) => {
    setPolling(false);
    setElapsed(Date.now() - startedAt());
    setStatus(override ?? null);
    setState(next);
    setRetry(false);
  };

  const requeue = () => {
    if (destroyed || waiting()) return;
    // Anything the server already answered for the finished search is spent, never replayed.
    handled = ticketQuery.data ?? null;
    failure = ticketQuery.error ?? null;
    lastTicket = null;
    setStartedAt(Date.now());
    setElapsed(0);
    setError(null);
    setRetry(false);
    setStatus(null);
    setState('waiting');
    setPolling(true);
  };

  const cancel = async () => {
    if (destroyed || cancelMatch.isPending) return;
    setPolling(false);
    try {
      const { cancelled } = await cancelMatch.mutateAsync();
      if (destroyed) return;
      if (!cancelled) {
        // The server refused: a started match already holds this account's seat.
        const roomId = lastTicket?.roomId;
        settle(
          roomId ? 'matched' : 'blocked',
          roomId ? undefined : '已有对局开始，请返回原对局页面继续。',
        );
        if (roomId) {
          props.ctx.setPendingInvite(roomId);
          void navigate({ to: '/', search: { room: roomId } });
        }
        return;
      }
      setError(null);
      settle('cancelled');
      toast('已取消匹配等待。', 'info');
    } catch (error) {
      if (destroyed) return;
      if (error instanceof DetailedError && error.statusCode === 401) {
        setPolling(false);
        props.ctx.handleAuthFailure('登录已过期，请重新登录。');
        return;
      }
      setError(messageOf(error, '取消匹配失败，请重试。'));
      setPolling(true);
    }
  };

  // Every ticket the server hands back is a real answer to a poll this view started.
  createEffect(() => {
    const ticket = ticketQuery.data;
    if (!ticket || !waiting()) return;
    lastTicket = ticket;
    if (!polling() || ticket === handled) return;
    handled = ticket;
    if (ticket.state === 'matched' && ticket.roomId) {
      // The seat is reserved for this account: remember the room, then let the shell open it.
      settle('matched');
      props.ctx.setPendingInvite(ticket.roomId);
      void navigate({ to: '/', search: { room: ticket.roomId } });
      return;
    }
    setError(null);
    setRetry(false);
    setStatus(null);
  });

  createEffect(() => {
    const error = ticketQuery.error;
    if (!error || error === failure) return;
    failure = error;
    if (!waiting()) return;
    if (error instanceof DetailedError && error.statusCode === 401) {
      setPolling(false);
      props.ctx.handleAuthFailure('登录已过期，请重新登录后再匹配。');
      return;
    }
    if (error instanceof DetailedError && error.statusCode === 409) {
      setError(messageOf(error, '无法排队。'));
      settle('blocked');
      return;
    }
    setError(messageOf(error, '匹配请求失败，正在重试…'));
    setRetry(true);
    setStatus('匹配服务暂时没有回应，正在自动重试…');
  });

  onCleanup(() => {
    destroyed = true;
    // Leaving the view must not keep a matchmaking seat; no poll may run after this.
    if (!waiting()) return;
    void cancelLease().catch(() => undefined);
  });

  return {
    state,
    message: () => status() ?? STATE_MESSAGES[state()],
    hint: () => STATE_HINTS[state()],
    error,
    retry,
    paused,
    elapsed,
    cancelPending: () => cancelMatch.isPending,
    cancel: () => void cancel(),
    requeue,
    toggleMotion: () => setPaused(!paused()),
  };
}
