import { createEffect, createSignal, onCleanup } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import { ui } from '../../../ui/primitives';

/** Retained with the arena, but audible only during the actual battle. */
export function BattleMusic(props: { active: boolean }) {
  let audio!: HTMLAudioElement;
  let disposed = false;
  const [enabled, setEnabled] = createSignal(true);
  const [blocked, setBlocked] = createSignal(false);

  const play = () => {
    if (!props.active || !enabled()) return;
    void audio.play().catch(() => {
      // Phase changes and disposal can abort a pending play request normally.
      if (!disposed && props.active && enabled()) setBlocked(true);
    });
  };

  createEffect(() => {
    if (!props.active) {
      audio.pause();
      audio.currentTime = 0;
      setBlocked(false);
    } else if (!enabled()) {
      audio.pause();
    } else {
      play();
    }
  });

  const toggle = () => {
    if (enabled() && !blocked()) {
      setEnabled(false);
      return;
    }
    setEnabled(true);
    if (audio.error) audio.load();
    // Invoke directly in the gesture handler to satisfy autoplay restrictions.
    play();
  };

  onCleanup(() => {
    disposed = true;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  });

  return (
    <>
      <audio
        ref={(element) => {
          audio = element;
          audio.volume = 0.3;
        }}
        data-testid="battle-music"
        src="/audio/heart-of-courage-aaron-paul-low.mp3"
        preload="none"
        loop
        hidden
        onPlaying={() => setBlocked(false)}
        onError={() => setBlocked(true)}
      />
      <button
        type="button"
        class={stylex.props(ui.button, ui.small, ui.quiet).className}
        data-testid="battle-music-toggle"
        aria-label="背景音乐"
        aria-pressed={enabled() && !blocked()}
        title={blocked() ? '音乐未能自动播放，点击开启' : 'Heart of Courage · Aaron Paul Low'}
        onClick={toggle}
      >
        {blocked() ? '播放音乐' : enabled() ? '音乐开' : '音乐关'}
      </button>
    </>
  );
}
