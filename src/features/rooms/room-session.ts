import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { parseResponse, DetailedError } from 'hono/client';
import type { ClientMessage, RoomSnapshot } from '../../../shared/protocol';
import { client } from '../../app/client';
import type { AppContext } from '../../app/context';
import { profileOptions } from '../../app/queries';
import { RoomConnection, type ConnectionState } from './room-connection';
import type { CloseInfo } from './room-wire';
import { messageOf, toast } from '../../ui/toast';
import type { TypingCommit } from './battle/typing';

/** What the combat panel says while the socket is down. */
const CONNECTION_NOTICES: Record<'connecting' | 'reconnecting' | 'closed', string> = {
  connecting: '正在连接房间…',
  reconnecting: '连接中断，正在重连…对战计时不会暂停。',
  closed: '连接已关闭。',
};

export interface RoomProblem {
  message: string;
  tone: 'warn' | 'error';
}

/** The route keeps the previous screen visible until the initial room read settles. */
export type RoomLoad = { snapshot: RoomSnapshot } | { error: unknown };

export interface RoomSession {
  snapshot(): RoomSnapshot | null;
  connection(): ConnectionState;
  /** A local failure outranks the room's own error; both live in one notice. */
  problem(): RoomProblem | null;
  /** The one line the combat panel shows while an input or the socket failed. */
  battleNotice(): string | null;
  /** Room-level repaint heartbeat; the clock keeps running while a tab is hidden. */
  tick(): number;
  reconnectedMarker(): number;
  reservationRemainingMs(): number | null;
  send(message: ClientMessage, failureHint: string): void;
  commitInput(commit: TypingCommit): boolean;
  /**
   * Manual leave over an authenticated HTTP call. Resolves only after the server
   * committed the departure (forfeit inside a live match, seat release before it);
   * rejects honestly — with the player still in the room — when nothing was
   * committed. Duplicate clicks while a request is in flight share one request.
   */
  leaveRoom(): Promise<void>;
  copyInvite(): void;
}

/**
 * One room's live state: authoritative snapshots in, one socket, one clock, one
 * problem line. Nothing here renders; the surfaces stay mounted per room so a
 * snapshot can never destroy the field a player is typing into.
 */
