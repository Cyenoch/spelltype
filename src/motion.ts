/** Tracks the user's reduced-motion preference and mirrors it onto <html>. */
class MotionPreference {
  private readonly query = window.matchMedia('(prefers-reduced-motion: reduce)');
  private readonly listeners = new Set<(reduced: boolean) => void>();

  constructor() {
    this.apply();
    this.query.addEventListener('change', () => {
      this.apply();
      for (const listener of this.listeners) listener(this.reduced);
    });
  }

  get reduced(): boolean {
    return this.query.matches;
  }

  subscribe(listener: (reduced: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private apply(): void {
    document.documentElement.dataset.motion = this.reduced ? 'reduced' : 'full';
  }
}

export const motion = new MotionPreference();
