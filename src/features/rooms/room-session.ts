import { batch, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { parseResponse, DetailedError } from 'hono/client';
import { WS_PROTOCOL, MATCH_DURATION_MS } from '../../../shared/protocol';
import type { ClientMessage, Phase, RoomSnapshot } from '../../../shared/protocol';
import { client } from '../../app/client';
import type { AppContext } from '../../app/context';
import { profileOptions } from '../../app/queries';
import { RoomConnection, type ConnectionState } from './room-connection';
import { isProtocolRejection, type CloseInfo } from './room-wire';
import { messageOf, toast } from '../../ui/toast';
import type { TypingCommit } from './battle/typing';

/** Socket 断开时战斗面板展示的连接状态提示。 */
const CONNECTION_NOTICES: Record<'connecting' | 'reconnecting' | 'closed', string> = {
  connecting: '正在连接房间…',
  reconnecting: '连接中断，正在重连…对战计时不会暂停。',
  closed: '连接已关闭。',
};

/** 当服务端不再支持当前页面的协议版本时的唯一终态提示。 */
const UPDATE_REQUIRED = '客户端版本已更新，请刷新页面后继续。';

export interface RoomProblem {
  message: string;
  tone: 'warn' | 'error';
  /** 终态版本不匹配：唯一的修复办法是整页重新加载。 */
  reload?: boolean;
}

/**
 * 生成失败或结算提醒的有效送达期限：
 * 长到足以让玩家回到页面，短到足以代表「当下」。
 */
const REMINDER_WINDOW_MS = 60_000;

/**
 * 路由会保持上一个界面可见，直到初始房间读取结算完成。
 * `error` 涵盖当前构建已能证明无法进入的所有情况。
 */
export type RoomLoad = { snapshot: RoomSnapshot } | { error: unknown };

export interface RoomSession {
  snapshot(): RoomSnapshot | null;
  connection(): ConnectionState;
  /** 本地故障优先级高于房间自身的错误；两者共用同一条提示。 */
  problem(): RoomProblem | null;
  /** 当输入异常或 Socket 故障时，战斗面板展示的那一行提示。 */
  battleNotice(): string | null;
  /** 房间级界面重绘心跳；标签页隐藏时时钟仍继续运行。 */
  tick(): number;
  reconnectedMarker(): number;
  reservationRemainingMs(): number | null;
  send(message: ClientMessage, failureHint: string): void;
  commitInput(commit: TypingCommit): boolean;
  /**
   * 通过已鉴权的 HTTP 调用手动离场。仅在服务端提交离场、
   * 或确认席位已不存在之后才执行导航。失败时留在房间内以便重试；
   * 重复点击共用同一次请求。被顶替的窗口只做本地脱离，
   * 绝不释放此时已由其接替者控制的席位。
   */
  leaveRoom(destination?: '/' | '/match' | '/create'): Promise<void>;
  leavePending(): boolean;
  copyRoomId(): void;
}

/**
 * 单个房间的实时状态：权威快照输入，一条 Socket、一个时钟、一行故障提示。
 * 这里不负责渲染；各界面按房间保持挂载，
 * 因此快照绝不会销毁玩家正在输入的输入框。
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
  /** 自手动离场开始起为 true，直到其成功或失败。 */
  const [leaving, setLeaving] = createSignal(false);
  let replaced = false;
  /** 进行中的手动离场；重复点击共用它，失败即释放它。 */
  let leaveRequest: Promise<void> | null = null;
  let lastServerNow = 0;
  let persistenceWarned = false;
  let profileInvalidated = false;
  let timerId: number | null = null;
  /**
   * 本路由在其生命周期内已经离开过的对局（一次重赛替换了它们）。
   * 来自其中任何一场的迟到快照都会在下方被丢弃，
   * 无论其时钟说什么，因此旧对局绝不可能把显示切回去。
   */
  const exitedMatches = new Set<string>();

  const navigate = useNavigate();
  const selfId = () => props.ctx.session.user?.id ?? '';

  /** 由 4003 关闭与两种协议拒绝所共用的终态、只能刷新的状态。 */
  const setProtocolProblem = (): void => {
    setProblem({ message: UPDATE_REQUIRED, tone: 'error', reload: true });
    toast(UPDATE_REQUIRED, 'error');
  };

  /** 面板优先展示输入故障，其次才是 Socket 当前的状态。 */
  const battleNotice = createMemo(() => {
    const failedInput = inputNotice();
    if (failedInput) return failedInput;
    const state = connection();
    return state === 'open' || state === 'idle' ? null : CONNECTION_NOTICES[state];
  });

  /** 本地故障优先级高于房间自身的错误；两者共用同一条提示。 */
  const activeProblem = createMemo<RoomProblem | null>(() => {
    const local = problem();
    if (local) return local;
    const message = snapshot()?.error;
    return message ? { message, tone: 'error' } : null;
  });

  /**
   * 预留倒计时由房间自身的 tick 驱动重绘，
   * 使一次被放弃的快速匹配成为有解释的局面，而不是死路。
   */
  const reservationRemainingMs = createMemo(() => {
    void tick();
    const current = snapshot();
    if (!current || current.phase !== 'lobby' || current.reservationExpiresAt === null) return null;
    return current.reservationExpiresAt - props.ctx.clock.now();
  });

  const send = (message: ClientMessage, failureHint: string) => {
    if (leaving()) return;
    if (socket?.send(message)) return;
    toast(failureHint, 'warn');
    renderConnection(socket ? socket.currentState : 'closed');
  };

  /**
   * 输入只会为输入框所绑定的那个咒文身份转发：
   * 较旧的索引（某次施法被接受之后迟到的击键）会在此处被丢弃，
   * 而草稿代际与当前门槛所携带的值不一致的提交，按构造即为陈旧
   * （一次拒绝或恢复已经把草稿推进了）—— 会被静默丢弃，
   * 而不是伪造一次网络故障。代际来自控制器捕获的绑定，
   * 绝不从最新快照重新读取。
   */
  const commitInput = (commit: TypingCommit): boolean => {
    if (leaving()) return false;
    const current = snapshot();
    if (!current || current.matchId === null) return false;
    if (commit.matchId !== current.matchId) return false;
    if (current.phase !== 'playing') return false;
    const self = current.players.find((player) => player.id === selfId());
    if (!self || self.eliminatedAt !== null) return false;
    if (commit.spellIndex !== self.spellIndex) return false;
    const gate = current.selfInputGate;
    if (gate === null || commit.draftEpoch !== gate.draftEpoch) return false;
    const sent = socket?.send({
      type: 'input',
      matchId: commit.matchId,
      spellIndex: commit.spellIndex,
      draftEpoch: commit.draftEpoch,
      text: commit.text,
    });
    if (!sent) {
      setInputNotice('连接中断，本次输入尚未保存。重连后将恢复已保存的进度。');
      return false;
    }
    return true;
  };

  const copyRoomId = () => {
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(props.roomId).then(
        () => toast('房间 ID 已复制，发给朋友即可加入这个房间。', 'good'),
        () => toast('复制失败，请在房间信息中手动选择房间 ID 复制。', 'warn'),
      );
      return;
    }
    toast('复制失败，请在房间信息中手动选择房间 ID 复制。', 'warn');
  };

  /**
   * 手动离场会等待服务端确认：正是 `POST /api/rooms/:id/leave`
   * 提交了这次离场（弃掉进行中的对局、释放席位），
   * 因此导航、成功提示与邀请清理都在它之后才发生。
   * 响应丢失属于歧义状态：保留页面并提供幂等重试。
   * 服务端在提交离场时确实可能关闭这条 Socket，
   * 因此只抑制那一类关闭通知，而不抑制权威快照。
   */
  const leaveRoom = (destination: '/' | '/match' | '/create' = '/'): Promise<void> => {
    if (leaveRequest) return leaveRequest;
    if (replaced) {
      props.ctx.setPendingInvite(null);
      return navigate({ to: destination, search: {} });
    }
    const request = (async () => {
      setLeaving(true);
      // 离场已提交 —— 或已被证明无需提交，因为服务端本就不持有可提交的席位。
      // 随即脱离并前往所请求的目标位置。
      const departed = (): void => {
        // 路由可能已被销毁（玩家在请求进行中从别的途径离开了）：绝不导航一条已死的路由。
        if (closed) return;
        // 席位已不存在：任何绑定到该房间的提醒都不得比它存活更久。
        props.ctx.notifications.invalidateRoom(props.roomId);
        props.ctx.setPendingInvite(null);
        socket?.close();
        const quick = snapshot()?.mode === 'quick';
        toast(quick ? '已离开快速匹配房间，可以重新匹配。' : '已离开房间。', 'info');
        void navigate({ to: destination, search: {} });
      };
      try {
        await parseResponse(
          client.api.rooms[':roomId'].leave.$post({ param: { roomId: props.roomId } }),
        );
      } catch (error) {
        if (closed) return;
        if (error instanceof DetailedError && error.statusCode === 401) {
          setLeaving(false);
          leaveRequest = null;
          props.ctx.handleAuthFailure('登录状态已失效，请重新登录。');
          return;
        }
        if (error instanceof DetailedError && error.statusCode === 404) {
          // 房主确认已无席位留存；显式重试可以重新排队。
          departed();
          return;
        }
        // 一次被拒绝或丢失的离场请求并不能证明席位状态：房间保留该席位，
        // 显式重试仍然可用。
        setLeaving(false);
        leaveRequest = null;
        toast(messageOf(error, '未能确认离开房间，请重试。'), 'error');
        return;
      }
      // 席位已释放。
      departed();
    })();
    leaveRequest = request;
    return request;
  };

  function handleSnapshot(next: RoomSnapshot, reconnected: boolean, initial = false): void {
    if (closed) return;
    // 声明了另一种线协议的快照意味着当前页面已陈旧，即便 Socket 仍可用：
    // 进入终态的「需要更新」状态并停止连接 —— 任何触发器都不得将其重新打开。
    if (next.protocolVersion !== WS_PROTOCOL) {
      setProtocolProblem();
      socket?.close();
      return;
    }
    // 早于上一次已应用快照的旧快照（一次陈旧 HTTP 读取与实时 Socket 竞争）
    // 绝不能让显示倒退。
    const current = snapshot();
    if (
      !initial &&
      next.matchId !== null &&
      next.matchId !== current?.matchId &&
      exitedMatches.has(next.matchId)
    ) {
      return;
    }
    if (!initial && current && next.serverNow < lastServerNow) return;
    if (!initial && current && current.matchId === next.matchId) {
      const before = current.players.find((player) => player.id === selfId());
      const after = next.players.find((player) => player.id === selfId());
      if (before && after) {
        if (after.spellIndex < before.spellIndex) return;
        if (
          after.spellIndex === before.spellIndex &&
          current.selfInputGate &&
          next.selfInputGate &&
          next.selfInputGate.draftEpoch < current.selfInputGate.draftEpoch
        )
          return;
      }
    }
    lastServerNow = next.serverNow;
    if (!initial && current && current.matchId !== null && current.matchId !== next.matchId) {
      exitedMatches.add(current.matchId);
    }

    batch(() => {
      setSnapshot(next);
      if (reconnected) setReconnectedMarker((marker) => marker + 1);
    });
    props.ctx.clock.sync(next.serverNow);
    if (initial) {
      props.ctx.setPendingInvite(next.id);
    }
    if (!initial && !reconnected) {
      // `current` 在批处理之前读取：它就是上一次实时快照所显示的阶段。
      notifyTransition(current?.phase ?? null, current?.matchId ?? null, next);
    }

    if (next.phase !== 'finished') {
      // 一场新对局（或重赛）会让两个一次性效果重新武装。
      persistenceWarned = false;
      profileInvalidated = false;
    } else if (next.persistence === 'error' && !persistenceWarned) {
      persistenceWarned = true;
      toast('战绩暂未保存，正在自动重试。本场结果不受影响。', 'warn');
    } else if (next.persistence === 'saved' && !profileInvalidated) {
      // 已结算的记录现在存在：资料页自身的查询必须重新拉取。
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

  /**
   * 两份实时快照之间真实的阶段跃迁是唯一的通知来源。
   * 初始读取与重连回放绝不会走到这里：历史不得变成提醒。
   * 发射后即忘 —— 绝不 await，也绝不阻塞派生本状态的快照。
   */
  function notifyTransition(
    prevPhase: Phase | null,
    prevMatchId: string | null,
    next: RoomSnapshot,
  ): void {
    if (prevPhase === null || prevPhase === next.phase) return;
    if (
      prevPhase === 'generating' &&
      next.phase === 'countdown' &&
      next.matchId !== null &&
      next.matchId === prevMatchId
    ) {
      void props.ctx.notifications
        .notify({
          kind: 'countdown',
          roomId: next.id,
          matchId: next.matchId,
          expiresAt: next.deadline + MATCH_DURATION_MS,
        })
        .catch(() => undefined);
      return;
    }
    if (prevPhase === 'generating' && next.phase === 'lobby' && next.error !== null) {
      // 本次尝试所属的对局由上一份快照确定。
      void props.ctx.notifications
        .notify({
          kind: 'generation-failed',
          roomId: next.id,
          matchId: prevMatchId,
          expiresAt: next.serverNow + REMINDER_WINDOW_MS,
        })
        .catch(() => undefined);
      return;
    }
    if (
      (prevPhase === 'generating' || prevPhase === 'countdown' || prevPhase === 'playing') &&
      next.phase === 'finished' &&
      next.matchId !== null &&
      next.matchId === prevMatchId
    ) {
      void props.ctx.notifications
        .notify({
          kind: 'finished',
          roomId: next.id,
          matchId: next.matchId,
          expiresAt: next.serverNow + REMINDER_WINDOW_MS,
        })
        .catch(() => undefined);
    }
  }

  function handleClosed(info: CloseInfo): void {
    // 手动离场拥有这条 Socket 的结束过程：服务端在请求提交时拆除席位，
    // 这一切都不是需要上报的连接故障。
    if (closed || leaving()) return;
    if (info.authExpired) {
      props.ctx.handleAuthFailure('登录状态已失效，请重新登录。');
      return;
    }
    if (info.replaced) {
      replaced = true;
      // 另一个窗口现在拥有该席位；本页面的提醒已陈旧。
      props.ctx.notifications.invalidateRoom(props.roomId);
      const message = '这个账号的房间连接已被另一个窗口接管，本窗口不再操作该席位。';
      setProblem({ message, tone: 'warn' });
      toast(message, 'warn');
      return;
    }
    if (info.roomClosed) {
      props.ctx.notifications.invalidateRoom(props.roomId);
      const message =
        activeProblem()?.message ?? '房间已关闭或不再接受你加入（可能已经开始或结束）。';
      setProblem({ message, tone: 'error' });
      toast(message, 'error');
      return;
    }
    if (info.protocolMismatch) {
      // 连接本身已经死亡且绝不会重新打开：
      // 把唯一可用的修复办法表达得一目了然。
      setProtocolProblem();
      return;
    }
    if (info.inputOverload) {
      // 这不是永久性问题：已保存的输入会随重连恢复，
      // 而 `renderConnection` 会在 Socket 重新打开后清除这条提示。
      setInputNotice('输入消息过于密集，连接已重置；正在恢复已保存的输入。');
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
      socket.close();
      if (loaded.error instanceof DetailedError && loaded.error.statusCode === 401) {
        props.ctx.handleAuthFailure('登录已过期，请重新登录后再进入房间。');
        return;
      }
      if (isProtocolRejection(loaded.error)) {
        setProtocolProblem();
        return;
      }
      showFatal(loaded.error);
      return;
    }
    handleSnapshot(loaded.snapshot, false, true);
    socket.open();
    timerId = window.setInterval(() => {
      // 标签页隐藏时时钟仍继续运行；只有重绘被跳过。
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
    leavePending: leaving,
    copyRoomId,
  };
}
