import type { CombatEvent, Element, Player, RoomSnapshot } from '../../shared/protocol';
import {
  ELEMENT_LABELS,
  END_REASON_LABELS,
  formatAccuracyPercent,
  formatHealth,
  formatSeconds,
  percentOf,
  prefixLength,
} from '../format';
import { arenaFor, elementGlyph, spellIconFor } from '../assets';
import { ELEMENT_CSS } from '../elements';
import { motion } from '../motion';
import { append, clear, el, image, setData, setText } from '../dom';
import { TypingController, type TypingCommit, type TypingLocalState } from '../typing';
import type { BattleStage } from '../pixi/stage';
import type { TypingEffects } from '../pixi/typing-effects';
import type { ServerClock } from '../clock';

export interface BattleActions {
  /** Returns true when the snapshot left the client. */
  onCommit(commit: TypingCommit): boolean;
  onPasteBlocked(): void;
  onRematch(): void;
  onLeave(): void;
}

const PERSISTENCE_TEXT: Record<'idle' | 'saving' | 'saved' | 'error', string> = {
  idle: '对决结束后保存战绩',
  saving: '正在保存战绩…',
  saved: '战绩已保存到账号',
  error: '战绩暂未保存，正在自动重试',
};

const LOW_HP_RATIO = 0.35;
const CRITICAL_HP_RATIO = 0.15;
/** The room keeps a 32-entry ring; the visible log mirrors that bound. */
const LOG_LIMIT = 32;
/** Effects per confirmed commit are capped: fast typing emits repeatedly, not once hugely. */
const TYPING_FX_MAX_PER_EMIT = 3;

interface SeatCard {
  root: HTMLElement;
  name: HTMLElement;
  targetMark: HTMLElement;
  aimMark: HTMLElement;
  downMark: HTMLElement;
  offlineMark: HTMLElement;
  hpBar: HTMLElement;
  hpFill: HTMLElement;
  hpText: HTMLElement;
  castBar: HTMLElement;
  castFill: HTMLElement;
}

function seatMarker(testid: string, className: string, text: string): HTMLElement {
  return el('span', { class: `mark ${className}`, testid, text, hidden: true });
}

/**
 * The combat surface: one arena with every player's health, one global clock,
 * one typing station with the recipient's current spell, and the settled
 * results. Every number shown here comes from the authoritative snapshot; the
 * canvas only draws it.
 */
export class BattlePanel {
  readonly el: HTMLElement;
  private readonly arena: HTMLElement;
  private readonly backdrop: HTMLImageElement;
  private readonly canvasHost: HTMLElement;
  private readonly arenaSeats: HTMLElement;
  private readonly timerValue: HTMLElement;
  private readonly timerLabel: HTMLElement;
  private readonly timerBox: HTMLElement;
  private readonly countdown: HTMLElement;
  private readonly countdownValue: HTMLElement;
  private readonly countdownHint: HTMLElement;
  private readonly threat: HTMLElement;
  private readonly logList: HTMLElement;
  private readonly notices: HTMLElement;
  private readonly spellArt: HTMLImageElement;
  private readonly spellGlyph: HTMLImageElement;
  private readonly spellName: HTMLElement;
  private readonly elementTag: HTMLElement;
  private readonly targetWrap: HTMLElement;
  private readonly spellText: HTMLElement;
  private readonly fxHost: HTMLElement;
  private readonly spellProgress: HTMLElement;
  private readonly spellProgressFill: HTMLElement;
  private readonly spellProgressText: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly typeArea: HTMLElement;
  private readonly inputStatus: HTMLElement;
  private readonly pasteNotice: HTMLElement;
  private readonly castFeedback: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly eliminatedNotice: HTMLElement;
  private readonly selfHpBar: HTMLElement;
  private readonly selfHpFill: HTMLElement;
  private readonly selfHpText: HTMLElement;
  private readonly selfCpm: HTMLElement;
  private readonly selfSpells: HTMLElement;
  private readonly selfAccuracy: HTMLElement;
  private readonly selfDamage: HTMLElement;
  private readonly selfRank: HTMLElement;
  private readonly finalRank: HTMLElement;
  private readonly finalDamage: HTMLElement;
  private readonly finalSpells: HTMLElement;
  private readonly finalCpm: HTMLElement;
  private readonly finalAccuracy: HTMLElement;
  private readonly resultBanner: HTMLElement;
  private readonly resultTitle: HTMLElement;
  private readonly resultDetail: HTMLElement;
  private readonly finalPanel: HTMLElement;
  private readonly finalBody: HTMLElement;
  private readonly saveStatus: HTMLElement;

  private readonly typing: TypingController;
  private readonly cards = new Map<string, SeatCard>();
  private stage: BattleStage | null = null;
  private typingFx: TypingEffects | null = null;
  private fxLive = false;
  /** Confirmed prefix already celebrated, and the spell it belongs to. */
  private fxProgress = 0;
  private fxIndex = -1;
  /** Set while the field is being adopted from the server, never for typing. */
  private fxAdopting = false;
  private snapshot: RoomSnapshot | null = null;
  private selfId = '';
  private targetChars: string[] = [];
  private charNodes: HTMLElement[] = [];
  private renderedTarget = '';
  private localProgress = 0;
  private localTargetLength = 0;
  private localPending = false;
  private localAccuracy: number | null = null;
  /** `matchId:spellIndex` of the spell the input is currently bound to. */
  private appliedKey = '';
  private appliedMatchId = '';
  private appliedIndex = -1;
  private lastPhase = '';
  private lastEventKey = '';
  /** Set when the match settles, consumed after the results panel is shown. */
  private resultScrollPending = false;
  private warnedLastThirty = false;

