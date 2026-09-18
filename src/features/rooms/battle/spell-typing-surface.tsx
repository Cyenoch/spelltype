import {
  Index,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type JSX,
} from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { Element } from '../../../../shared/protocol';
import { ui } from '../../../ui/primitives';
import { charHook, charTitle, charTones } from './battle-glyphs';
import { styles } from './battle.styles';
import { ELEMENT_CSS } from '../../../ui/elements';
import { motion } from '../../../ui/motion';

const driftCache: string[] = [];
function driftStyle(index: number): string {
  const cached = driftCache[index];
  if (cached !== undefined) return cached;
  const wave = (salt: number): number => {
    const value = Math.sin((index + 1) * 12.9898 + salt) * 43758.5453;
    return value - Math.floor(value);
  };
  const dx = (0.7 + wave(1) * 1.5) * (wave(2) > 0.5 ? 1 : -1);
  const dy = (0.7 + wave(3) * 1.4) * (wave(4) > 0.5 ? 1 : -1);
  const style =
    `--drift-x:${dx.toFixed(2)}px;--drift-y:${dy.toFixed(2)}px;` +
    `--drift-dur:${(4.6 + wave(5) * 3.2).toFixed(2)}s;--drift-delay:${(-wave(6) * 8).toFixed(2)}s`;
  driftCache[index] = style;
  return style;
}

