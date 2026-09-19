/**
 * 将服务端时间戳映射到本地时钟。每次收到快照或 pong 消息时均会
 * 重新校准偏移量，确保战斗时钟绝不因页面运行时间而产生时间漂移。
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
