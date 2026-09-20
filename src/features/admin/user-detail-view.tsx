import { For, Show, createSignal } from 'solid-js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import { parseResponse } from 'hono/client';
import {
  MAX_BAN_DURATION_MS,
  type AdminResult,
  type AdminUser,
  type AdminUserDetail,
} from '../../../shared/admin';
import { adminUserOptions } from './queries';
import { client } from '../../app/client';
import { messageOf, toast } from '../../ui/toast';
import {
  AdminEmpty,
  AdminHeading,
  AdminMatchLink,
  AdminPagination,
  AdminPanel,
  AdminQueryState,
  AdminStat,
  formatDate,
  formatNumber,
  formatPercent,
} from './common';
import {
  BanBadge,
  BookTheme,
  DetailItem,
  OpponentBadge,
  PhaseBadge,
  RankBadge,
  RoleBadge,
} from './views.shared';
import { formatAmount, formatDuration } from '../../ui/format';
import { adminStyles, commonStyles } from './admin.styles';
import { ui } from '../../ui/primitives';

/**
 * 账号详情：注册信息与会话概况、全部战绩汇总、当前所在房间，
 * 以及服务端分页的对局历史（含名次、准确率、CPM、伤害、施法与用时）。
 * 账号信息同时展示封禁状态；封禁控制面板允许对其发起永久或限时封禁。
 */
export function AdminUserDetailView(props: {
  userId: () => string;
  page: () => number;
  onPage: (page: number) => void;
}) {
  const query = useQuery(() => adminUserOptions(props.userId(), props.page()));
  return (
    <div class={stylex.props(adminStyles.stack).className} data-testid="view-admin-user-detail">
      <AdminQueryState query={query}>
        <Show when={query.data} keyed>
          {(data) => (
            <>
              <AdminHeading
                title={data.user.username}
                description="账号的注册信息、战绩汇总、对局历史与封禁控制。"
              />
              <UserDetailBody data={data} onPage={props.onPage} />
            </>
          )}
        </Show>
      </AdminQueryState>
    </div>
  );
}

function UserDetailBody(props: { data: AdminUserDetail; onPage: (page: number) => void }) {
  const stats = props.data.stats;
  const statTiles = [
    { key: 'games', label: '完成对局', value: formatNumber(stats.games) },
    { key: 'wins', label: '胜场（第 1 名）', value: formatNumber(stats.wins) },
    { key: 'bestCpm', label: '最佳速度 · 字/分', value: formatNumber(stats.bestCpm) },
    { key: 'averageCpm', label: '平均速度 · 字/分', value: formatNumber(stats.averageCpm) },
    { key: 'averageAccuracy', label: '平均准确率', value: formatPercent(stats.averageAccuracy) },
    { key: 'damageDealt', label: '累计伤害', value: formatNumber(stats.damageDealt) },
    { key: 'spellsCast', label: '累计施法', value: formatNumber(stats.spellsCast) },
    { key: 'correctChars', label: '正确字符', value: formatNumber(stats.correctChars) },
    { key: 'durationMs', label: '累计战斗时长', value: formatDuration(stats.durationMs) },
    { key: 'lastPlayedAt', label: '最近对局', value: formatDate(stats.lastPlayedAt) },
  ] as const;
  return (
    <>
      <AdminPanel title="账号信息">
        <dl class={stylex.props(adminStyles.details).className} data-testid="admin-user-info">
          <DetailItem label="用户名">{props.data.user.username}</DetailItem>
          <DetailItem label="用户 ID">
            <span class={stylex.props(adminStyles.mono).className}>{props.data.user.id}</span>
          </DetailItem>
          <DetailItem label="角色">
            <RoleBadge role={props.data.user.role} />
          </DetailItem>
          <DetailItem label="封禁状态">
            <BanBadge ban={props.data.user.ban} />
          </DetailItem>
          <Show when={props.data.user.ban?.expiresAt} keyed>
            {(expiresAt) => (
              <DetailItem label="解封时间">
                <span class={stylex.props(adminStyles.mono).className}>
                  {formatDate(expiresAt)}
                </span>
              </DetailItem>
            )}
          </Show>
          <DetailItem label="注册时间">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatDate(props.data.user.createdAt)}
            </span>
          </DetailItem>
          <DetailItem label="活跃会话">{formatNumber(props.data.activeSessions)}</DetailItem>
          <DetailItem label="归档幻影轨迹">{formatNumber(props.data.ghostCount)}</DetailItem>
        </dl>
      </AdminPanel>

      <BanPanel user={props.data.user} />

      <AdminPanel title="战绩汇总">
        <div class={stylex.props(adminStyles.grid).className} data-testid="admin-user-stats">
          <For each={statTiles}>
            {(tile) => <AdminStat label={tile.label} value={tile.value} />}
          </For>
        </div>
      </AdminPanel>

      <AdminPanel title="当前房间">
        <Show
          when={props.data.activeRoom}
          fallback={
            <p class={stylex.props(adminStyles.muted).className}>该账号当前不在任何房间中。</p>
          }
          keyed
        >
          {(room) => (
            <dl class={stylex.props(adminStyles.details).className} data-testid="admin-user-room">
              <DetailItem label="房间 ID">
                <span class={stylex.props(adminStyles.mono).className}>{room.roomId}</span>
              </DetailItem>
              <DetailItem label="对局">
                <Show
                  when={room.matchId}
                  fallback={
                    <span class={stylex.props(adminStyles.muted).className}>尚未开始对局</span>
                  }
                  keyed
                >
                  {(matchId) => <AdminMatchLink id={matchId} />}
                </Show>
              </DetailItem>
              <DetailItem label="阶段">
                <PhaseBadge phase={room.phase} />
              </DetailItem>
              <DetailItem label="主题">
                <BookTheme theme={room.theme} />
              </DetailItem>
            </dl>
          )}
        </Show>
      </AdminPanel>

      <AdminPanel title="对局历史">
        <AdminPagination
          page={props.data.history.page}
          total={props.data.history.total}
          pageSize={props.data.history.pageSize}
          onPage={props.onPage}
        />
        <Show
          when={props.data.history.items.length > 0}
          fallback={<AdminEmpty>该账号还没有已保存的对局记录。</AdminEmpty>}
        >
          <div class={stylex.props(adminStyles.tableWrap).className}>
            <table
              class={stylex.props(adminStyles.table).className}
              data-testid="admin-user-history"
            >
              <thead>
                <tr>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    对局
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    名次
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    主题
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    对手类型
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    速度 · 字/分
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    准确率
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    伤害
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    施法
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    用时
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    记录时间
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.data.history.items}>
                  {(result) => <HistoryCells result={result} />}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </AdminPanel>
    </>
  );
}

