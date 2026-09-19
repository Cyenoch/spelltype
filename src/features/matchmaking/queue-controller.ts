import { createEffect, createSignal, onCleanup } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { useQuery, useMutation } from '@tanstack/solid-query';
import { QUICK_GHOST_FALLBACK_MS } from '../../../shared/protocol';
import type { MatchTicket } from '../../../shared/protocol';
import { parseResponse, DetailedError } from 'hono/client';
import { client } from '../../app/client';
import { maintenanceCodeOf } from '../../app/maintenance';
import { messageOf, toast } from '../../ui/toast';
import type { AppContext } from '../../app/context';

const POLL_INTERVAL_MS = 2000;
const TICK_INTERVAL_MS = 250;
/** Quoted verbatim in the waiting hint, so the promise matches `QUICK_GHOST_FALLBACK_MS`. */
const GHOST_FALLBACK_SECONDS = QUICK_GHOST_FALLBACK_MS / 1000;

/** Where the search stands. Only `waiting` is a live search. */
export type QueueState = 'waiting' | 'matched' | 'cancelled' | 'blocked' | 'maintenance';

const STATE_MESSAGES: Record<QueueState, string> = {
  waiting: '正在为你寻找对手…',
  matched: '已找到对手，正在进入房间…',
  cancelled: '已取消本次匹配。',
  blocked: '这次请求没能加入排队。',
  maintenance: '系统维护中，本次排队无法继续。',
};

const STATE_HINTS: Record<QueueState, string> = {
  waiting: `匹配成功后自动进入房间。超过 ${GHOST_FALLBACK_SECONDS} 秒未遇真人，将自动安排训练对手陪练。`,
  matched: '正在连接对手，准备对决。',
  cancelled: '可以重新排队，或返回首页。',
  blocked: '已有其他排队或对局。请取消已有排队，或返回原对局页面。',
  maintenance: '进行中的对局不受影响；维护结束后可重新排队。',
};

export interface MatchQueue {
  state(): QueueState;
  message(): string;
  hint(): string;
  error(): string | null;
  retry(): boolean;
  /** Real elapsed waiting time, and it stops the moment the search does. */
  elapsed(): number;
  cancelPending(): boolean;
  cancel(): void;
  requeue(): void;
}

/**
 * The matchmaking lease and its one clock.
 *
 * The queue is a lease owned by the server: the poll is *also* the request, so
 * every status comes from a real round trip (`POST /api/match` refreshes the
 * ticket's expiry). It is therefore a query with a `refetchInterval` rather
 * than a hand-rolled timer — but one that must never be served from the cache,
 * and one that stops the moment the search ends. A matched ticket is a
 * reserved seat for this account on this server: the shell opens it in place.
 */
