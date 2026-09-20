import { adminStyles } from './admin.styles';
import { For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import type { AdminMatchDetail, AdminResult } from '../../../shared/admin';
import { INITIAL_HEALTH } from '../../../shared/protocol';
import { END_REASON_LABELS, formatAmount, formatDuration, formatHealth } from '../../ui/format';
import { adminMatchOptions } from './queries';
import {
  AdminBookLink,
  AdminEmpty,
  AdminHeading,
  AdminPanel,
  AdminQueryState,
  AdminUserLink,
  formatDate,
  formatNumber,
  formatPercent,
} from './common';
import {
  BookTheme,
  DetailItem,
  ModeText,
  OpponentBadge,
  PersistenceBadge,
  PhaseBadge,
  RankBadge,
  SpellList,
} from './views.shared';
import { styles } from './views.styles';

/**
 * 对局详情：元数据与房间状态、全部参与者、逐账号的完整结算指标
 * （含输入策略诊断）、保留时的咒文书快照。只读；主题链接始终指向
 * 该主题「当前」的缓存咒文书，而非本场对局使用的历史版本。
 */
export function AdminMatchDetailView(props: { matchId: () => string }) {
  const query = useQuery(() => adminMatchOptions(props.matchId()));
  return (
    <div class={stylex.props(adminStyles.stack).className} data-testid="view-admin-match-detail">
      <AdminQueryState query={query}>
        <Show when={query.data} keyed>
          {(data) => (
            <>
              <AdminHeading
                title={data.match.theme}
                description={`对局 ${data.match.id} 的元数据、参与者与结算指标。`}
              />
              <MatchDetailBody data={data} />
            </>
          )}
        </Show>
      </AdminQueryState>
    </div>
  );
}

function MatchDetailBody(props: { data: AdminMatchDetail }) {
  const data = props.data;
  const bookVerified = () => data.currentBookTheme === data.match.theme;
  return (
    <>
      <AdminPanel title="对局信息">
        <dl class={stylex.props(adminStyles.details).className} data-testid="admin-match-info">
          <DetailItem label="对局 ID">
            <span class={stylex.props(adminStyles.mono).className}>{data.match.id}</span>
          </DetailItem>
          <DetailItem label="房间 ID">
            <span class={stylex.props(adminStyles.mono).className}>{data.match.roomId}</span>
          </DetailItem>
          <DetailItem label="主题">
            <Show when={bookVerified()} fallback={<span>{data.match.theme}</span>}>
              <AdminBookLink theme={data.match.theme} />
              <span class={stylex.props(adminStyles.muted).className}>（当前咒文书）</span>
            </Show>
          </DetailItem>
          <DetailItem label="阶段">
            <PhaseBadge phase={data.match.phase} />
          </DetailItem>
          <DetailItem label="模式">
            <ModeText mode={data.match.mode} />
          </DetailItem>
          <DetailItem label="对手类型">
            <OpponentBadge kind={data.match.opponentKind} />
          </DetailItem>
          <DetailItem label="结束原因">
            <span>
              {data.endReason === null
                ? data.match.phase === 'finished'
                  ? '历史记录未保留结束原因'
                  : '尚未结束'
                : END_REASON_LABELS[data.endReason]}
            </span>
          </DetailItem>
          <DetailItem label="结算持久化">
            <PersistenceBadge persistence={data.persistence} />
          </DetailItem>
          <DetailItem label="记录状态">
            <Show when={data.isCurrentRoomMatch} fallback={<span>历史归档记录</span>}>
              <span class={stylex.props(styles.badge, styles.badgeLive).className}>
                房间当前对局
              </span>
            </Show>
          </DetailItem>
          <DetailItem label="记录时间">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatDate(data.match.createdAt)}
            </span>
          </DetailItem>
          <DetailItem label="开始时间">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatDate(data.match.startedAt)}
            </span>
          </DetailItem>
          <DetailItem label="结束时间">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatDate(data.match.endedAt)}
            </span>
          </DetailItem>
        </dl>
      </AdminPanel>

      <AdminPanel title={`参与者 · ${data.participants.length} 人`}>
        <Show
          when={data.participants.length > 0}
          fallback={<AdminEmpty>该对局没有可展示的参与者。</AdminEmpty>}
        >
          <div class={stylex.props(adminStyles.tableWrap).className}>
            <table
              class={stylex.props(adminStyles.table).className}
              data-testid="admin-match-participants"
            >
              <thead>
                <tr>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    玩家
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    剩余生命
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    施法
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    伤害
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    速度 · 字/分
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={data.participants}>
                  {(participant) => (
                    <tr>
                      <td class={stylex.props(adminStyles.td).className}>
                        <AdminUserLink
                          id={participant.userId}
                          name={participant.username}
                          exists={participant.accountExists}
                        />
                      </td>
                      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                        {formatHealth(participant.hp, INITIAL_HEALTH)}
                      </td>
                      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                        {formatNumber(participant.spellsCast)}
                      </td>
                      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                        {formatAmount(participant.damageDealt)}
                      </td>
                      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                        {formatNumber(participant.cpm)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </AdminPanel>

      <AdminPanel title={`结算记录 · ${data.results.length} 份`}>
        <Show
          when={data.results.length > 0}
          fallback={<AdminEmpty>该对局还没有已保存的结算记录。</AdminEmpty>}
        >
          <div class={stylex.props(styles.resultList).className} data-testid="admin-match-results">
            <For each={data.results}>{(result) => <ResultCard result={result} />}</For>
          </div>
        </Show>
      </AdminPanel>

      <AdminPanel
        title={data.spellBook === null ? '咒文书快照' : `咒文书快照 · ${data.spellBook.length} 条`}
      >
        <Show
          when={data.spellBook}
          fallback={
            <AdminEmpty>
              该对局暂未生成咒文书，或历史快照已不再保留。当前主题缓存不能代替本局快照。
            </AdminEmpty>
          }
          keyed
        >
          {(spells) => (
            <Show
              when={spells.length > 0}
              fallback={<AdminEmpty>快照存在，但未包含任何咒文。</AdminEmpty>}
            >
              <SpellList spells={spells} />
            </Show>
          )}
        </Show>
        <Show when={bookVerified()}>
          <p class={stylex.props(adminStyles.muted).className}>
            「{data.match.theme}」的链接指向该主题当前缓存使用的咒文书；咒文书会随刷新更新，
            未必与本场对局使用的版本一致。
          </p>
        </Show>
      </AdminPanel>
    </>
  );
}

/** 单份结算记录：战绩指标与输入策略诊断；字段缺失时一律如实显示「—」。 */
function ResultCard(props: { result: AdminResult }) {
  const result = props.result;
  return (
    <article class={stylex.props(styles.resultCard).className}>
      <div class={stylex.props(styles.resultHead).className}>
        <RankBadge rank={result.rank} />
        <AdminUserLink id={result.userId} name={result.username} exists={result.accountExists} />
        <span class={stylex.props(styles.resultHeadMeta).className}>
          记录于 {formatDate(result.created_at)}
        </span>
      </div>
      <dl class={stylex.props(adminStyles.details).className}>
        <DetailItem label="主题">
          <BookTheme theme={result.theme} />
        </DetailItem>
        <DetailItem label="对手类型">
          <OpponentBadge kind={result.opponent_kind} />
        </DetailItem>
        <DetailItem label="速度 · 字/分">
          <span class={stylex.props(adminStyles.mono).className}>{formatNumber(result.cpm)}</span>
        </DetailItem>
        <DetailItem label="准确率">
          <span class={stylex.props(adminStyles.mono).className}>
            {formatPercent(result.accuracy)}
          </span>
        </DetailItem>
        <DetailItem label="伤害">
          <span class={stylex.props(adminStyles.mono).className}>
            {formatAmount(result.damage_dealt)}
          </span>
        </DetailItem>
        <DetailItem label="施法">
          <span class={stylex.props(adminStyles.mono).className}>
            {formatNumber(result.spells_cast)}
          </span>
        </DetailItem>
        <DetailItem label="正确字符">
          <span class={stylex.props(adminStyles.mono).className}>
            {formatNumber(result.correct_chars)}
          </span>
        </DetailItem>
        <DetailItem label="用时">
          <span class={stylex.props(adminStyles.mono).className}>
            {formatDuration(result.duration_ms)}
          </span>
        </DetailItem>
        <DetailItem label="剩余生命">
          <span class={stylex.props(adminStyles.mono).className}>
            {formatHealth(result.hp_remaining, INITIAL_HEALTH)}
          </span>
        </DetailItem>
      </dl>
      <section class={stylex.props(styles.resultGroup).className}>
        <h4 class={stylex.props(styles.groupTitle).className}>输入策略诊断</h4>
        <dl class={stylex.props(adminStyles.details).className}>
          <DetailItem label="规则版本">
            <span class={stylex.props(adminStyles.mono).className}>
              {result.input_policy_version}
            </span>
          </DetailItem>
          <DetailItem label="策略模式">
            <span>
              {result.input_policy_mode === 'enforce'
                ? '执行'
                : result.input_policy_mode === 'observe'
                  ? '观察'
                  : '—'}
            </span>
          </DetailItem>
          <DetailItem label="触及规则">
            <Show
              when={result.input_gate_hits !== null && result.input_gate_hits > 0}
              fallback={result.input_gate_hits === null ? '未测量' : '未触及'}
            >
              <details>
                <summary>触及 {formatNumber(result.input_gate_hits)} 次 · 查看规则</summary>
                <Show
                  when={result.input_policy_version === 'ascii-floor-v1'}
                  fallback={
                    <p class={stylex.props(adminStyles.muted).className}>
                      此版本仅保留触及次数，无法还原具体规则。
                    </p>
                  }
                >
                  <p>完成过快（completion_too_early）</p>
                  <p class={stylex.props(adminStyles.muted).className}>
                    首次完成咒文时，耗时短于目标字符数 × 35 毫秒的服务端下限。
                    同一咒文只计一次；观察模式仅记录，执行模式要求重新输入。
                    此记录不等同于作弊认定。
                  </p>
                </Show>
              </details>
            </Show>
          </DetailItem>
          <DetailItem label="恢复次数">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatNumber(result.input_recoveries)}
            </span>
          </DetailItem>
          <DetailItem label="最小资格比值">
            <span class={stylex.props(adminStyles.mono).className}>
              {result.input_min_completion_ratio === null
                ? '未采样'
                : result.input_min_completion_ratio.toFixed(2)}
            </span>
          </DetailItem>
          <DetailItem label="连接超限">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatNumber(result.input_overloads)}
            </span>
          </DetailItem>
          <DetailItem label="恢复后完成">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatNumber(result.input_recovered_completions)}
            </span>
          </DetailItem>
          <DetailItem label="恢复偏离">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatNumber(result.input_recovery_departures)}
            </span>
          </DetailItem>
        </dl>
      </section>
    </article>
  );
}