/** 限时封禁的可选时间单位：标签与毫秒换算同源；自定义时长受共享上限约束。 */
const BAN_UNITS = {
  hours: { label: '小时', ms: 3_600_000 },
  days: { label: '天', ms: 24 * 3_600_000 },
} as const;
type BanUnit = keyof typeof BAN_UNITS;

/** 待确认的封禁意图：打开确认时冻结目标与时长，之后的表单改动不影响将提交的内容。 */
interface BanConfirmation {
  userId: string;
  username: string;
  durationMs: number | null;
  durationText: string;
}

/**
 * 封禁控制：选择永久或限时封禁，在提交前确认目标与时长。
 * 管理员账号在界面层即拒绝操作，避免锁死管理后台；服务端仍是最终裁决（409）。
 * 封禁立即生效并整体覆盖已有封禁；成功后使详情、用户列表与总览缓存失效。
 * 操作失败的就地展示不依赖全局提示，便于对照表单修正后重试。
 */
function BanPanel(props: { user: AdminUser }) {
  const queryClient = useQueryClient();
  const [permanent, setPermanent] = createSignal(true);
  const [amount, setAmount] = createSignal('1');
  const [unit, setUnit] = createSignal<BanUnit>('days');
  const [confirming, setConfirming] = createSignal<BanConfirmation | null>(null);

  const customMs = () => {
    if (permanent()) return null;
    const value = Number(amount());
    if (!Number.isInteger(value) || value <= 0) return null;
    const ms = value * BAN_UNITS[unit()].ms;
    return ms > MAX_BAN_DURATION_MS ? null : ms;
  };
  const durationValid = () => permanent() || customMs() !== null;

  /** 确认即冻结：将此刻的目标与时长固化为待提交意图，确认框展示与提交共用同一份数据。 */
  const openConfirmation = () => {
    const durationMs = permanent() ? null : customMs();
    if (durationMs === null && !permanent()) return;
    setConfirming({
      userId: props.user.id,
      username: props.user.username,
      durationMs,
      durationText:
        permanent() || durationMs === null
          ? '永久'
          : `${Number(amount())} ${BAN_UNITS[unit()].label}`,
    });
  };

  const ban = useMutation(() => ({
    mutationFn: async (intent: BanConfirmation) =>
      parseResponse(
        client.api.admin.users[':userId'].ban.$post({
          param: { userId: intent.userId },
          json: { durationMs: intent.durationMs },
        }),
      ),
    onSuccess: (result, intent) => {
      toast(
        result.ban.expiresAt === null
          ? `已对 ${intent.username} 执行永久封禁。`
          : `已封禁 ${intent.username}，到期后将自动解封。`,
        'good',
      );
      setConfirming(null);
      setAmount('1');
    },
    onError: () => setConfirming(null),
    onSettled: (_data, _error, intent) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin', 'user', intent.userId] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
        queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] }),
      ]),
  }));

  return (
    <AdminPanel title="封禁控制">
      <Show
        when={props.user.role !== 'admin'}
        fallback={
          <p class={stylex.props(adminStyles.muted).className} data-testid="admin-ban-admin-guard">
            管理员账号不可被封禁，以避免管理后台失去访问权限。
          </p>
        }
      >
        <p class={stylex.props(adminStyles.muted).className}>
          封禁立即生效：该账号将无法参与对战、匹配或进入房间，仅保留登录状态查询与退出登录。
          再次封禁会整体覆盖当前封禁。
        </p>
        <div
          class={stylex.props(commonStyles.actions).className}
          role="group"
          aria-label="封禁类型"
        >
          <button
            type="button"
            class={stylex.props(ui.chip, permanent() ? ui.chipSelected : null).className}
            aria-pressed={permanent()}
            disabled={confirming() !== null}
            data-testid="admin-ban-permanent"
            onClick={() => setPermanent(true)}
          >
            永久封禁
          </button>
          <button
            type="button"
            class={stylex.props(ui.chip, !permanent() ? ui.chipSelected : null).className}
            aria-pressed={!permanent()}
            disabled={confirming() !== null}
            data-testid="admin-ban-timed"
            onClick={() => setPermanent(false)}
          >
            限时封禁
          </button>
        </div>
        <Show when={!permanent()}>
          <div class={stylex.props(commonStyles.actions).className}>
            <label class={stylex.props(ui.field).className}>
              <span class={stylex.props(ui.label).className}>时长</span>
              <input
                type="number"
                min={1}
                max={Math.floor(MAX_BAN_DURATION_MS / BAN_UNITS[unit()].ms)}
                step={1}
                value={amount()}
                disabled={confirming() !== null}
                data-testid="admin-ban-amount"
                onInput={(event) => setAmount(event.currentTarget.value)}
                class={stylex.props(ui.input).className}
              />
            </label>
            <label class={stylex.props(ui.field).className}>
              <span class={stylex.props(ui.label).className}>单位</span>
              <select
                value={unit()}
                disabled={confirming() !== null}
                data-testid="admin-ban-unit"
                onChange={(event) => setUnit(event.currentTarget.value as BanUnit)}
                class={stylex.props(ui.select).className}
              >
                <For each={Object.entries(BAN_UNITS)}>
                  {([value, config]) => <option value={value}>{config.label}</option>}
                </For>
              </select>
            </label>
          </div>
          <Show when={!durationValid()}>
            <p class={stylex.props(ui.hint).className}>
              请输入 1 起的整数时长，且不超过封禁时长上限。
            </p>
          </Show>
        </Show>
        <Show
          when={confirming()}
          keyed
          fallback={
            <div class={stylex.props(commonStyles.actions).className}>
              <button
                type="button"
                class={stylex.props(ui.button, ui.danger).className}
                data-testid="admin-ban-submit"
                disabled={!durationValid() || ban.isPending}
                onClick={openConfirmation}
              >
                封禁账号
              </button>
            </div>
          }
        >
          {(intent) => (
            <div
              class={stylex.props(ui.panel).className}
              role="alert"
              data-testid="admin-ban-confirm"
            >
              <p>
                确认封禁 {intent.username}（{intent.userId}）：{intent.durationText}
                ？此操作立即生效。
              </p>
              <div class={stylex.props(commonStyles.actions).className}>
                <button
                  type="button"
                  class={stylex.props(ui.button, ui.danger).className}
                  data-testid="admin-ban-confirm-accept"
                  disabled={ban.isPending}
                  onClick={() => ban.mutate(intent)}
                >
                  {ban.isPending ? '正在封禁…' : '确认封禁'}
                </button>
                <button
                  type="button"
                  class={stylex.props(ui.button, ui.ghost).className}
                  data-testid="admin-ban-confirm-cancel"
                  disabled={ban.isPending}
                  onClick={() => setConfirming(null)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </Show>
        <Show when={ban.error}>
          <p class={stylex.props(commonStyles.error).className} role="alert">
            {messageOf(ban.error, '封禁操作失败，请重试。')}
          </p>
        </Show>
      </Show>
    </AdminPanel>
  );
}

/** 历史表格的一行；准确率未知（账号无被计数击键）时如实显示「—」。 */
function HistoryCells(props: { result: AdminResult }) {
  return (
    <tr>
      <td class={stylex.props(adminStyles.td).className}>
        <AdminMatchLink id={props.result.match_id} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <RankBadge rank={props.result.rank} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <BookTheme theme={props.result.theme} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <OpponentBadge kind={props.result.opponent_kind} />
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatNumber(props.result.cpm)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatPercent(props.result.accuracy)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatAmount(props.result.damage_dealt)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatNumber(props.result.spells_cast)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatDuration(props.result.duration_ms)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatDate(props.result.created_at)}
      </td>
    </tr>
  );
}
