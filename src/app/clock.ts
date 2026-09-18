/**
 * Maps server timestamps onto the local clock. Every snapshot and pong
 * re-calibrates the offset, so the combat clock never drifts with page uptime.
 */
export class ServerClock {
  private offsetMs = 0;

  sync(serverNow: number): void {
    if (!Number.isFinite(serverNow) || serverNow <= 0) return;
    this.offsetMs = serverNow - Date.now();
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  remainingMs(deadline: number): number {
    if (!deadline) return 0;
    return Math.max(0, deadline - this.now());
  }
}
