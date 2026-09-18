import { Show, createEffect } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { useQuery } from '@tanstack/solid-query';
import { DetailedError } from 'hono/client';
import * as stylex from '@stylexjs/stylex';
import { formatTimestamp } from '../../ui/format';
import { ASSETS } from '../../pixi/assets';
import { messageOf } from '../../ui/toast';
import { profileOptions } from '../../app/queries';
import { ui } from '../../ui/primitives';
import type { AppContext } from '../../app/context';
import { styles } from './home.styles';

/**
 * The signed-in player's own card: account summary plus the stats of the account
 * the session belongs to. The query is keyed by that account and stays disabled
 * for guests, so a late answer can never write another account's numbers here.
 */
export function PlayerCard(props: { ctx: AppContext }) {
  const navigate = useNavigate();
  const user = () => props.ctx.session.user;
  const userId = () => props.ctx.session.user?.id ?? null;

  const profile = useQuery(
    () => {
      const id = userId();
      return { ...profileOptions(id ?? ''), enabled: id !== null };
    },
    () => props.ctx.queryClient,
  );

  const stats = () => profile.data?.stats ?? null;
  const latest = () => {
    const data = profile.data;
    if (!data || data.stats.games === 0) return null;
    return data.history[0] ?? null;
  };
  const statsNote = (): { text: string; tone: 'muted' | 'error' } | null => {
    if (!userId()) return null;
    const current = stats();
    if (current) {
      return current.games === 0 ? { text: '第一场对决，从这里开始。', tone: 'muted' } : null;
    }
    if (profile.isFetching) return { text: '正在读取你的战绩…', tone: 'muted' };
    const error = profile.error;
    if (error && !(error instanceof DetailedError && error.statusCode === 401)) {
      return { text: messageOf(error, '读取战绩失败，请稍后重试。'), tone: 'error' };
    }
    return null;
  };
  const showRetry = () =>
    !stats() &&
    !profile.isFetching &&
    profile.error instanceof DetailedError &&
    profile.error.statusCode !== 401;

  // An expired session is a shell-level concern: it is reported once, outside
  // rendering, and never as a stats error.
  createEffect(() => {
    if (userId() && profile.error instanceof DetailedError && profile.error.statusCode === 401) {
      props.ctx.handleAuthFailure('登录已过期，请重新登录。');
    }
  });

  return (
    <aside class={stylex.props(styles.aside).className} data-testid="home-player">
      <Show
        when={user()}
        fallback={
          <div class={stylex.props(styles.pc, styles.pcGuest).className}>
            <div class={stylex.props(styles.pcHead).className}>
              <img
                class={stylex.props(styles.pcAvatar, styles.pcAvatarGuest).className}
                src={ASSETS.avatars[0]}
                alt=""
                width="56"
                height="56"
              />
              <div class={stylex.props(styles.pcId).className}>
                <div class={stylex.props(styles.pcName).className}>未登录</div>
                <div class={stylex.props(styles.pcMeta, styles.pcSub).className}>
                  登录后可以快速匹配、创建私人房。
                </div>
              </div>
              <img
                class={stylex.props(styles.pcSigil).className}
                src={ASSETS.sigil}
                alt=""
                width="30"
                height="30"
                aria-hidden="true"
              />
            </div>
            <p class={stylex.props(styles.pcMeta, styles.pcNote).className}>
              注册账号，开启你的第一场对决。
            </p>
            <div class={stylex.props(ui.buttonRow).className}>
              <button
                class={stylex.props(ui.button, ui.primary, styles.pcButton).className}
                type="button"
                data-testid="home-auth"
                onClick={() =>
                  void navigate({
                    to: '/auth',
                    search: { mode: 'login', room: props.ctx.pendingInvite() ?? undefined },
                  })
                }
              >
                登录 / 注册
              </button>
            </div>
          </div>
        }
      >
        <div class={stylex.props(styles.pc).className}>
          <div class={stylex.props(styles.pcHead).className}>
            <img
              class={stylex.props(styles.pcAvatar).className}
              src={ASSETS.avatars[0]}
              alt=""
              width="56"
              height="56"
            />
            <div class={stylex.props(styles.pcId).className}>
              <div
                class={stylex.props(styles.pcName).className}
                data-testid="home-username"
                title={user()?.username}
              >
                {user()?.username}
              </div>
              <div class={stylex.props(styles.pcMeta, styles.pcSub).className}>
                准备迎接下一场对决
              </div>
            </div>
            <img
              class={stylex.props(styles.pcSigil).className}
              src={ASSETS.sigil}
              alt=""
              width="30"
              height="30"
              aria-hidden="true"
            />
          </div>

          <Show when={stats()}>
            {(record) => (
              <div class={stylex.props(styles.pcStats).className} data-testid="home-stats">
                <div class={stylex.props(styles.pcStat).className}>
                  <span class={stylex.props(styles.pcStatLabel).className}>完成对局</span>
                  <b class={stylex.props(styles.pcStatValue).className} data-testid="home-games">
                    {record().games}
                  </b>
                </div>
                <div class={stylex.props(styles.pcStat).className}>
                  <span class={stylex.props(styles.pcStatLabel).className}>胜场</span>
                  <b class={stylex.props(styles.pcStatValue).className} data-testid="home-wins">
                    {record().wins}
                  </b>
                </div>
                <div class={stylex.props(styles.pcStat).className}>
                  <span class={stylex.props(styles.pcStatLabel).className}>最佳速度</span>
                  <div class={stylex.props(styles.pcStatRow).className}>
                    <b
                      class={stylex.props(styles.pcStatValue).className}
                      data-testid="home-best-cpm"
                    >
                      {record().games === 0 ? '—' : record().bestCpm}
                    </b>
                    <span class={stylex.props(styles.pcStatUnit).className}>字/分钟</span>
                  </div>
                </div>
              </div>
            )}
          </Show>

          <Show when={latest()}>
            {(game) => (
              <section
                class={stylex.props(styles.pcRecent).className}
                data-testid="home-recent"
                title={`完成于 ${formatTimestamp(game().created_at)}`}
              >
                <span class={stylex.props(styles.pcStatLabel).className}>最近一局</span>
                <p class={stylex.props(styles.pcMeta, styles.pcRecentLine).className}>
                  {game().theme} · 第 {game().rank} 名 · {game().cpm} 字/分钟
                </p>
              </section>
            )}
          </Show>

          <Show when={statsNote()}>
            {(note) => (
              <p
                class={
                  stylex.props(
                    styles.pcMeta,
                    styles.pcNote,
                    note().tone === 'error' && styles.pcNoteError,
                  ).className
                }
                data-testid="home-stats-note"
                data-tone={note().tone}
              >
                {note().text}
              </p>
            )}
          </Show>

          <div class={stylex.props(ui.buttonRow).className}>
            <button
              class={stylex.props(ui.button, styles.pcButton).className}
              type="button"
              data-testid="home-profile"
              onClick={() => void navigate({ to: '/me', search: {} })}
            >
              我的战绩
            </button>
            <Show when={showRetry()}>
              <button
                class={stylex.props(ui.button, ui.small, ui.quiet, styles.pcButton).className}
                type="button"
                data-testid="home-stats-retry"
                onClick={() => void profile.refetch()}
              >
                重试
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </aside>
  );
}