/** One visible spell/input surface shared by real combat and local practice. */
export function SpellTypingSurface(props: {
  target: string;
  text: string;
  settled: boolean;
  /** The owner has accepted completion; matching draft text alone is not enough. */
  completed: boolean;
  composing: boolean;
  element?: Element | null;
  compact?: boolean;
  hidden?: boolean;
  testId?: string;
  attachColumn?: (element: HTMLSpanElement) => void;
  input: Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, 'class' | 'onClick'> & {
    'data-testid': string;
  };
}) {
  const [pageHidden, setPageHidden] = createSignal(document.hidden);
  const handleVisibility = () => setPageHidden(document.hidden);
  document.addEventListener('visibilitychange', handleVisibility);
  onCleanup(() => document.removeEventListener('visibilitychange', handleVisibility));
  let surface!: HTMLDivElement;
  let castTimer: number | undefined;
  let castAnimation: Animation | undefined;
  const [celebrating, setCelebrating] = createSignal(0);
  const clearCelebration = () => {
    window.clearTimeout(castTimer);
    castAnimation?.cancel();
    setCelebrating(0);
  };
  createEffect(
    on(
      () => props.completed && !props.composing,
      (complete) => {
        if (!complete) {
          clearCelebration();
          return;
        }
        if (props.input.disabled || document.hidden) return;
        window.clearTimeout(castTimer);
        castAnimation?.cancel();
        setCelebrating((serial) => serial + 1);
        if (!motion.reduced) {
          castAnimation = surface.animate(
            [
              { filter: 'brightness(1)', transform: 'scale(1)' },
              { filter: 'brightness(1.75)', transform: 'scale(1.012)', offset: 0.22 },
              { filter: 'brightness(1.2)', transform: 'scale(1)', offset: 0.65 },
              { filter: 'brightness(1)', transform: 'scale(1)' },
            ],
            { duration: 650, easing: 'ease-out' },
          );
        }
        castTimer = window.setTimeout(clearCelebration, 1000);
      },
      { defer: true },
    ),
  );
  createEffect(() => {
    if (pageHidden() || props.input.disabled) clearCelebration();
  });
  const unsubscribeMotion = motion.subscribe((reduced) => {
    if (reduced) castAnimation?.cancel();
  });
  onCleanup(() => {
    clearCelebration();
    unsubscribeMotion();
  });
  const chars = createMemo(() => Array.from(props.target));
  const typedChars = createMemo(() => Array.from(props.text));
  const tones = createMemo(() => charTones(chars(), typedChars(), props.settled));
  const extraChars = createMemo(() => (props.settled ? [] : typedChars().slice(chars().length)));
  const errorHint = createMemo(() => {
    if (props.settled) return '';
    const typed = typedChars();
    const target = chars();
    for (let index = typed.length - 1; index >= 0; index -= 1) {
      if (typed[index] !== target[index])
        return charTitle('err', index, target[index], typed[index]);
    }
    return '';
  });
  return (
    <div
      hidden={props.hidden}
      style={`--glyph-particle-color:${ELEMENT_CSS[props.element ?? 'arcane']};--glyph-particle-play:${pageHidden() || props.input.disabled ? 'paused' : 'running'}`}
    >
      <div
        ref={(el) => {
          surface = el;
        }}
        class={stylex.props(styles.spellSurface).className}
        data-spell-surface="true"
      >
        <div
          class={stylex.props(styles.spellText, props.compact && styles.spellTextCompact).className}
          data-testid={props.testId ?? 'spell-text'}
        >
          <span
            class={stylex.props(ui.srOnly).className}
            data-testid={`${props.testId ?? 'spell-text'}-plain`}
          >
            {`目标咒文：${props.target}`}
          </span>
          <span aria-hidden="true" ref={(el) => props.attachColumn?.(el)}>
            <Index each={chars()}>
              {(char, index) => {
                const tone = createMemo(() => tones()[index]);
                const flowing = createMemo(
                  () => (tone() === 'done' || tone() === 'ok') && props.element,
                );
                return (
                  <span
                    class={`${
                      stylex.props(
                        styles.ch,
                        tone() === 'done' && styles.chDone,
                        tone() === 'ok' && styles.chOk,
                        tone() === 'cur' && styles.chCur,
                        tone() === 'err' && styles.chErr,
                        !!flowing() && styles.chFlow,
                        flowing() === 'fire' && styles.chFlowFire,
                        flowing() === 'ice' && styles.chFlowIce,
                        flowing() === 'storm' && styles.chFlowStorm,
                        flowing() === 'arcane' && styles.chFlowArcane,
                        (tone() === 'done' || tone() === 'ok') &&
                          char() !== ' ' &&
                          surfaceStyles.enchanted,
                      ).className
                    } ${charHook(tone())}`}
                    style={driftStyle(index)}
                    title={charTitle(tone(), index, char(), typedChars()[index])}
                  >
                    {tone() === 'err'
                      ? typedChars()[index] === ' '
                        ? '␣'
                        : typedChars()[index]
                      : char()}
                  </span>
                );
              }}
            </Index>
            <span data-extra="true">
              <Index each={extraChars()}>
                {(char) => (
                  <span
                    class={`${stylex.props(styles.ch, styles.chErr).className} ch ch--err`}
                    title="多余字符，请退格删除"
                  >
                    {char() === ' ' ? '␣' : char()}
                  </span>
                )}
              </Index>
            </span>
          </span>
        </div>
        <label class={stylex.props(ui.srOnly).className} for={props.input.id}>
          {props.input['aria-label'] ?? '咒文输入区'}
        </label>
        <textarea
          rows={2}
          spellcheck={false}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          {...props.input}
          aria-describedby={`${props.input['aria-describedby'] ?? ''} ${props.input.id}-error`.trim()}
          class={
            stylex.props(
              styles.typeField,
              props.compact && styles.spellTextCompact,
              (props.input.readOnly || props.input.disabled) && styles.typeFieldLocked,
            ).className
          }
          onClick={(event) => {
            if (props.composing) return;
            const field = event.currentTarget;
            field.setSelectionRange(field.value.length, field.value.length);
          }}
        />
        <Show when={celebrating()} keyed>
          {(_serial) => (
            <div
              class={stylex.props(surfaceStyles.castWave).className}
              data-testid={`${props.testId ?? 'spell-text'}-complete`}
              aria-hidden="true"
            >
              <span class={stylex.props(surfaceStyles.castSweep).className} />
              <span class={stylex.props(surfaceStyles.castSeal).className}>咒文完成</span>
            </div>
          )}
        </Show>
      </div>
      <p
        id={`${props.input.id}-error`}
        data-testid={`${props.testId ?? 'spell-text'}-error`}
        class={stylex.props(surfaceStyles.errorHint).className}
        hidden={!errorHint()}
        aria-live="polite"
        aria-atomic="true"
      >
        {errorHint()}
      </p>
    </div>
  );
}

