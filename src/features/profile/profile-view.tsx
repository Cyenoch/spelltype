import { createEffect, createMemo } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { useMutation, useQuery } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import type { MatchResult } from '../../../shared/protocol';
import { parseResponse, DetailedError } from 'hono/client';
import { client } from '../../app/client';
import { messageOf } from '../../ui/toast';
import { profileOptions } from '../../app/queries';
import type { AppContext } from '../../app/context';
import { ui } from '../../ui/primitives';
import { ProfileHistory } from './profile-history';
import { InstallHint } from './install-hint';
import { NotificationSettings } from './notification-settings';

/** 稳定的空战绩数组，确保无对局记录的账户不会导致向表格传入新数组引用。 */
const NO_HISTORY: MatchResult[] = [];

/**
 * 账户概览：汇总数据、最高 CPM 以及最近十场对局。
 * 战绩仅记录连续战斗模式：每行均为伤害/生命/施法/CPM/命中率数据，
 * 不保留已废弃的回合制对局历史。
 */
export function ProfileView(props: { ctx: AppContext }) {
  const navigate = useNavigate();
  let authHandled = false;

  const profile = useQuery(() => ({
    // 与首页玩家卡片共享数据：每个账户对应一个缓存条目。
    ...profileOptions(props.ctx.session.user?.id ?? ''),
    /**
     * 本面板展示玩家主动查看的快照：一秒前刚保存的对局必须在打开本视图的瞬间立即呈现，
     * 因此在挂载时始终重新拉取，而非复用已有缓存。
     */
    staleTime: 0,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: false,
  }));

  const stats = () => profile.data?.stats ?? null;
  const history = createMemo(() => profile.data?.history ?? NO_HISTORY);

  const signOut = useMutation(() => ({
    mutationFn: async () => {
      try {
        await parseResponse(client.api.logout.$post());
      } catch (error) {
        // 会话若已失效，退出登录操作依然算作成功。
        if (!(error instanceof DetailedError && error.statusCode === 401)) throw error;
      }
    },
    onSuccess: () => {
      props.ctx.session.clear();
      props.ctx.setPendingInvite(null);
      props.ctx.notify('已退出登录。', 'info');
      void navigate({ to: '/', search: {} });
    },
    onError: (error) => props.ctx.notify(messageOf(error, '退出登录失败，请重试。'), 'error'),
  }));

  // 会话被拒绝不属于普通数据错误：外层壳组件统一触发一次重新登录。
  createEffect(() => {
    const error = profile.error;
    if (authHandled || !(error instanceof DetailedError && error.statusCode === 401)) return;
    authHandled = true;
    props.ctx.handleAuthFailure('登录已过期，请重新登录。');
  });

  const loadError = () => {
    const error = profile.error;
    if (!error || (error instanceof DetailedError && error.statusCode === 401)) return null;
    return messageOf(error, '读取战绩失败，请稍后重试。');
  };

  return (
    <section data-testid="view-profile">
      <div class={stylex.props(ui.panel).className}>
        <div class={stylex.props(ui.panelHead).className}>
          <h1>我的战绩</h1>
          <button
            type="button"
            class={stylex.props(ui.button, ui.small).className}
            data-testid="profile-refresh"
            disabled={profile.isFetching}
            onClick={() => void profile.refetch()}
          >
            刷新
          </button>
        </div>

        <div class={stylex.props(ui.statTiles).className} data-testid="profile-stats">
          <div class={stylex.props(ui.tile).className}>
            <div class={stylex.props(ui.tileLabel).className}>完成对局</div>
            <div class={stylex.props(ui.tileValue).className} data-testid="profile-games">
              {stats()?.games ?? '—'}
            </div>
          </div>
          <div class={stylex.props(ui.tile).className}>
            <div class={stylex.props(ui.tileLabel).className}>胜场（第 1 名）</div>
            <div class={stylex.props(ui.tileValue).className} data-testid="profile-wins">
              {stats()?.wins ?? '—'}
            </div>
          </div>
          <div class={stylex.props(ui.tile).className}>
            <div class={stylex.props(ui.tileLabel).className}>最佳速度 · 字/分钟</div>
            <div class={stylex.props(ui.tileValue).className} data-testid="profile-best-cpm">
              {stats()?.bestCpm ?? '—'}
            </div>
          </div>
        </div>

        <p class={stylex.props(ui.smallText, ui.faint).className}>
          只记录已完成的对局，并列第一也计入胜场。
        </p>
        <p
          class={stylex.props(ui.smallText, ui.muted).className}
          data-testid="profile-loading"
          hidden={!profile.isFetching}
        >
          正在读取战绩…
        </p>
        <p
          class={stylex.props(ui.smallText).className}
          data-testid="profile-error"
          hidden={loadError() === null}
        >
          {loadError() ?? ''}
        </p>
      </div>

      <div class={stylex.props(ui.panel).className}>
        <h2>最近十场</h2>
        <p
          class={stylex.props(ui.smallText, ui.faint).className}
          data-testid="profile-history-note"
        >
          对手列标明每局的对手类型（真人 / 幻影 / 机器人）；与训练对手的对局照常记录，暂无排名奖励。
        </p>

        <ProfileHistory history={history()} />
      </div>

      <div class={stylex.props(ui.panel).className}>
        <h2>对局提醒</h2>

        <NotificationSettings ctx={props.ctx} />
      </div>

      <div class={stylex.props(ui.panel).className}>
        <InstallHint />
      </div>

      <div class={stylex.props(ui.panel).className}>
        <div class={stylex.props(ui.buttonRow).className}>
          <button
            type="button"
            class={stylex.props(ui.button).className}
            data-testid="profile-back"
            onClick={() => void navigate({ to: '/', search: {} })}
          >
            返回首页
          </button>
          <button
            type="button"
            class={stylex.props(ui.button, ui.ghost).className}
            data-testid="profile-signout"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            退出登录
          </button>
        </div>
      </div>
    </section>
  );
}
