/**
 * Unit-test configuration for the logic the browser suite no longer carries.
 *
 * These specs run in plain Node against the real modules — the combat rules, the spell-book
 * validation, the request/auth input boundaries and the room's SQL state layer — so they need no
 * browser or workerd process. The HTTP boundary specs drive the Hono app directly; E2E
 * keeps the behaviour that only the real Worker + Durable Object + D1 boundary can prove.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts'],
    environment: 'node',
    reporters: ['default'],
  },
});