const moteOrbit = stylex.keyframes({
  '0%': { transform: 'translate3d(-6px, 10px, 0) scale(.45)', opacity: 0 },
  '25%': { opacity: 0.85 },
  '55%': { transform: 'translate3d(5px, -2px, 0) scale(1)', opacity: 0.65 },
  '100%': { transform: 'translate3d(-3px, -17px, 0) scale(.25)', opacity: 0 },
});

const castWave = stylex.keyframes({
  '0%': { opacity: 0, boxShadow: '0 0 0 0 var(--glyph-particle-color)' },
  '18%': {
    opacity: 1,
    boxShadow: '0 0 22px 3px var(--glyph-particle-color), inset 0 0 24px #ffffff22',
  },
  '100%': { opacity: 0, boxShadow: '0 0 42px 12px transparent, inset 0 0 0 transparent' },
});
const castSweep = stylex.keyframes({
  '0%': { backgroundPosition: '180% 0', opacity: 0 },
  '20%': { opacity: 0.8 },
  '100%': { backgroundPosition: '-80% 0', opacity: 0 },
});

const surfaceStyles = stylex.create({
  errorHint: { margin: '8px 0 0', fontSize: '.85rem', color: 'var(--danger)' },
  castWave: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 3,
    border: '1px solid var(--glyph-particle-color)',
    animationName: castWave,
    animationDuration: '1s',
    animationTimingFunction: 'ease-out',
    animationFillMode: 'both',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  castSweep: {
    position: 'absolute',
    inset: 0,
    backgroundImage: 'linear-gradient(110deg, transparent 38%, #f4efff88 49%, transparent 60%)',
    backgroundSize: '240% 100%',
    animationName: castSweep,
    animationDuration: '700ms',
    animationTimingFunction: 'ease-out',
    animationFillMode: 'both',
    '@media (prefers-reduced-motion: reduce)': { display: 'none' },
  },
  castSeal: {
    position: 'absolute',
    right: 12,
    top: -14,
    padding: '2px 14px',
    backgroundColor: '#171027',
    border: '1px solid var(--glyph-particle-color)',
    color: '#f4efff',
    fontSize: '.82rem',
    letterSpacing: '.2em',
    textShadow: '0 0 8px var(--glyph-particle-color)',
  },
  enchanted: {
    position: 'relative',
    '::before': {
      content: '""',
      position: 'absolute',
      pointerEvents: 'none',
      width: 3,
      height: 3,
      left: '24%',
      top: '40%',
      borderRadius: '50%',
      backgroundColor: '#f4efff',
      boxShadow: '0 0 5px 1px var(--glyph-particle-color), 0 0 10px var(--glyph-particle-color)',
      animationName: moteOrbit,
      animationDuration: 'calc(var(--drift-dur, 6s) * .4)',
      animationDelay: 'var(--drift-delay, 0s)',
      animationIterationCount: 'infinite',
      animationTimingFunction: 'ease-in-out',
      animationPlayState: 'var(--glyph-particle-play, running)',
      '@media (prefers-reduced-motion: reduce)': { display: 'none', animationName: 'none' },
    },
    '::after': {
      content: '""',
      position: 'absolute',
      pointerEvents: 'none',
      width: 2,
      height: 2,
      left: '76%',
      top: '55%',
      borderRadius: '50%',
      backgroundColor: 'var(--glyph-particle-color)',
      boxShadow: '0 0 5px var(--glyph-particle-color)',
      animationName: moteOrbit,
      animationDuration: 'calc(var(--drift-dur, 6s) * .55)',
      animationDelay: 'var(--drift-delay, 0s)',
      animationDirection: 'reverse',
      animationIterationCount: 'infinite',
      animationTimingFunction: 'ease-in-out',
      animationPlayState: 'var(--glyph-particle-play, running)',
      '@media (prefers-reduced-motion: reduce)': { display: 'none', animationName: 'none' },
    },
  },
});
