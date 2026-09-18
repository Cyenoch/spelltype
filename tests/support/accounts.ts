/**
 * Queue hygiene for the shared matchmaking Durable Object.
 *
 * Matchmaking is global per difficulty, so any account left queued by a test (including a test
 * that fails halfway) could pollute the next test. Every signed-in account is tracked through
 * an independent API context that reuses the session cookie the browser already holds — no
 * extra authentication call, so cleanup costs neither password hashing nor limiter budget.
 */
import { request, type APIRequestContext, type BrowserContext } from '@playwright/test';

const tracked: APIRequestContext[] = [];

/** Creates an out-of-band API context from the page's existing session cookie. */
export async function trackAccountForQueueCleanup(
  context: BrowserContext,
  baseUrl: string,
): Promise<void> {
  const origin = new URL(baseUrl).origin;
  const cookies = await context.cookies(baseUrl);
  if (cookies.length === 0)
    throw new Error(`queue cleanup tracking found no session cookie for ${baseUrl}`);
  const apiContext = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: { origin },
    storageState: { cookies, origins: [] },
  });
  tracked.push(apiContext);
}

/**
 * Cancels every tracked account's matchmaking reservation, then disposes the contexts.
 * Unexpected HTTP results fail loudly; a 401/404 only means the session or reservation is
 * already gone, which is exactly the state this cleanup wants.
 */
export async function cleanupTrackedQueues(): Promise<void> {
  const contexts = tracked.splice(0, tracked.length);
  for (const apiContext of contexts) {
    try {
      const response = await apiContext.delete('/api/match');
      if (!response.ok() && ![401, 404].includes(response.status())) {
        throw new Error(`queue cleanup failed: DELETE /api/match returned ${response.status()}`);
      }
    } finally {
      await apiContext.dispose();
    }
  }
}
