import { For, Show, createMemo } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import { useMutation, useQuery, useQueryClient } from '@tanstack/solid-query';
import { parseResponse, DetailedError } from 'hono/client';
import type { DrainStatus, MaintenanceMode } from '../../../shared/maintenance';
import { client } from '../../app/client';
import { statusOptions } from '../../app/maintenance';
import { messageOf, toast } from '../../ui/toast';
import { ui } from '../../ui/primitives';
import { styles } from './maintenance-view.styles';
import { AdminHeading } from './common';

const MODE_LABELS: Record<MaintenanceMode, string> = {
  open: '开放中',
  draining: '维护中',
};

/** 在安全替换应用程序前，必须全部归零的排空（drain）计数器。 */
const DRAIN_COUNTERS: ReadonlyArray<{
  key: keyof Pick<
    DrainStatus,
    'activeMatches' | 'liveReservations' | 'waitingTickets' | 'pendingResults'
  >;
  label: string;
}> = [
  { key: 'activeMatches', label: '进行中的对局' },
  { key: 'liveReservations', label: '有效的座位预留' },
  { key: 'waitingTickets', label: '排队中的玩家' },
  { key: 'pendingResults', label: '待保存的战绩' },
];

/**
 * 持久化的准入状态、当前仍阻碍安全替换的阻塞项，以及两种明确的状态流转操作。
 * 每次修改均携带据以决策的版本号（CAS 机制）；若发生并发修改则重新读取，绝不静默覆盖。
 * 服务端在每次调用时均会重新校验管理员角色——本页面仅作为管理员便捷操作的界面，而非最终鉴权机构。
 */
export function MaintenanceAdminView() {
  const queryClient = useQueryClient();
  const statusQuery = useQuery(() => ({
    queryKey: ['admin', 'maintenance'],
    queryFn: ({ signal }) =>
      parseResponse(client.api.admin.maintenance.$get({}, { init: { signal } })),
    refetchInterval: 10_000,
    retry: false,
  }));

  const status = createMemo(() => statusQuery.data);
  const mode = createMemo(() => status()?.mode ?? null);
  const modeLabel = createMemo(() => {
    const current = mode();
    return current === null ? null : MODE_LABELS[current];
  });
  const revision = createMemo(() => status()?.revision ?? null);

  const setMode = useMutation(() => ({
    mutationFn: async (input: { mode: MaintenanceMode; expectedRevision: number }) =>
      parseResponse(client.api.admin.maintenance.$post({ json: input })),
    onSuccess: (info) => {
      toast(
        info.mode === 'draining' ? '已进入维护：新对局将无法开始。' : '维护已结束，对局入口恢复。',
        'good',
      );
    },
    onError: (error) => {
      const conflict = error instanceof DetailedError && error.statusCode === 409;
      toast(
        conflict
          ? '维护状态已被其他人更新，正在重新读取，请稍后重试。'
          : messageOf(error, '操作失败，请重试。'),
        'error',
      );
    },
    onSettled: () =>
      Promise.all([
        statusQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: statusOptions.queryKey }),
      ]),
  }));

  const busy = createMemo(() => setMode.isPending || statusQuery.isFetching || statusQuery.isError);

  const transition = (target: MaintenanceMode) => {
    const expectedRevision = revision();
    if (expectedRevision === null || busy()) return;
    setMode.mutate({ mode: target, expectedRevision });
  };

  const updatedAt = () => {
    const current = status();
    if (!current) return '—';
    return new Date(current.updatedAt).toLocaleTimeString();
  };

  return (
    <section data-testid="view-admin-maintenance" class={stylex.props(styles.page).className}>
      <AdminHeading title="系统维护" description="控制新对局准入，检查安全发布前的排空状态。" />
      <div class={stylex.props(ui.panel).className}>
        <div class={stylex.props(ui.panelHead).className}>
          <h2>维护控制台</h2>
          <span class={stylex.props(ui.eyebrow).className}>仅管理员</span>
        </div>
        <p class={stylex.props(ui.muted).className}>
          进入维护后，新的匹配与新房间的创建立即停止；进行中的对局、排队取消与离开不受影响。
          替换服务前，必须等待下方的阻塞计数全部归零。仅结束维护不会重启或替换服务。
        </p>

        <Show
          when={!statusQuery.isError}
          fallback={
            <div
              class={stylex.props(ui.notice, styles.noticeError).className}
              data-testid="admin-maintenance-error"
              data-tone="error"
              role="alert"
            >
              <span class={stylex.props(ui.noticeIcon).className} aria-hidden="true">
                ✖
              </span>
              暂时无法获取维护状态，稍后自动重试。
            </div>
          }
        >
          <div
            class={stylex.props(ui.panel, styles.status).className}
            data-testid="admin-maintenance-status"
            data-mode={mode() ?? 'loading'}
          >
            <div class={stylex.props(styles.modeRow).className}>
              <span class={stylex.props(ui.eyebrow).className}>当前状态</span>
              <span
                class={stylex.props(ui.title).className}
                data-testid="admin-maintenance-mode"
                data-mode={mode() ?? 'loading'}
              >
                {modeLabel() ?? '读取中…'}
              </span>
            </div>
            <p
              class={stylex.props(ui.smallText, ui.faint).className}
              data-testid="admin-maintenance-revision"
            >
              状态版本（CAS）：{revision() ?? '—'} · 更新于 {updatedAt()}
            </p>

            <div class={stylex.props(ui.statTiles, styles.counters).className}>
              <For each={DRAIN_COUNTERS}>
                {(counter) => (
                  <div
                    class={stylex.props(ui.tile).className}
                    data-testid={`admin-count-${counter.key}`}
                  >
                    <div class={stylex.props(ui.tileLabel).className}>{counter.label}</div>
                    <div class={stylex.props(ui.tileValue).className}>
                      {status()?.[counter.key] ?? '—'}
                    </div>
                  </div>
                )}
              </For>
            </div>

            <Show when={status()}>
              {(current) => (
                <p
                  class={stylex.props(ui.smallText).className}
                  data-testid="admin-runtime-note"
                  data-ready={current().ready ? 'true' : 'false'}
                >
                  {current().runtimeKnown
                    ? current().mode === 'open'
                      ? '服务开放中。'
                      : current().ready
                        ? '已排空，可以安全替换服务。替换后请先验证健康状态，再结束维护。'
                        : '仍在等待对局与战绩收尾。'
                    : '运行时状态未知：不能结束维护，请先确认服务进程。'}
                </p>
              )}
            </Show>
          </div>
        </Show>

        <div class={stylex.props(ui.buttonRow, styles.actions).className}>
          <button
            type="button"
            class={stylex.props(ui.button, ui.danger).className}
            data-testid="admin-drain"
            disabled={busy() || mode() !== 'open'}
            onClick={() => transition('draining')}
          >
            {setMode.isPending ? '正在切换…' : '进入维护'}
          </button>
          <button
            type="button"
            class={stylex.props(ui.button, ui.primary).className}
            data-testid="admin-resume"
            disabled={busy() || mode() !== 'draining'}
            onClick={() => transition('open')}
          >
            {setMode.isPending ? '正在切换…' : '结束维护'}
          </button>
        </div>
      </div>
    </section>
  );
}
