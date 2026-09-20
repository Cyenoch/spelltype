import * as stylex from '@stylexjs/stylex';

/**
 * 管理视图（总览/用户/对局/咒文书）专属的局部样式。
 * 仅被 features/admin 下的七个视图与 views.shared.tsx 引用，
 * 不属于 common.tsx 的公共契约。
 */
export const styles = stylex.create({
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 10px',
    fontSize: '.78rem',
    lineHeight: 1.7,
    letterSpacing: '.05em',
    whiteSpace: 'nowrap',
    border: '1px solid var(--line)',
    color: 'var(--ink-dim)',
    backgroundColor: '#101122',
  },
  badgeLive: { color: 'var(--gold)', borderColor: '#e5c68e66' },
  badgeGood: { color: 'var(--good)', borderColor: '#64e6b055' },
  badgeDanger: { color: 'var(--danger)', borderColor: '#ff6b7d55' },
  elementTag: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: '.78rem',
    color: 'var(--ink-dim)',
  },
  elementDot: { display: 'inline-block', width: 9, height: 9, border: '1px solid #0006' },
  spellList: { listStyle: 'none', margin: 0, padding: 0 },
  spellItem: { padding: '16px 2px', borderBottom: '1px solid var(--line)' },
  spellHead: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  spellIndex: { fontFamily: 'var(--font-mono)', fontSize: '.78rem', color: 'var(--ink-faint)' },
  spellName: { fontWeight: 600, fontSize: '.95rem' },
  spellText: {
    margin: '10px 0 0',
    fontFamily: 'var(--font-mono)',
    fontSize: '.95rem',
    letterSpacing: '.02em',
    overflowWrap: 'anywhere',
  },
  spellTranslation: { margin: '6px 0 0', fontSize: '.85rem', color: 'var(--ink-faint)' },
  resultCard: { border: '1px solid var(--line)', padding: '16px 18px', backgroundColor: '#101122' },
  resultList: { display: 'grid', gap: 14 },
  resultHead: { display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', margin: 0 },
  resultHeadMeta: { fontSize: '.85rem', color: 'var(--ink-faint)' },
  resultGroup: { marginTop: 16 },
  groupTitle: {
    fontSize: '.8rem',
    letterSpacing: '.08em',
    color: 'var(--ink-faint)',
    margin: '0 0 8px',
    fontWeight: 600,
  },
  filterRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'flex-end',
    flex: '1 1 300px',
  },
  phaseFilter: { minWidth: 170, marginBottom: 0 },
});
