import { For, Show, type JSX } from 'solid-js';
import { Link } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import type {
  AccountBan,
  AccountRole,
  OpponentKind,
  Phase,
  RoomMode,
  Spell,
} from '../../../shared/protocol';
import { ELEMENT_LABELS, OPPONENT_KIND_LABELS, PHASE_LABELS } from '../../ui/format';
import { ELEMENT_CSS } from '../../ui/elements';
import { adminStyles } from './admin.styles';
import { styles } from './views.styles';

/**
 * 七个管理视图内部复用的私有渲染件：徽章、模式文案、主题名与咒文有序列表。
 * 公共契约组件仍以 common.tsx 为唯一来源；本文件只为避免视图间复制粘贴，
 * 绝不向 common.tsx 之外暴露新的约定接口。
 */

type BadgeTone = 'default' | 'live' | 'good' | 'danger';

function Badge(props: { tone?: BadgeTone; children: JSX.Element }) {
  return (
    <span
      data-tone={props.tone ?? 'default'}
      class={
        stylex.props(
          styles.badge,
          props.tone === 'live' && styles.badgeLive,
          props.tone === 'good' && styles.badgeGood,
          props.tone === 'danger' && styles.badgeDanger,
        ).className
      }
    >
      {props.children}
    </span>
  );
}

const PHASE_TONES: Record<Phase, BadgeTone> = {
  lobby: 'default',
  generating: 'default',
  countdown: 'default',
  playing: 'live',
  finished: 'default',
};

/** 对局阶段徽章；进行中的对局以金色高亮。 */
export function PhaseBadge(props: { phase: Phase }) {
  return <Badge tone={PHASE_TONES[props.phase]}>{PHASE_LABELS[props.phase]}</Badge>;
}

const ROLE_LABELS: Record<AccountRole, string> = { user: '用户', admin: '管理员' };

/** 账号角色徽章；管理员以金色区分。 */
export function RoleBadge(props: { role: AccountRole }) {
  return (
    <Badge tone={props.role === 'admin' ? 'live' : 'default'}>{ROLE_LABELS[props.role]}</Badge>
  );
}

/**
 * 账号封禁徽章：正常账号以弱化文字显示「正常」，封禁账号以警示色标注；
 * 具体的解封时间由详情页单独展示，徽章只回答「是否被封、何种封禁」。
 */
export function BanBadge(props: { ban: AccountBan | null }) {
  return (
    <Show
      when={props.ban}
      keyed
      fallback={<span class={stylex.props(adminStyles.muted).className}>正常</span>}
    >
      {(ban) => <Badge tone="danger">{ban.expiresAt === null ? '永久封禁' : '限时封禁'}</Badge>}
    </Show>
  );
}

const PERSISTENCE_LABELS: Record<string, string> = {
  idle: '未保存',
  saving: '保存中',
  saved: '已保存',
  error: '保存失败',
};

/**
 * 结算持久化状态徽章；未知或缺失的值如实显示为「—」。
 * 已保存以肯定色、保存失败以警示色区分。
 */
export function PersistenceBadge(props: { persistence: string | null }) {
  const label = () =>
    props.persistence !== null ? PERSISTENCE_LABELS[props.persistence] : undefined;
  return (
    <Show when={label()} fallback={<span>—</span>} keyed>
      {(text) => (
        <Badge
          tone={
            props.persistence === 'saved'
              ? 'good'
              : props.persistence === 'error'
                ? 'danger'
                : 'default'
          }
        >
          {text}
        </Badge>
      )}
    </Show>
  );
}

/** 咒文书刷新状态徽章：服务端正在重新生成时高亮。 */
export function RefreshBadge(props: { refreshing: boolean; publishedAt: number | null }) {
  return (
    <Badge tone={props.refreshing ? 'live' : props.publishedAt === null ? 'default' : 'good'}>
      {props.refreshing ? '刷新中' : props.publishedAt === null ? '尚未发布' : '已就绪'}
    </Badge>
  );
}

/** 席位类型：真人不加徽章，录像回放与生成对手显示徽章（与玩家端约定一致）。 */
export function OpponentBadge(props: { kind: OpponentKind }) {
  return (
    <Show when={props.kind !== 'human'} fallback={<span>{OPPONENT_KIND_LABELS.human}</span>}>
      <Badge tone="live">{OPPONENT_KIND_LABELS[props.kind]}</Badge>
    </Show>
  );
}

/** 名次；第 1 名以金色徽章强调。 */
export function RankBadge(props: { rank: number }) {
  return <Badge tone={props.rank === 1 ? 'live' : 'default'}>第 {props.rank} 名</Badge>;
}

/** 房间模式文案，沿用玩家端大厅的措辞；列表与详情共用，保证措辞一致。 */
export function ModeText(props: { mode: RoomMode }) {
  return <span>{props.mode === 'quick' ? '快速匹配（1v1）' : '私人房（2–4 人）'}</span>;
}

/** 未核验缓存存在时链接到主题检索，不将预设主题误当作已发布的咒文书。 */
export function BookTheme(props: { theme: string }) {
  return (
    <Link
      to="/admin/books"
      search={{ q: props.theme, page: 1 }}
      class={stylex.props(adminStyles.link).className}
    >
      {props.theme}
    </Link>
  );
}

/** 描述列表中的单行「标签 + 值」；配合 <dl class={adminStyles.details}> 使用。 */
export function DetailItem(props: { label: string; children: JSX.Element }) {
  return (
    <>
      <dt class={stylex.props(adminStyles.detailLabel).className}>{props.label}</dt>
      <dd class={stylex.props(adminStyles.detailValue).className}>{props.children}</dd>
    </>
  );
}

/** 咒文的有序列表：序号、名称、元素、原文与释义。 */
export function SpellList(props: { spells: Spell[] }) {
  return (
    <ol class={stylex.props(styles.spellList).className} data-testid="admin-spell-list">
      <For each={props.spells}>
        {(spell, index) => (
          <li class={stylex.props(styles.spellItem).className}>
            <div class={stylex.props(styles.spellHead).className}>
              <span class={stylex.props(styles.spellIndex).className}>
                {String(index() + 1).padStart(2, '0')}
              </span>
              <span class={stylex.props(styles.spellName).className}>{spell.name}</span>
              <span class={stylex.props(styles.elementTag).className}>
                <span
                  aria-hidden="true"
                  class={stylex.props(styles.elementDot).className}
                  style={{ 'background-color': ELEMENT_CSS[spell.element] }}
                />
                {ELEMENT_LABELS[spell.element]}
              </span>
            </div>
            <p class={stylex.props(styles.spellText).className}>{spell.text}</p>
            <p class={stylex.props(styles.spellTranslation).className}>{spell.translation}</p>
          </li>
        )}
      </For>
    </ol>
  );
}
