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
/** 在等待提示文案中逐字引用，确保对用户的承诺时间与 `QUICK_GHOST_FALLBACK_MS` 完全一致。 */
const GHOST_FALLBACK_SECONDS = QUICK_GHOST_FALLBACK_MS / 1000;

/** 匹配搜索所处的状态。只有 `waiting` 表示处于活跃的搜索状态。 */
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
  /** 真实的排队等待耗时，且在搜索结束的瞬间停止计时。 */
  elapsed(): number;
  cancelPending(): boolean;
  cancel(): void;
  requeue(): void;
}

/**
 * 匹配租约及其统一步调的时钟。
 *
 * 排队在服务端被建模为一个由服务端持有的租约：轮询本身*同时*作为续租请求，
 * 因此每个状态均来自真实的往返网络请求（`POST /api/match` 会刷新票据的过期时间）。
 * 因此将其实现为带有 `refetchInterval` 的查询，而非手动封装的计时器——
 * 但它绝不能使用缓存数据，且必须在搜索结束时立即停止。匹配成功的入场券代表该账户在当前服务器上预留的席位：
 * 外层壳组件会在原地打开该房间。
 */
export function createMatchQueue(props: { ctx: AppContext }): MatchQueue {
  const navigate = useNavigate();
  let destroyed = false;
  let pendingPoll: Promise<MatchTicket> | undefined;
  /** 服务端返回的上一张入场券；若对局已开始，则会导致取消匹配被拒绝。 */
  let lastTicket: MatchTicket | null = null;
  /** 上次已经渲染过的入场券数据，避免副作用重复执行导致重复渲染。 */
  let handled: MatchTicket | null = null;
  /** 在取消逻辑裁决搜索结果期间置位：禁止触发自动进入对局。 */
  let suppressEntry = false;
  let failure: unknown = null;

  const [state, setState] = createSignal<QueueState>('waiting');
  /** 明确的状态文本（重试提示，或导致搜索终止的拒绝原因）。 */
  const [status, setStatus] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [retry, setRetry] = createSignal(false);
  const [polling, setPolling] = createSignal(true);
  const [startedAt, setStartedAt] = createSignal(Date.now());
  const [elapsed, setElapsed] = createSignal(0);

  const waiting = () => state() === 'waiting';

  // 唯一的时钟依据是实际流逝的排队等待时间，且在搜索结束的瞬间停止计时。
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
     * 入场券仅作为对新鲜轮询请求的应答时才有效：排队项是服务端按次延期的租约，
     * 且已开始的对局会在同一轮询中返回 `matched` 及其预留的房间号。
     * 缓存或自动重试的响应会导致展示无人请求的旧状态，因此本查询既不复用数据
     * （`staleTime`/`gcTime` 均为 0），也不自行重复失败调用（`retry: false`）——
     * 服务端响应缓慢时会在下次轮询时以半速降频重试，与状态提示行所描述的完全一致。
     */
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: true,
    refetchInterval: () => (retry() ? POLL_INTERVAL_MS * 2 : POLL_INTERVAL_MS),
  }));

  // 取消网络请求（abort）无法撤销服务端的排队状态；须等待请求结算后调用接口取消。
  const cancelLease = async () => {
    await pendingPoll?.catch(() => undefined);
    return parseResponse(client.api.match.$delete());
  };
  const cancelMatch = useMutation(() => ({ mutationFn: cancelLease }));

  /** 统一定格一种状态：设置状态提示行、操作提示文案及可用操作。 */
  const settle = (next: QueueState, override?: string) => {
    setPolling(false);
    setElapsed(Date.now() - startedAt());
    setStatus(override ?? null);
    setState(next);
    setRetry(false);
  };

  /** 进入匹配成功的席位：座位已在当前服务器上为该账户预留。 */
  const enterMatched = (ticket: MatchTicket): void => {
    const roomId = ticket.roomId;
    if (!roomId) return;
    settle('matched');
    // 席位已为当前账户预留：记下房间号，交由外层壳组件打开。
    props.ctx.setPendingInvite(roomId);
    void navigate({ to: '/', search: { room: roomId } });
  };

  const requeue = () => {
    if (destroyed || waiting()) return;
    // 服务端针对已结束搜索返回的任何数据均已作废，绝不回放。
    handled = ticketQuery.data ?? null;
    failure = ticketQuery.error ?? null;
    lastTicket = null;
    // 开启新的搜索，重新接收匹配成功的响应。
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
   * 取消匹配的通用路径。同步停止轮询并抑制匹配成功后的自动进入，
   * 等待正在进行的网络请求完成，然后请求服务端释放租约；
   * 只有经服务端确认的释放才算取消成功。若被拒绝，说明对局已开始并占用了席位：
   * 此时恢复其席位进入逻辑，与正常轮询接收到匹配结果的表现完全一致。
   */
  const requestCancel = async (): Promise<'confirmed' | 'refused' | 'failed'> => {
    suppressEntry = true;
    setPolling(false);
    try {
      const { cancelled } = await cancelMatch.mutateAsync();
      if (destroyed) return 'failed';
      if (!cancelled) {
        // 服务端拒绝取消：已开启的对局已经锁定了当前账户的席位。
        const ticket = lastTicket;
        if (ticket?.roomId) enterMatched(ticket);
        else settle('blocked', '已有对局开始，请返回原对局页面继续。');
        return 'refused';
      }
      setError(null);
      // 取消确认后，清理与已废弃房间绑定的所有事件提醒。
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
      // 租约状态未决（既未成功释放也未被确认占用）：保持搜索状态并允许重试，
      // 后续若收到匹配成功响应仍可正常导航进入对局。
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

  // 服务端返回的每张入场券都是对本视图发起的轮询的真实响应。
  createEffect(() => {
    const ticket = ticketQuery.data;
    if (!ticket || !waiting()) return;
    lastTicket = ticket;
    // 取消流程已经在掌控本次搜索的结局：在途的轮询可能仍会返回匹配成功，
    // 但绝不能再自行触发页面跳转。
    if (suppressEntry || !polling() || ticket === handled) return;
    handled = ticket;
    if (ticket.state === 'matched' && ticket.roomId) {
      // 即使页面处于隐藏状态也已为其锁定席位——在执行下方跳转前发送提醒。
      // 触发即忘：提醒绝不阻塞（亦不影响）页面跳转，
      // 且只有仍处于预留有效期内的席位才值得向玩家推送可操作的 Toast。
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
      // 服务端当前持久化拒绝新对局准入：当前搜索彻底终止，
      // 必须等到维护结束后的页面方可重新排队。
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
    // 离开视图时必须释放匹配席位；此后严禁继续轮询。
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
