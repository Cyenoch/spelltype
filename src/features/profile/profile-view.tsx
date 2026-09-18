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

/** A stable empty window, so an account with no saved match never hands the table a new array. */
const NO_HISTORY: MatchResult[] = [];

/**
 * Account summary: totals, best CPM and the ten most recent matches. History is
 * continuous-combat only: every row is a damage/health/casts/CPM/accuracy
 * record, with nothing carried over from the retired round game.
 */
export function ProfileView(props: { ctx: AppContext }) {
  const navigate = useNavigate();
  let authHandled = false;

  const profile = useQuery(() => ({
    // Shared with the homepage card: one cache entry per account.
    ...profileOptions(props.ctx.session.user?.id ?? ''),
    /**
     * The panel is a snapshot the player asked for: a match saved a second ago has to be on
     * screen the moment this view opens, so a mount refetches instead of reusing the entry.
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
        // An already-dead session is still a successful sign-out.
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

  // A rejected session is not a data error: the shell re-authenticates, once.
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

        <ProfileHistory history={history()} />
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