  constructor(
    private readonly clock: ServerClock,
    roomSeed: string,
    private readonly actions: BattleActions,
  ) {
    // The generated arena art is decorative: it sits behind the canvas and the
    // arena keeps its gradient if the file is missing.
    this.backdrop = el('img', {
      class: 'arena__backdrop',
      attrs: {
        src: arenaFor(arenaIndex(roomSeed)),
        alt: '',
        decoding: 'async',
        'aria-hidden': 'true',
      },
    });
    this.backdrop.addEventListener('error', () => {
      this.backdrop.hidden = true;
    });

    this.canvasHost = el('div', {
      class: 'arena__canvas',
      testid: 'battle-canvas-wrap',
      data: { state: 'pending' },
    });
    this.arenaSeats = el('div', {
      class: 'arena__seats',
      testid: 'arena-seats',
      attrs: { role: 'list', 'aria-label': '所有玩家的生命值' },
    });
    this.timerValue = el('span', { class: 'timer__value', testid: 'match-timer', text: '—' });
    this.timerLabel = el('span', { class: 'timer__label', testid: 'match-timer-label', text: '等待开始' });
    this.timerBox = el('div', { class: 'timer', testid: 'match-timer-box' }, this.timerValue, this.timerLabel);
    this.countdownValue = el('div', { class: 'countdown__value', text: '3' });
    this.countdownHint = el('div', {
      class: 'countdown__hint',
      text: '看清咒文结构，倒数结束后立刻开始输入。',
    });
    this.countdown = el(
      'div',
      { class: 'countdown', testid: 'countdown-display', hidden: true },
      this.countdownValue,
      this.countdownHint,
    );
    this.threat = el('div', {
      class: 'threat',
      testid: 'threat-banner',
      data: { tone: 'none', threat: false },
      attrs: { 'aria-live': 'polite' },
    });
    this.arena = el(
      'div',
      { class: 'arena', testid: 'arena', data: { seats: 0, render: 'dom' } },
      this.backdrop,
      el(
        'div',
        { class: 'arena__hud' },
        this.timerBox,
        el('button', {
          class: 'btn btn--small btn--danger btn--quiet',
          type: 'button',
          testid: 'battle-leave',
          text: '离开房间',
          on: { click: () => this.actions.onLeave() },
        }),
      ),
      this.arenaSeats,
      this.canvasHost,
      this.countdown,
    );

    this.notices = el('div', { class: 'battle__notices', testid: 'battle-notice' });
    this.logList = el('div', {
      class: 'combat-log',
      testid: 'combat-log',
      attrs: { role: 'log', 'aria-label': '最近的施法记录' },
    });

    this.spellName = el('span', { class: 'spell-name', testid: 'spell-name', text: '咒文尚未显现' });
    this.spellArt = image(spellIconFor('arcane', 0), '', 'spell-art');
    this.spellArt.dataset.testid = 'spell-art';
    this.spellArt.addEventListener('error', () => {
      // The generated icon is never allowed to leave the station without art.
      this.spellArt.hidden = true;
      this.spellGlyph.hidden = false;
    });
    this.spellGlyph = image(elementGlyph('arcane'), '奥术元素', 'spell-icon');
    this.spellGlyph.dataset.testid = 'spell-element-icon';
    this.spellGlyph.hidden = true;
    this.elementTag = el('span', { class: 'element-tag', testid: 'spell-element', text: '' });

    this.spellProgressFill = el('div', { class: 'meter__fill', testid: 'spell-progress-fill' });
    this.spellProgress = el(
      'div',
      {
        class: 'meter meter--spell',
        testid: 'spell-progress',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': '0',
          'aria-label': '当前咒文进度',
        },
      },
      this.spellProgressFill,
    );
    this.spellProgressText = el('span', { class: 'meter__text', testid: 'spell-progress-text', text: '0 / 0 字' });

    this.spellText = el('div', { class: 'spell-text', testid: 'spell-text' });

    this.textarea = el('textarea', {
      id: 'typing-input',
      testid: 'typing-input',
      class: 'type-field',
      attrs: {
        rows: 2,
        spellcheck: 'false',
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'off',
        'aria-describedby': 'input-status',
      },
    });
    this.textarea.setAttribute('aria-label', '咒文输入区');
    this.inputStatus = el('div', { class: 'input-status', id: 'input-status', testid: 'input-status' });
    this.pasteNotice = el('div', {
      class: 'paste-notice',
      testid: 'paste-notice',
      attrs: { 'aria-live': 'polite' },
    });
    this.castFeedback = el('div', {
      class: 'cast-feedback',
      testid: 'cast-feedback',
      data: { state: 'idle', element: '' },
      attrs: { 'aria-live': 'polite' },
      text: '等待施法…',
    });
    this.tip = el('p', { class: 'small', testid: 'battle-tip', attrs: { 'aria-live': 'polite' } });
    this.typeArea = el(
      'div',
      { class: 'type-area' },
      el('label', { class: 'sr-only', attrs: { for: 'typing-input' }, text: '咒文输入区' }),
      this.textarea,
      this.inputStatus,
      this.pasteNotice,
      el('div', { class: 'type-area__row' }, this.castFeedback, this.tip),
    );
    this.eliminatedNotice = el('div', {
      class: 'notice notice--down',
      testid: 'eliminated-notice',
      data: { state: 'alive' },
      hidden: true,
    });

    // Decorative particle layer over the spell glyphs: it is absolutely
    // positioned, ignores pointer events, and keeps the real text underneath
    // untouched and fully readable by the DOM and assistive tech.
    this.fxHost = el('div', {
      class: 'target-fx',
      testid: 'typing-fx',
      data: { state: 'pending' },
      attrs: { 'aria-hidden': 'true' },
    });
    this.targetWrap = el('div', { class: 'station__target' }, this.spellText, this.fxHost);

