/**
 * Playwright global setup: boots the fixture plus the isolated application instance and keeps them
 * alive for the whole run. Teardown stops the processes.
 */
import { startHarness } from './support/harness';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const harness = await startHarness();
  return harness.stop;
}