export function createRoomSession(props: {
  roomId: string;
  ctx: AppContext;
  initial: RoomLoad;
}): RoomSession {
  const loaded = props.initial;
  const [snapshot, setSnapshot] = createSignal<RoomSnapshot | null>(
    'snapshot' in loaded ? loaded.snapshot : null,
  );
  const [reconnectedMarker, setReconnectedMarker] = createSignal(0);
  const [connection, setConnection] = createSignal<ConnectionState>('idle');
  const [inputNotice, setInputNotice] = createSignal<string | null>(null);
  const [problem, setProblem] = createSignal<RoomProblem | null>(null);
  const [tick, setTick] = createSignal(0);

  let socket: RoomConnection | null = null;
  let closed = false;
  /** True from the moment a manual leave starts until it succeeds or fails. */
  let leaving = false;
  /** In-flight manual leave; duplicate clicks share it, a failure releases it. */
  let leaveRequest: Promise<void> | null = null;
  let lastServerNow = 0;
  let persistenceWarned = false;
  let profileInvalidated = false;
  let timerId: number | null = null;

  const navigate = useNavigate();
  const selfId = () => props.ctx.session.user?.id ?? '';

  /** The panel shows an input failure first, then whatever the socket is doing. */
  const battleNotice = createMemo(() => {
    const failedInput = inputNotice();
    if (failedInput) return failedInput;
    const state = connection();
    return state === 'open' || state === 'idle' ? null : CONNECTION_NOTICES[state];
  });

  /** A local failure outranks the room's own error; both live in one notice. */
  const activeProblem = createMemo<RoomProblem | null>(() => {
    const local = problem();
    if (local) return local;
    const message = snapshot()?.error;
    return message ? { message, tone: 'error' } : null;
  });

  /**
   * The reservation countdown is repainted by the room's own tick, so an
   * abandoned quick match is an explained situation rather than a dead end.
   */
  const reservationRemainingMs = createMemo(() => {
    void tick();
    const current = snapshot();
    if (!current || current.phase !== 'lobby' || current.reservationExpiresAt === null) return null;
    return current.reservationExpiresAt - props.ctx.clock.now();
  });

  const send = (message: ClientMessage, failureHint: string) => {
    if (leaving) return;
    if (socket?.send(message)) return;
    toast(failureHint, 'warn');
    renderConnection(socket ? socket.currentState : 'closed');
  };

  /**
   * Input is only ever forwarded for the spell index the field is bound to: a
   * commit for an older index (a late keystroke after a cast was accepted) is
   * dropped here, and the room rejects anything else as stale.
   */
  const commitInput = (commit: TypingCommit): boolean => {
    if (leaving) return false;
    const current = snapshot();
    if (!current || current.matchId === null) return false;
    if (commit.matchId !== current.matchId) return false;
    if (current.phase !== 'playing') return false;
    const self = current.players.find((player) => player.id === selfId());
    if (!self || self.eliminatedAt !== null) return false;
    if (commit.spellIndex !== self.spellIndex) return false;
    const sent = socket?.send({
      type: 'input',
      matchId: commit.matchId,
      spellIndex: commit.spellIndex,
      text: commit.text,
    });
    if (!sent) {
      setInputNotice('连接中断，本次输入尚未保存。重连后将恢复已保存的进度。');
      return false;
    }
    return true;
  };

  const copyInvite = () => {
    const url = props.ctx.inviteUrl(props.roomId);
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(url).then(
        () => toast('邀请链接已复制，发给朋友即可进入这个房间。', 'good'),
        () => toast(`请手动复制邀请链接：${url}`, 'warn'),
      );
      return;
    }
    toast(`请手动复制邀请链接：${url}`, 'warn');
  };

  /**
   * Manual leave waits for the server's own acknowledgment: `POST /api/rooms/:id/leave`
   * is what commits the departure (forfeiting a live match, releasing a seat), so
   * navigation, the success toast and the invite cleanup happen only after it. A
   * lost response is ambiguous: keep the page and offer an idempotent retry.
   * The server may legitimately close this socket while committing departure,
   * so suppress only that close notification, not authoritative snapshots.
   */
  const leaveRoom = (): Promise<void> => {
    if (leaveRequest) return leaveRequest;
    const request = (async () => {
      leaving = true;
      try {
        await parseResponse(
          client.api.rooms[':roomId'].leave.$post({ param: { roomId: props.roomId } }),
        );
      } catch (error) {
        // A transport error cannot tell whether departure committed. Keep live
        // snapshots flowing and allow the same idempotent request to be retried.
        leaving = false;
        leaveRequest = null;
        if (closed) return;
        if (error instanceof DetailedError && error.statusCode === 401) {
          props.ctx.handleAuthFailure('登录状态已失效，请重新登录。');
          return;
        }
        toast(messageOf(error, '未能确认离开房间，请重试。'), 'error');
        return;
      }
      // The departure is durable. The route may already be disposed (the player
      // left some other way mid-request): never navigate a dead route.
      if (closed) return;
      props.ctx.setPendingInvite(null);
      socket?.close();
      const quick = snapshot()?.mode === 'quick';
      toast(quick ? '已离开快速匹配房间，可以重新匹配。' : '已离开房间。', 'info');
      void navigate({ to: '/', search: {} });
    })();
    leaveRequest = request;
    return request;
  };

  function handleSnapshot(next: RoomSnapshot, reconnected: boolean, initial = false): void {
    if (closed) return;
    // A snapshot older than the last one applied (a stale HTTP read racing a
    // live socket) must never move the display backwards.
    const current = snapshot();
    if (!initial && current && next.serverNow < lastServerNow) return;
    lastServerNow = next.serverNow;

    batch(() => {
      setSnapshot(next);
      if (reconnected) setReconnectedMarker((marker) => marker + 1);
    });
    props.ctx.clock.sync(next.serverNow);
    if (initial) {
      props.ctx.setPendingInvite(next.id);
    }

    if (next.phase !== 'finished') {
      // A new match (or a rematch) arms both one-shot effects again.
      persistenceWarned = false;
      profileInvalidated = false;
    } else if (next.persistence === 'error' && !persistenceWarned) {
      persistenceWarned = true;
      toast('战绩暂未保存，正在自动重试。本场结果不受影响。', 'warn');
    } else if (next.persistence === 'saved' && !profileInvalidated) {
      // The settled record now exists: the profile's own query must refetch.
      profileInvalidated = true;
      const userId = selfId();
      if (userId) {
        void props.ctx.queryClient.invalidateQueries({ queryKey: profileOptions(userId).queryKey });
      }
    }

    if (reconnected) toast('已重新连接，进度已恢复。', 'good');
  }

  function renderConnection(state: ConnectionState): void {
    setConnection(state);
    if (state === 'open') setInputNotice(null);
    props.ctx.setRoomConnection(state);
  }

  function handleClosed(info: CloseInfo): void {
    // A manual leave owns this socket's end: the server tears the seat down as
    // the request commits, and none of that is a connection failure to report.
    if (closed || leaving) return;
    if (info.authExpired) {
      props.ctx.handleAuthFailure('登录状态已失效，请重新登录。');
      return;
    }
    if (info.replaced) {
      const message = '这个账号的房间连接已被另一个窗口接管，本窗口不再操作该席位。';
      setProblem({ message, tone: 'warn' });
      toast(message, 'warn');
      return;
    }
    if (info.roomClosed) {
      const message =
        activeProblem()?.message ?? '房间已关闭或不再接受你加入（可能已经开始或结束）。';
      setProblem({ message, tone: 'error' });
      toast(message, 'error');
      return;
    }
    const phase = snapshot()?.phase;
    if (phase === 'playing' || phase === 'countdown') {
      toast('连接中断，正在重连。对战计时不会暂停。', 'warn');
    }
  }

  function showFatal(error: unknown): void {
    const message = messageOf(error, '无法进入这个房间。');
    setProblem({ message, tone: 'error' });
    toast(message, 'error');
    props.ctx.setPendingInvite(null);
  }

  onMount(() => {
    socket = new RoomConnection(props.roomId, {
      onSnapshot: (next, meta) => handleSnapshot(next, meta.reconnected),
      onServerError: (message) => toast(message, 'error'),
      onServerNow: (serverNow) => props.ctx.clock.sync(serverNow),
      onState: (state) => renderConnection(state),
      onClosed: (info) => handleClosed(info),
      onReconnectAttempt: () => renderConnection('reconnecting'),
    });

    if ('error' in loaded) {
      if (loaded.error instanceof DetailedError && loaded.error.statusCode === 401) {
        props.ctx.handleAuthFailure('登录已过期，请重新登录后再进入房间。');
      } else {
        showFatal(loaded.error);
      }
      return;
    }
    handleSnapshot(loaded.snapshot, false, true);
    socket.open();
    timerId = window.setInterval(() => {
      // The clock keeps running while a tab is hidden; only the repaint is skipped.
      if (closed || document.visibilityState === 'hidden') return;
      setTick((value) => value + 1);
    }, 100);
  });

  onCleanup(() => {
    closed = true;
    if (timerId !== null) window.clearInterval(timerId);
    timerId = null;
    socket?.destroy();
    socket = null;
    props.ctx.setRoomConnection('idle');
  });

  return {
    snapshot,
    connection,
    problem: activeProblem,
    battleNotice,
    tick,
    reconnectedMarker,
    reservationRemainingMs,
    send,
    commitInput,
    leaveRoom,
    copyInvite,
  };
}