    this.selfHpFill = el('div', { class: 'hpbar__fill', testid: 'self-hp-fill' });
    this.selfHpBar = el(
      'div',
      {
        class: 'hpbar hpbar--self',
        testid: 'self-hp',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '0',
          'aria-valuenow': '0',
          'aria-label': '我的生命值',
        },
      },
      this.selfHpFill,
    );
    this.selfHpText = el('span', { class: 'hpbar__text', testid: 'self-hp-text', text: '— / —' });
    this.selfCpm = el('b', { testid: 'self-cpm', text: '—' });
    this.selfSpells = el('b', { testid: 'self-spells', text: '0' });
    this.selfAccuracy = el('b', { testid: 'self-accuracy', text: '—' });
    this.selfDamage = el('b', { testid: 'self-damage', text: '0' });
    this.selfRank = el('b', { testid: 'self-rank', text: '—' });

    this.finalRank = el('div', { class: 'tile__value', testid: 'final-self-rank', text: '—' });
    this.finalDamage = el('div', { class: 'tile__value', testid: 'final-self-damage', text: '0' });
    this.finalSpells = el('div', { class: 'tile__value', testid: 'final-self-spells', text: '0' });
    this.finalCpm = el('div', { class: 'tile__value', testid: 'final-self-cpm', text: '—' });
    this.finalAccuracy = el('div', { class: 'tile__value', testid: 'final-self-accuracy', text: '—' });

    this.resultTitle = el('h2', { class: 'result__title', testid: 'result-title', text: '' });
    this.resultDetail = el('p', { class: 'result__detail', testid: 'result-detail', text: '' });
    this.resultBanner = el(
      'div',
      { class: 'result', testid: 'result-banner', data: { outcome: '', 'end-reason': '' } },
      this.resultTitle,
      this.resultDetail,
    );
    this.finalBody = el('tbody');
    this.saveStatus = el('p', {
      class: 'small muted',
      testid: 'save-status',
      data: { state: 'idle' },
      text: PERSISTENCE_TEXT.idle,
    });
    this.finalPanel = el(
      'section',
      { class: 'results', testid: 'final-panel', hidden: true },
      this.resultBanner,
      el(
        'div',
        { class: 'stat-tiles' },
        el('div', { class: 'tile' }, el('div', { class: 'tile__label', text: '我的名次' }), this.finalRank),
        el('div', { class: 'tile' }, el('div', { class: 'tile__label', text: '造成伤害' }), this.finalDamage),
        el('div', { class: 'tile' }, el('div', { class: 'tile__label', text: '成功施法' }), this.finalSpells),
        el('div', { class: 'tile' }, el('div', { class: 'tile__label', text: '速度 · 字/分钟' }), this.finalCpm),
        el('div', { class: 'tile' }, el('div', { class: 'tile__label', text: '准确率' }), this.finalAccuracy),
      ),
      el(
        'div',
        { class: 'results__wrap' },
        el(
          'table',
          { class: 'results__table', testid: 'final-results' },
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { text: '名次' }),
              el('th', { text: '玩家' }),
              el('th', { class: 'num', text: '剩余生命' }),
              el('th', { class: 'num', text: '造成伤害' }),
              el('th', { class: 'num', text: '施法' }),
              el('th', { class: 'num', text: '字/分钟' }),
              el('th', { class: 'num', text: '准确率' }),
            ),
          ),
          this.finalBody,
        ),
      ),
      this.saveStatus,
      el(
        'div',
        { class: 'btn-row' },
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          testid: 'rematch',
          text: '再来一局',
          on: { click: () => this.actions.onRematch() },
        }),
        el('button', {
          class: 'btn btn--ghost',
          type: 'button',
          testid: 'final-leave',
          text: '离开房间',
          on: { click: () => this.actions.onLeave() },
        }),
      ),
    );

    this.el = el(
      'section',
      {
        class: 'combat',
        testid: 'battle-panel',
        data: {
          phase: '',
          'match-id': '',
          'spell-index': '',
          'spells-cast': '',
          'input-state': 'idle',
          render: 'dom',
          deadline: 0,
          'started-at': '',
          'end-reason': '',
          'hp-state': 'ok',
          'long-target': false,
        },
      },
      this.threat,
      this.arena,
      this.notices,
      el(
        'div',
        { class: 'station' },
        this.eliminatedNotice,
        el(
          'div',
          { class: 'station__head' },
          el(
            'div',
            { class: 'spell-head' },
            el('span', { class: 'spell-head__art' }, this.spellArt, this.spellGlyph),
            this.spellName,
            this.elementTag,
          ),
          el(
            'div',
            { class: 'station__progress' },
            this.spellProgress,
            this.spellProgressText,
          ),
        ),
        this.targetWrap,
        this.typeArea,
        el(
          'div',
          { class: 'selfbar', testid: 'self-status' },
          el(
            'div',
            { class: 'selfbar__hp' },
            el('span', { class: 'selfbar__label', text: '我的生命' }),
            this.selfHpBar,
            this.selfHpText,
          ),
          el(
            'div',
            { class: 'selfbar__stats' },
            el('span', {}, 'CPM ', this.selfCpm),
            el('span', {}, '施法 ', this.selfSpells),
            el('span', {}, '准确率 ', this.selfAccuracy),
            el('span', {}, '伤害 ', this.selfDamage),
            el('span', {}, '名次 ', this.selfRank),
          ),
        ),
      ),
      el(
        'div',
        { class: 'combat__side' },
        el('h3', { class: 'combat__side-title', text: '施法记录' }),
        this.logList,
      ),
      this.finalPanel,
    );

    this.typing = new TypingController(this.textarea, {
      onCommit: (commit) => this.actions.onCommit(commit),
      onLocalState: (state) => this.renderLocalState(state),
      onPasteBlocked: () => {
        this.showPasteNotice('已阻止粘贴：咒文必须自己输入，这样伤害才算数。');
        this.actions.onPasteBlocked();
      },
      onTooLong: () => {
        this.showPasteNotice('输入过长，已截断到 256 个字符。');
      },
    });

    // The effect canvas shares the target's box, so it follows viewport resizes.
    window.addEventListener('resize', this.handleViewportResize);
  }

  /** Defined once, used by the resize listener and by the destroy path. */
  private readonly handleViewportResize = (): void => {
    this.typingFx?.resize();
    // The target font is viewport-relative, so a resize can change the wrap.
    this.measureTargetLines();
  };

  /**
   * How many lines the target actually occupies. A hard 39-50 character spell
   * wraps to two lines, and the arena — not the player's own health bar — gives
   * that height back so the input and the self bar stay on a 900px screen.
   */
  private measureTargetLines(): void {
    const first = this.charNodes[0];
    const run = first?.parentElement;
    if (!first || !run) return;
    const line = first.getBoundingClientRect().height;
    if (line <= 0) return;
    setData(this.el, 'long-target', run.getBoundingClientRect().height > line * 1.5);
  }

  get typingController(): TypingController {
    return this.typing;
  }

  /** Where the renderer mounts its canvas. */
  get renderHost(): HTMLElement {
    return this.canvasHost;
  }

  destroy(): void {
    this.typing.destroy();
    this.stage?.destroy();
    this.stage = null;
    this.typingFx?.destroy();
    this.typingFx = null;
    this.fxLive = false;
    window.removeEventListener('resize', this.handleViewportResize);
  }

  /** Where the typing-effect renderer mounts its canvas. */
  get fxRenderHost(): HTMLElement {
    return this.fxHost;
  }

  attachTypingEffects(effects: TypingEffects): void {
    this.typingFx = effects;
    this.fxLive = true;
    this.fxHost.dataset.state = 'ready';
    effects.resize();
  }

  /**
   * A failed text-effect layer is cosmetic: it is switched off and reported in
   * place, while the arena, the spell and the input keep working untouched.
   */
  markTypingEffectsFailed(): void {
    this.typingFx = null;
    this.fxLive = false;
    this.fxHost.dataset.state = 'failed';
  }

  attachStage(stage: BattleStage): void {
    this.stage = stage;
    this.canvasHost.dataset.state = 'ready';
    setData(this.arena, 'render', 'canvas');
    setData(this.el, 'render', 'canvas');
    const snapshot = this.snapshot;
    if (snapshot) stage.update(snapshot, this.selfId);
  }

  markStageFailed(): void {
    this.canvasHost.dataset.state = 'failed';
    setData(this.arena, 'render', 'dom');
    setData(this.el, 'render', 'dom');
  }

  /** Inline notice for connection state while the combat panel is on screen. */
  setNotice(message: string | null, tone: 'info' | 'warn' | 'error' = 'info'): void {
    clear(this.notices);
    if (!message) return;
    append(this.notices, [
      el(
        'div',
        { class: 'notice', data: { tone } },
        el('span', { class: 'notice__icon', text: tone === 'error' ? '✖' : '⚠' }),
        el('div', { text: message }),
      ),
    ]);
  }

  sync(snapshot: RoomSnapshot, selfId: string, options: { reconnected: boolean }): void {
    this.snapshot = snapshot;
    this.selfId = selfId;
    const players = [...snapshot.players].sort((a, b) => a.slot - b.slot);
    const self = players.find((player) => player.id === selfId);
    const capacity = snapshot.mode === 'quick' ? 2 : 4;
    const alive = players.filter((player) => player.eliminatedAt === null);
    const myTarget = self && self.eliminatedAt === null ? nextAliveSlot(alive, self.slot, capacity) : null;
    const aimingAtMe = self
      ? alive.filter(
          (player) => player.id !== self.id && nextAliveSlot(alive, player.slot, capacity) === self.slot,
        )
      : [];

    setData(this.el, 'phase', snapshot.phase);
    setData(this.el, 'match-id', snapshot.matchId ?? '');
    setData(this.el, 'deadline', snapshot.deadline);
    setData(this.el, 'started-at', snapshot.startedAt ?? '');
    setData(this.el, 'end-reason', snapshot.endReason ?? '');
    setData(this.el, 'spell-index', self ? self.spellIndex : '');
    setData(this.el, 'spells-cast', self ? self.spellsCast : '');
    setData(this.arena, 'seats', players.length);
    this.arena.style.setProperty('--seats', String(Math.max(1, players.length)));

    const hpRatio = self && self.maxHp > 0 ? self.hp / self.maxHp : 1;
    setData(
      this.el,
      'hp-state',
      !self || self.eliminatedAt !== null
        ? 'down'
        : hpRatio <= CRITICAL_HP_RATIO
          ? 'critical'
          : hpRatio <= LOW_HP_RATIO
            ? 'low'
            : 'ok',
    );

    this.renderSpell(snapshot, self, options.reconnected);
    this.renderSeats(players, self, myTarget, aimingAtMe);
    this.renderThreat(snapshot, self, myTarget, aimingAtMe, players);
    this.renderLog(snapshot.events, players);
    this.renderSelfHud(self);
    this.renderPhase(snapshot, self);
    this.renderResults(snapshot, players, self);
    this.updateTimer();

    if (self) {
      const judgeable = snapshot.phase === 'playing' && self.eliminatedAt === null;
      this.typing.setLocked(!judgeable);
      this.textarea.readOnly = !judgeable;
    }
    // One authoritative pass: local typing flags may have moved during the
    // render above, so the input state is derived last and in one place.
    this.renderInputState();
    this.revealResults();
    this.stage?.update(snapshot, selfId);
  }

  /**
   * Binds the input to the player's current spell. The transition is driven only
   * by the authoritative `spellIndex`: an ordinary ack at the same index never
   * rewrites the field, and a snapshot whose index is older than the local one
   * cannot resurrect a spell the player already finished.
   */
  private renderSpell(snapshot: RoomSnapshot, self: Player | undefined, reconnected: boolean): void {
    const matchId = snapshot.matchId ?? '';
    const index = self ? self.spellIndex : -1;
    const spell = snapshot.spell;
    const freshMatch = matchId !== this.appliedMatchId;

    if (freshMatch) {
      this.appliedMatchId = matchId;
      this.appliedIndex = -1;
      this.appliedKey = '';
      this.lastEventKey = '';
      this.localProgress = 0;
      this.localTargetLength = 0;
      this.localPending = false;
      this.localAccuracy = null;
      this.fxIndex = -1;
      this.fxProgress = 0;
      this.setCastFeedback(null, 'idle');
    }

    if (!spell || index < 0) {
      if (this.renderedTarget) this.clearTarget();
      // Nothing is bindable: the field must stop judging and stop emitting.
      this.typing.endSpell();
      return;
    }

    if (spell.text !== this.renderedTarget) {
      this.renderedTarget = spell.text;
      this.renderTarget(spell.text);
      setText(this.spellName, spell.name);
      const art = spellIconFor(spell.element, index);
      if (this.spellArt.getAttribute('src') !== art) {
        this.spellArt.hidden = false;
        this.spellArt.setAttribute('src', art);
      }
      const glyph = elementGlyph(spell.element);
      if (this.spellGlyph.getAttribute('src') !== glyph) {
        this.spellGlyph.setAttribute('src', glyph);
      }
      this.spellGlyph.alt = `${ELEMENT_LABELS[spell.element]}元素`;
      setText(this.elementTag, ELEMENT_LABELS[spell.element]);
      this.elementTag.style.color = ELEMENT_CSS[spell.element];
      this.el.dataset.element = spell.element;
    }

    if (freshMatch || index > this.appliedIndex) {
      const accepted = this.appliedIndex >= 0 && index > this.appliedIndex;
      this.appliedIndex = index;
      this.appliedKey = `${matchId}:${index}`;
      // A new spell starts with nothing celebrated, so the cast that produced it
      // and the bind itself can never fire the typing effect.
      this.fxIndex = index;
      this.fxProgress = 0;
      // Arm the renderer for the new spell BEFORE the controller emits, because
      // the draft adopted just below moves the confirmed prefix: resetting after
      // it would strand the meter, the status line and the aim glyph at zero
      // while the field already holds the restored text.
      this.stage?.typing(0, spell.element);
      this.typing.startSpell({ matchId, spellIndex: index, target: spell.text });
      // The accepted draft is adopted once, when the spell opens: a late ack
      // must never rewrite text the player has already edited.
      this.adoptField(() => this.typing.restoreDraft(snapshot.selfInput));
      if (accepted) {
        this.setCastFeedback(spell.element, 'done');
        this.setTip('施法成功，继续输入下一条咒文。');
      } else {
        this.setCastFeedback(spell.element, 'idle');
        this.setTip('');
      }
      // Entering combat should not need a click: focus the field once, and only
      // when nothing interactive already holds focus.
      if (snapshot.phase === 'playing' && !self?.eliminatedAt) this.focusInput();
      return;
    }

    if (index < this.appliedIndex) return;

    if (reconnected) {
      // A real reconnect reconciles once with server truth at the same index.
      this.adoptField(() => this.typing.resync(snapshot.selfInput));
      return;
    }
    if (!this.appliedKey) {
      this.appliedKey = `${matchId}:${index}`;
      this.typing.startSpell({ matchId, spellIndex: index, target: spell.text });
      this.adoptField(() => this.typing.restoreDraft(snapshot.selfInput));
    }
  }

  private clearTarget(): void {
    this.renderedTarget = '';
    this.charNodes = [];
    clear(this.spellText);
  }

  private renderSeats(
    players: Player[],
    self: Player | undefined,
    myTarget: number | null,
    aimingAtMe: Player[],
  ): void {
    const isAimingAtMe = (userId: string) => aimingAtMe.some((player) => player.id === userId);
    for (const [userId, card] of this.cards) {
      if (!players.some((player) => player.id === userId)) {
        card.root.remove();
        this.cards.delete(userId);
      }
    }

    for (const player of players) {
      const isSelf = player.id === self?.id;
      let card = this.cards.get(player.id);
      if (!card) {
        card = this.createSeatCard(player.id);
        this.cards.set(player.id, card);
      }
      // Re-appending keeps the DOM order equal to the slot order the arena and
      // the canvas columns share, even after a seat is emptied and refilled.
      this.arenaSeats.appendChild(card.root);
      const eliminated = player.eliminatedAt !== null;
      const hp = Math.max(0, player.hp);
      const percent = percentOf(hp, player.maxHp);
      setData(card.root, 'self', isSelf);
      setData(card.root, 'slot', player.slot);
      setData(card.root, 'connected', player.connected);
      setData(card.root, 'target', myTarget !== null && player.slot === myTarget);
      setData(card.root, 'aiming', isAimingAtMe(player.id));
      setData(card.root, 'eliminated', eliminated);
      setData(card.root, 'hp', hp);
      setData(card.root, 'max-hp', player.maxHp);
      setText(card.name, `${player.username}${isSelf ? '（你）' : ''}`);
      card.targetMark.hidden = !(myTarget !== null && player.slot === myTarget);
      card.aimMark.hidden = !isAimingAtMe(player.id);
      card.downMark.hidden = !eliminated;
      card.offlineMark.hidden = player.connected;

      setData(card.hpBar, 'hp', hp);
      setData(card.hpBar, 'max-hp', player.maxHp);
      card.hpBar.setAttribute('aria-valuemax', String(Math.max(0, player.maxHp)));
      card.hpBar.setAttribute('aria-valuenow', String(hp));
      card.hpBar.setAttribute('aria-valuetext', formatHealth(hp, player.maxHp));
      card.hpBar.dataset.state = eliminated ? 'down' : percent <= 15 ? 'critical' : percent <= 35 ? 'low' : 'ok';
      card.hpFill.style.width = `${percent}%`;
      setText(card.hpText, formatHealth(hp, player.maxHp));

      const cast = percentOf(player.progress, player.spellLength);
      card.castBar.setAttribute('aria-valuenow', String(cast));
      card.castBar.setAttribute(
        'aria-valuetext',
        `${player.progress} / ${player.spellLength} 字`,
      );
      card.castFill.style.width = `${cast}%`;
    }
  }

  /**
   * The combat status strip. It lives outside the arena in normal flow, so the
   * cue can never sit on the fighters, and it always carries a line of text:
   * a neutral standing summary when nothing is urgent, the threat when it is.
   * Always present means no layout shift while the player is typing.
   */
  private renderThreat(
    snapshot: RoomSnapshot,
    self: Player | undefined,
    myTarget: number | null,
    aimingAtMe: Player[],
    players: Player[],
  ): void {
    if (!self) return;
    const hpRatio = self.maxHp > 0 ? self.hp / self.maxHp : 1;
    const alive = players.filter((player) => player.eliminatedAt === null);
    const live = snapshot.phase === 'playing' && self.eliminatedAt === null;

    if (self.eliminatedAt !== null) {
      setData(this.threat, 'tone', 'none');
      setData(this.threat, 'threat', false);
      setText(this.threat, '你已出局 · 可以观看剩余战斗，或直接离开');
      return;
    }
    if (!live) {
      setData(this.threat, 'tone', 'none');
      setData(this.threat, 'threat', false);
      setText(
        this.threat,
        snapshot.phase === 'lobby' || snapshot.phase === 'generating'
          ? `主题「${snapshot.theme}」· 战场尚未开始`
          : `主题「${snapshot.theme}」· 倒数结束后立即开始输入`,
      );
      return;
    }

    const aiming = aimingAtMe.map((player) => player.username).join('、');
    const target = players.find((player) => player.slot === myTarget)?.username;
    const low = hpRatio <= CRITICAL_HP_RATIO ? 'critical' : hpRatio <= LOW_HP_RATIO ? 'low' : 'ok';
    const parts: string[] = [];
    if (aiming) parts.push(`${aiming} 正在瞄准你`);
    if (low === 'critical') parts.push('生命极低，再中一次就会出局');
    else if (low === 'low') parts.push('生命偏低，稳住输出');

    const urgent = aiming !== '' || low !== 'ok';
    setData(this.threat, 'tone', urgent ? (low === 'ok' ? 'warn' : 'critical') : 'none');
    setData(this.threat, 'threat', urgent);
    setText(
      this.threat,
      urgent
        ? parts.join(' · ')
        : `主题「${snapshot.theme}」· 目标 ${target ?? '—'} · 存活 ${alive.length} / ${players.length} 人`,
    );
  }

  private renderLog(events: CombatEvent[], players: Player[]): void {
    const key = events.length === 0 ? 'none' : `${events[0].seq}:${events[events.length - 1].seq}:${events.length}`;
    if (key === this.lastEventKey) return;
    this.lastEventKey = key;
    clear(this.logList);
    if (events.length === 0) {
      append(this.logList, [
        el('p', { class: 'small faint', testid: 'combat-log-empty', text: '还没有人完成咒文。' }),
      ]);
      return;
    }
    const nameOf = (id: string) => players.find((player) => player.id === id)?.username ?? '未知玩家';
    const recent = events.slice(Math.max(0, events.length - LOG_LIMIT));
    for (const event of recent) {
      const attacker = nameOf(event.attackerId);
      const target = nameOf(event.targetId);
      append(this.logList, [
        el(
          'div',
          {
            class: 'log-entry',
            testid: 'combat-log-entry',
            data: {
              seq: event.seq,
              attacker: event.attackerId,
              target: event.targetId,
              damage: event.damage,
              element: event.element,
              eliminated: event.eliminated,
            },
          },
          el('span', {
            class: 'log-entry__text',
            text: `${attacker} → ${target}`,
          }),
          el('span', {
            class: 'log-entry__damage',
            data: { element: event.element },
            text: `-${event.damage}`,
          }),
          el('span', { class: 'log-entry__hp', text: `${event.targetHp} 剩余` }),
          event.eliminated
            ? el('span', { class: 'mark mark--down', text: '击倒' })
            : null,
        ),
      ]);
    }
  }

  private renderSelfHud(self: Player | undefined): void {
    const maxHp = self?.maxHp ?? 0;
    const hp = self ? Math.max(0, self.hp) : 0;
    const percent = percentOf(hp, maxHp);
    this.selfHpBar.setAttribute('aria-valuemax', String(Math.max(0, maxHp)));
    this.selfHpBar.setAttribute('aria-valuenow', String(hp));
    this.selfHpBar.setAttribute('aria-valuetext', maxHp > 0 ? formatHealth(hp, maxHp) : '—');
    this.selfHpFill.style.width = `${percent}%`;
    this.selfHpBar.dataset.state =
      maxHp <= 0
        ? 'unknown'
        : hp <= 0
          ? 'down'
          : percent <= 15
            ? 'critical'
            : percent <= 35
              ? 'low'
              : 'ok';
    setText(this.selfHpText, maxHp > 0 ? formatHealth(hp, maxHp) : '— / —');
    setText(this.selfCpm, self ? String(Math.round(self.cpm)) : '—');
    setText(this.selfSpells, String(self?.spellsCast ?? 0));
    setText(this.selfAccuracy, formatAccuracyPercent(self?.accuracy ?? null));
    setText(this.selfDamage, String(self?.damageDealt ?? 0));
    setText(this.selfRank, self?.rank == null ? '—' : `#${self.rank}`);
  }

  private renderPhase(snapshot: RoomSnapshot, self: Player | undefined): void {
    const phase = snapshot.phase;
    const isPlaying = phase === 'playing';
    const isCountdown = phase === 'countdown';
    const showSpell = Boolean(snapshot.spell);
    const eliminated = Boolean(self && self.eliminatedAt !== null);

    this.countdown.hidden = !isCountdown;
    this.spellText.hidden = !showSpell;
    const settled = phase === 'lobby' || phase === 'generating' || phase === 'finished';
    this.textarea.hidden = settled;
    this.typeArea.hidden = settled;
    if (!showSpell) {
      // The room stops sending a viewer's spell once that viewer is out, so the
      // station says so instead of claiming nothing has appeared yet.
      setText(this.spellName, eliminated ? '你已出局 · 不再有咒文' : '咒文尚未显现');
      setText(this.elementTag, '');
      this.renderSpellMeter(0, 0);
    }

    this.eliminatedNotice.hidden = !eliminated;
    if (eliminated) {
      setData(this.eliminatedNotice, 'state', 'eliminated');
      const rank = self?.rank == null ? '' : `（第 ${self.rank} 名）`;
      setText(
        this.eliminatedNotice,
        `你已被击倒${rank}。输入已停止，可以观看剩下的战斗——离开或等待结算都不会影响结果。`,
      );
    }

    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.warnedLastThirty = false;
      if (phase === 'countdown') {
        this.setCastFeedback(snapshot.spell?.element ?? null, 'idle');
        this.setTip('倒数结束后，输入咒文即可施法。');
      } else if (phase === 'playing') {
        if (!eliminated && this.appliedKey) {
          this.focusInput();
          this.setCastFeedback(snapshot.spell?.element ?? null, 'idle');
        }
        this.setTip('');
      } else if (phase === 'finished') {
        this.setTip('');
        this.resultScrollPending = true;
      }
    }

    if (!isPlaying && this.renderedTarget && !this.charNodes.length) {
      // A settled display rebuilt from scratch (reload/rejoin) still shows the target.
      this.renderTarget(this.renderedTarget);
    }
    if (!isPlaying && this.renderedTarget) {
      const settledText = this.textarea.value !== '' ? this.textarea.value : snapshot.selfInput;
      this.paintChars(settledText, true);
      this.renderStatus({
        progress: self?.progress ?? prefixLength(this.renderedTarget, settledText),
        targetLength: [...this.renderedTarget].length,
        accuracy: self?.accuracy ?? null,
      });
    }
  }

  private renderResults(
    snapshot: RoomSnapshot,
    players: Player[],
    self: Player | undefined,
  ): void {
    if (snapshot.phase !== 'finished') {
      this.finalPanel.hidden = true;
      return;
    }
    this.finalPanel.hidden = false;
    const ranked = [...players].sort((a, b) => {
      const rankA = a.rank ?? Number.POSITIVE_INFINITY;
      const rankB = b.rank ?? Number.POSITIVE_INFINITY;
      if (rankA !== rankB) return rankA - rankB;
      return b.hp - a.hp || b.damageDealt - a.damageDealt || a.slot - b.slot;
    });
    clear(this.finalBody);
    for (const player of ranked) {
      const isSelf = player.id === self?.id;
      const eliminated = player.eliminatedAt !== null;
      append(this.finalBody, [
        el(
          'tr',
          {
            testid: 'final-row',
            data: {
              user: player.id,
              rank: player.rank ?? '',
              self: isSelf,
              eliminated,
              hp: Math.max(0, player.hp),
            },
          },
          el('td', {
            class: 'rank-medal',
            testid: 'final-row-rank',
            data: { rank: player.rank ?? '' },
            text: player.rank === null ? '—' : `#${player.rank}`,
          }),
          el('td', { text: `${player.username}${isSelf ? '（你）' : ''}${eliminated ? ' · 出局' : ''}` }),
          el('td', {
            class: 'num',
            testid: 'final-row-hp',
            data: { hp: Math.max(0, player.hp), 'max-hp': player.maxHp },
            text: formatHealth(player.hp, player.maxHp),
          }),
          el('td', { class: 'num', testid: 'final-row-damage', text: String(player.damageDealt) }),
          el('td', { class: 'num', testid: 'final-row-spells', text: String(player.spellsCast) }),
          el('td', { class: 'num', testid: 'final-row-cpm', text: String(Math.round(player.cpm)) }),
          el('td', {
            class: 'num',
            testid: 'final-row-accuracy',
            text: formatAccuracyPercent(player.accuracy),
          }),
        ),
      ]);
    }

    const rank = self?.rank ?? null;
    setText(this.finalRank, rank === null ? '—' : `#${rank}`);
    setText(this.finalDamage, String(self?.damageDealt ?? 0));
    setText(this.finalSpells, String(self?.spellsCast ?? 0));
    setText(this.finalCpm, self ? String(Math.round(self.cpm)) : '—');
    setText(this.finalAccuracy, formatAccuracyPercent(self?.accuracy ?? null));
    setData(this.finalPanel, 'outcome', rank === 1 ? 'win' : self?.eliminatedAt != null ? 'down' : 'place');
    const outcome = rank === 1 ? 'win' : self?.eliminatedAt != null ? 'down' : 'place';
    setData(this.resultBanner, 'outcome', outcome);
    setData(this.resultBanner, 'end-reason', snapshot.endReason ?? '');
    setText(
      this.resultTitle,
      outcome === 'win'
        ? '胜利'
        : outcome === 'down'
          ? `你被击倒了${rank === null ? '' : ` · 第 ${rank} 名`}`
          : rank === null
            ? '对局结束'
            : `第 ${rank} 名`,
    );
    const reason = snapshot.endReason ? END_REASON_LABELS[snapshot.endReason] : '对局已结束';
    const duration =
      snapshot.startedAt !== null && snapshot.endedAt !== null
        ? ` · 战斗时长 ${formatSeconds(snapshot.endedAt - snapshot.startedAt)} 秒`
        : '';
    setText(
      this.resultDetail,
      self
        ? `${reason}${duration}。你完成 ${self.spellsCast} 次施法，造成 ${self.damageDealt} 点伤害，剩余生命 ${formatHealth(self.hp, self.maxHp)}。`
        : `${reason}${duration}。`,
    );

    setData(this.saveStatus, 'state', snapshot.persistence);
    setText(this.saveStatus, PERSISTENCE_TEXT[snapshot.persistence]);
  }

  private createSeatCard(userId: string): SeatCard {
    const name = el('span', { class: 'seatcard__name', testid: 'arena-seat-name', text: '' });
    const targetMark = seatMarker('arena-target-mark', 'mark--target', '目标');
    const aimMark = seatMarker('arena-aim-mark', 'mark--aim', '瞄准你');
    const downMark = seatMarker('arena-down-mark', 'mark--down', '出局');
    const offlineMark = seatMarker('arena-offline-mark', 'mark--offline', '离线');
    const hpFill = el('div', { class: 'hpbar__fill', testid: 'arena-hp-fill' });
    const hpBar = el(
      'div',
      {
        class: 'hpbar',
        testid: 'arena-hp',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '0',
          'aria-valuenow': '0',
          'aria-label': '生命值',
        },
      },
      hpFill,
    );
    const hpText = el('span', { class: 'hpbar__text', testid: 'arena-hp-text', text: '—' });
    const castFill = el('div', { class: 'castbar__fill' });
    const castBar = el(
      'div',
      {
        class: 'castbar',
        testid: 'player-progress',
        attrs: {
          role: 'progressbar',
          'aria-valuemin': '0',
          'aria-valuemax': '100',
          'aria-valuenow': '0',
          'aria-label': '咒文进度',
        },
      },
      castFill,
    );
    const root = el(
      'div',
      {
        class: 'seatcard',
        testid: 'arena-seat',
        data: { user: userId, self: false, slot: 0 },
        attrs: { role: 'listitem' },
      },
      el('div', { class: 'seatcard__top' }, name, targetMark, aimMark, downMark, offlineMark),
      el('div', { class: 'seatcard__hp' }, hpBar, hpText),
      castBar,
    );
    return { root, name, targetMark, aimMark, downMark, offlineMark, hpBar, hpFill, hpText, castBar, castFill };
  }

  private renderLocalState(state: TypingLocalState): void {
    this.localProgress = state.progress;
    this.localTargetLength = state.targetLength;
    this.localPending = state.pending;
    const self = this.snapshot?.players.find((player) => player.id === this.selfId);
    this.localAccuracy = state.attempts === 0 ? (self?.accuracy ?? null) : state.accuracy;

    this.renderStatus({
      progress: state.progress,
      targetLength: state.targetLength,
      errors: state.errors,
      accuracy: this.localAccuracy,
      composing: state.composing,
    });
    this.renderSpellMeter(state.progress, state.targetLength);
    this.paintChars(state.text, state.locked || (state.pending && this.snapshot?.phase !== 'playing'));

    this.renderInputState();
    setData(this.el, 'wrong-extra', [...state.text].length > this.targetChars.length);
    this.emitTypingFx(state);

    if (state.pending) {
      this.setCastFeedback(this.snapshot?.spell?.element ?? null, 'pending');
      this.setTip('施法中，请稍候…');
    } else if (state.progress > 0 && this.castFeedback.dataset.state === 'done') {
      // The first keystroke of the next spell clears the previous cast banner.
      this.setCastFeedback(this.snapshot?.spell?.element ?? null, 'idle');
    } else if (!state.composing && !state.pending && this.castFeedback.dataset.state === 'pending') {
      this.setCastFeedback(this.snapshot?.spell?.element ?? null, 'idle');
    }

    if (this.snapshot) {
      this.renderSelfProgressFromLocal(state.progress, state.targetLength);
      const self = this.snapshot.players.find((player) => player.id === this.selfId);
      if (self) this.renderThreatFromState(this.snapshot, self);
    }

    // Only a confirmed, non-composing value reaches the renderer: the stage's
    // aim glyph must never follow provisional composition text.
    if (!state.composing && this.snapshot?.spell) {
      this.stage?.typing(state.progress, this.snapshot.spell.element);
    }
  }

  /**
   * Field adoptions (fresh page, rejoin, reconnect) move the confirmed prefix
   * without anyone typing: they must never look like typed characters.
   */
  private adoptField(action: () => void): void {
    this.fxAdopting = true;
    try {
      action();
    } finally {
      this.fxAdopting = false;
    }
  }

  /**
   * One small burst of particles on the glyph the player just confirmed. Driven
   * only by the field's own confirmed state — never by a server ack, a
   * reconnect, a replay, a retraction, an IME composition or a wrong character —
   * and only when the effect layer is alive and motion is not reduced.
   */
  private emitTypingFx(state: TypingLocalState): void {
    if (this.fxIndex !== this.appliedIndex) {
      this.fxIndex = this.appliedIndex;
      this.fxProgress = 0;
    }
    // A composition never advances the celebrated prefix: the provisional text
    // is not judged, so nothing may be celebrated until it is committed.
    const progress = state.composing ? this.fxProgress : Math.max(0, state.progress);
    if (progress === this.fxProgress) return;
    const previous = this.fxProgress;
    this.fxProgress = progress;
    if (progress < previous) return; // retraction: re-arm, celebrate nothing
    if (this.fxAdopting) return;
    if (!this.fxLive || !this.typingFx || motion.reduced) return;

    const snapshot = this.snapshot;
    const self = snapshot?.players.find((player) => player.id === this.selfId);
    if (!snapshot || snapshot.phase !== 'playing' || !self || self.eliminatedAt !== null) return;

    const glyph = this.charNodes[progress - 1];
    if (!glyph) return;
    const host = this.fxHost.getBoundingClientRect();
    const box = glyph.getBoundingClientRect();
    if (box.width <= 0 && box.height <= 0) return;
    this.typingFx.emit(
      box.left - host.left + box.width / 2,
      box.top - host.top + box.height * 0.8,
      snapshot.spell?.element ?? 'arcane',
      Math.min(progress - previous, TYPING_FX_MAX_PER_EMIT),
    );
  }

  /** The player's own cast ring tracks local typing; opponents come from snapshots. */
  private renderSelfProgressFromLocal(progress: number, targetLength: number): void {
    const card = this.cards.get(this.selfId);
    if (!card) return;
    const percent = percentOf(progress, targetLength);
    card.castBar.setAttribute('aria-valuenow', String(percent));
    card.castBar.setAttribute('aria-valuetext', `${progress} / ${targetLength} 字`);
    card.castFill.style.width = `${percent}%`;
  }

  private renderThreatFromState(snapshot: RoomSnapshot, self: Player): void {
    const players = [...snapshot.players].sort((a, b) => a.slot - b.slot);
    const capacity = snapshot.mode === 'quick' ? 2 : 4;
    const alive = players.filter((player) => player.eliminatedAt === null);
    const aiming = alive.filter(
      (player) => player.id !== self.id && nextAliveSlot(alive, player.slot, capacity) === self.slot,
    );
    this.renderThreat(snapshot, self, nextAliveSlot(alive, self.slot, capacity), aiming, players);
  }

  /**
   * The one place that decides the input state the tests and the player read:
   * a finished match is locked, a non-judging phase is idle, an eliminated
   * player is out, and a live spell distinguishes idle/typing/pending/complete.
   */
  private renderInputState(): void {
    const snapshot = this.snapshot;
    const self = snapshot?.players.find((player) => player.id === this.selfId);
    const eliminated = Boolean(self && self.eliminatedAt !== null);
    const state = !snapshot
      ? 'idle'
      : snapshot.phase === 'finished'
        ? 'locked'
        : snapshot.phase !== 'playing'
          ? 'idle'
          : eliminated
            ? 'eliminated'
            : this.localPending
              ? 'pending'
              : this.castFeedback.dataset.state === 'done'
                ? 'complete'
                : this.localProgress > 0
                  ? 'typing'
                  : 'idle';
    setData(this.el, 'input-state', state);
  }

  private renderSpellMeter(progress: number, targetLength: number): void {
    const bound = targetLength > 0;
    const percent = percentOf(progress, targetLength);
    this.spellProgress.setAttribute('aria-valuenow', String(percent));
    this.spellProgress.setAttribute(
      'aria-valuetext',
      bound ? `${Math.max(0, progress)} / ${targetLength} 字` : '—',
    );
    this.spellProgressFill.style.width = `${percent}%`;
    setText(
      this.spellProgressText,
      bound ? `${Math.max(0, progress)} / ${targetLength} 字` : '—',
    );
  }

  private renderStatus(state: {
    progress: number;
    targetLength: number;
    errors?: number;
    accuracy: number | null;
    composing?: boolean;
  }): void {
    const parts: string[] = [];
    if (state.composing) parts.push('输入法组合中，暂不判定');
    parts.push(`已正确 ${state.progress} / ${state.targetLength} 字`);
    if (state.errors !== undefined && state.errors > 0) parts.push(`错误 ${state.errors} 次`);
    parts.push(`准确率 ${formatAccuracyPercent(state.accuracy)}`);
    setText(this.inputStatus, parts.join(' · '));
  }

  /**
   * Character feedback is derived only from the text that may be judged: the
   * confirmed local value while typing, or the server-accepted value when the
   * field is empty (fresh page / rejoin). A settled match paints every
   * character green instead of leaving the fresh spans unclassified.
   */
  private paintChars(typedText: string, settled: boolean): void {
    if (!this.charNodes.length) return;
    const typed = [...typedText];
    const target = this.targetChars;
    const matched = prefixLength(target.join(''), typedText);
    for (let index = 0; index < this.charNodes.length; index += 1) {
      const node = this.charNodes[index];
      let className = 'ch';
      if (index < matched) className = 'ch ch--ok';
      else if (index === matched) {
        const wrong = typed[index] !== undefined && typed[index] !== target[index];
        className = wrong ? 'ch ch--err' : 'ch ch--cur';
        node.title = wrong ? `第 ${index + 1} 个字符应为「${target[index]}」` : '';
      }
      if (settled) className = 'ch ch--ok ch--done';
      if (node.className !== className) node.className = className;
    }
  }

  private renderTarget(target: string): void {
    this.targetChars = [...target];
    this.charNodes = [];
    this.clearTarget();
    this.renderedTarget = target;
    const visible = el('span', { attrs: { 'aria-hidden': 'true' } });
    for (const char of this.targetChars) {
      const node = el('span', { class: 'ch', text: char });
      this.charNodes.push(node);
      visible.appendChild(node);
    }
    append(this.spellText, [
      el('span', { class: 'sr-only', testid: 'spell-text-plain', text: `目标咒文：${target}` }),
      visible,
    ]);
    this.paintChars('', false);
    // A wrapped target changes the box the effect canvas covers, and it costs a
    // line of height that the arena has to give back.
    this.typingFx?.resize();
    this.measureTargetLines();
  }

  /** Called by the room view when the connection drops or returns. */
  setConnectedHint(state: 'open' | 'connecting' | 'reconnecting' | 'closed'): void {
    if (state === 'open') {
      this.setNotice(null);
      return;
    }
    const message =
      state === 'reconnecting'
        ? '连接中断，正在重连…对战计时不会暂停。'
        : state === 'connecting'
          ? '正在连接房间…'
          : '连接已关闭。';
    this.setNotice(message, state === 'closed' ? 'error' : 'warn');
  }

  /**
   * The result is the payoff, so the settled screen is brought into view once —
   * after the panel is actually visible, otherwise there is nothing to scroll to.
   * Reduced motion gets the jump without the animation.
   */
  private revealResults(): void {
    if (!this.resultScrollPending) return;
    this.resultScrollPending = false;
    if (this.finalPanel.hidden) return;
    this.finalPanel.scrollIntoView({
      block: 'start',
      behavior: motion.reduced ? 'auto' : 'smooth',
    });
  }

  /** Focus the typing field unless the player is already on an interactive control. */
  private focusInput(): void {
    const active = document.activeElement;
    const interactive =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLButtonElement ||
      active instanceof HTMLSelectElement ||
      active instanceof HTMLAnchorElement;
    if (!interactive) this.textarea.focus();
  }

  private setTip(text: string): void {
    setText(this.tip, text);
  }

  private setCastFeedback(element: Element | null, state: 'idle' | 'pending' | 'done'): void {
    this.castFeedback.dataset.state = state;
    this.castFeedback.dataset.element = element ?? '';
    if (state === 'done') {
      const label = element ? ELEMENT_LABELS[element] : '咒文';
      this.castFeedback.textContent = `${label}命中，下一条咒文已就绪。`;
    } else if (state === 'pending') {
      this.castFeedback.textContent = '施法中…';
    } else {
      this.castFeedback.textContent = element ? '开始输入，完成后立刻施法。' : '等待施法…';
    }
  }

  private showPasteNotice(message: string): void {
    setText(this.pasteNotice, message);
  }

  /**
   * The one global clock. It shows the opening countdown, then the single
   * combat deadline; it never restarts per spell and never shows a frozen value
   * from a phase that has no clock.
   */
  updateTimer(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const phase = snapshot.phase;
    const active = (phase === 'playing' || phase === 'countdown') && snapshot.deadline > 0;

    if (!active) {
      setText(this.timerValue, '—');
      setData(this.timerValue, 'remaining-ms', 0);
      this.timerBox.classList.remove('timer--urgent');
      this.countdown.hidden = phase !== 'countdown';
      setText(
        this.timerLabel,
        phase === 'lobby'
          ? '等待开始'
          : phase === 'generating'
            ? '正在生成咒文'
            : phase === 'finished'
              ? '本局已结束'
              : '等待中',
      );
      return;
    }

    const ms = this.clock.remainingMs(snapshot.deadline);
    setText(this.timerValue, formatSeconds(ms));
    setData(this.timerValue, 'remaining-ms', Math.max(0, Math.round(ms)));
    const urgent = phase === 'playing' && ms <= 30_000;
    this.timerBox.classList.toggle('timer--urgent', urgent && ms <= 10_000);
    this.timerBox.classList.toggle('timer--soon', urgent);
    setText(this.timerLabel, phase === 'playing' ? '剩余战斗时间' : '开场倒数');

    if (phase === 'countdown') {
      this.countdown.hidden = false;
      const seconds = Math.max(0, Math.ceil(ms / 1000));
      setText(this.countdownValue, seconds > 0 ? String(seconds) : '开始');
      setText(
        this.countdownHint,
        snapshot.theme ? `主题「${snapshot.theme}」的咒文已经出现。` : '咒文已经出现。',
      );
    } else {
      this.countdown.hidden = true;
    }

    if (phase === 'playing') {
      const self = snapshot.players.find((player) => player.id === this.selfId);
      const alive = Boolean(self && self.eliminatedAt === null);
      if (ms <= 30_000 && !this.warnedLastThirty && alive && snapshot.players.length > 1) {
        this.warnedLastThirty = true;
        this.setTip('最后 30 秒：截止后按剩余生命排名，稳住输出。');
      }
    }
  }
}

/** Stable arena index for a room: the same room always draws the same arena. */
function arenaIndex(seed: string): number {
  let hash = 7;
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  return hash;
}

/**
 * The next alive seat clockwise from `fromSlot`, mirroring the room's automatic
 * targeting. Returns `null` when nobody else is alive.
 */
function nextAliveSlot(players: Player[], fromSlot: number, capacity: number): number | null {
  const seats = capacity > 0 ? capacity : 4;
  for (let step = 1; step <= seats; step += 1) {
    const slot = (fromSlot + step) % seats;
    if (players.some((player) => player.slot === slot)) return slot;
  }
  return null;
}
