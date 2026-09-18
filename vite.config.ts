import { defineConfig } from 'vite';
import { DEV_RELEASE_ID, releaseIdSchema } from './shared/release.ts';
import { frontendPlugins } from './vite.frontend.ts';

export default defineConfig(({ command }) => {
  const releaseId = releaseIdSchema.parse(
    process.env.SPELLTYPE_RELEASE_ID ?? (command === 'serve' ? DEV_RELEASE_ID : undefined),
  );
  return {
    base: command === 'build' ? `/_releases/${releaseId}/` : '/',
    define: { __SPELLTYPE_RELEASE_ID__: JSON.stringify(releaseId) },
    plugins: frontendPlugins(),
    build: { outDir: 'dist/client', emptyOutDir: true },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // Persisted state and test evidence must not trigger a live game's browser reload.
      watch: { ignored: ['**/tests/.state/**', '**/.scratch/**', '**/.data/**'] },
    },
  };
});