export function createMatchQueue(props: { ctx: AppContext }): MatchQueue {
  const navigate = useNavigate();
  let destroyed = false;
  let pendingPoll: Promise<MatchTicket> | undefined;
  /** Last ticket the server returned; a started match is what makes a cancel refuse. */
  let lastTicket: MatchTicket | null = null;
  /** Last payload already painted, so a re-run of the effect cannot paint it twice. */
  let handled: MatchTicket | null = null;
  /** Set while a cancellation is deciding the search's fate: no auto-entry may fire. */
  let suppressEntry = false;
  let failure: unknown = null;

  const [state, setState] = createSignal<QueueState>('waiting');
  /** Explicit status line (retry notice, or the refusal that ended the search). */
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [retry, setRetry] = createSignal(false);
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

  /** Enters a matched seat: the reservation is for this account on this server. */
  const enterMatched = (ticket: MatchTicket): void => {
    const roomId = ticket.roomId;
    if (!roomId) return;
    settle('matched');
    // The seat is reserved for this account: remember the room, then let the shell open it.
    props.ctx.setPendingInvite(roomId);
    void navigate({ to: '/', search: { room: roomId } });
  };

  const requeue = () => {
    if (destroyed || waiting()) return;
    // Anything the server already answered for the finished search is spent, never replayed.
    handled = ticketQuery.data ?? null;
    failure = ticketQuery.error ?? null;
    lastTicket = null;
    // A fresh search owns its matched answers again.
    suppressEntry = false;
    setStartedAt(Date.now());
    setElapsed(0);
    setError(null);
    setRetry(false);
    setStatus(null);
    setState('waiting');
    setPolling(true);
  };

  /**
   * The shared cancellation path. It stops polling and suppresses the matched
   * auto-entry synchronously, waits for the in-flight poll, then asks the
   * server to release the lease; only a server-confirmed release counts as
   * confirmed. A refusal means a started match already owns the seat: its
   * entry is restored exactly as a live poll would have entered it.
   */
  const requestCancel = async (): Promise<'confirmed' | 'refused' | 'failed'> => {
    suppressEntry = true;
    setPolling(false);
    try {
      const { cancelled } = await cancelMatch.mutateAsync();
      if (destroyed) return 'failed';
      if (!cancelled) {
        // The server refused: a started match already holds this account's seat.
        const ticket = lastTicket;
        if (ticket?.roomId) enterMatched(ticket);
        else settle('blocked', '已有对局开始，请返回原对局页面继续。');
        return 'refused';
      }
      setError(null);
      // A confirmed cancellation retires any reminder bound to the abandoned room.
      const abandonedRoom = lastTicket?.roomId;
      if (abandonedRoom) props.ctx.notifications.invalidateRoom(abandonedRoom);
      settle('cancelled');
      return 'confirmed';
    } catch (requestError) {
      if (destroyed) return 'failed';
      if (requestError instanceof DetailedError && requestError.statusCode === 401) {
        setPolling(false);
        props.ctx.handleAuthFailure('登录已过期，请重新登录。');
        return 'failed';
      }
      // The lease is unproven either way: keep the search alive and retryable,
      // and let a later matched answer navigate again.
      setError(messageOf(requestError, '取消匹配失败，请重试。'));
      setPolling(true);
      suppressEntry = false;
      return 'failed';
    }
  };

  const cancel = async () => {
    if (destroyed || cancelMatch.isPending) return;
    const outcome = await requestCancel();
    if (outcome === 'confirmed') toast('已取消匹配等待。', 'info');
  };

  // Every ticket the server hands back is a real answer to a poll this view started.
  createEffect(() => {
    const ticket = ticketQuery.data;
    if (!ticket || !waiting()) return;
    lastTicket = ticket;
    // A cancellation already owns this search's fate: an in-flight poll may
    // still deliver a matched answer, but it must not navigate on its own.
    if (suppressEntry || !polling() || ticket === handled) return;
    handled = ticket;
    if (ticket.state === 'matched' && ticket.roomId) {
      // A hidden page still gets its seat — remind before the navigation below.
      // Fire-and-forget: the reminder never delays (or fails) the navigation,
      // and only a seat still inside its reservation is worth a toast the
      // player can actually act on.
      if (Date.now() < ticket.expiresAt) {
        props.ctx.notifications
          .notify({
            kind: 'matched',
            roomId: ticket.roomId,
            matchId: null,
            expiresAt: ticket.expiresAt,
          })
          .catch(() => undefined);
      }
      enterMatched(ticket);
      return;
    }
    setError(null);
    setRetry(false);
    setStatus(null);
  });

  createEffect(() => {
    const requestError = ticketQuery.error;
    if (!requestError || requestError === failure) return;
    failure = requestError;
    if (!waiting()) return;
    if (requestError instanceof DetailedError && requestError.statusCode === 401) {
      setPolling(false);
      props.ctx.handleAuthFailure('登录已过期，请重新登录后再匹配。');
      return;
    }
    if (maintenanceCodeOf(requestError) !== null) {
      // The server durably admits no new matches right now: the search is
      // over for good here, and only a page after maintenance may queue again.
      settle('maintenance', messageOf(requestError, STATE_MESSAGES.maintenance));
      return;
    }
    if (requestError instanceof DetailedError && requestError.statusCode === 409) {
      setError(messageOf(requestError, '无法排队。'));
      settle('blocked');
      return;
    }
    setError(messageOf(requestError, '匹配请求失败，正在重试…'));
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
    elapsed,
    cancelPending: () => cancelMatch.isPending,
    cancel: () => void cancel(),
    requeue,
  };
}
