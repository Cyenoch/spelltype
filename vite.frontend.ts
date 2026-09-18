import solid from 'vite-plugin-solid';
import stylex from '@stylexjs/unplugin';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

/** Keep production and browser tests on the same routing, JSX and StyleX pipeline. */
export function frontendPlugins() {
  return [
    tanstackRouter({ target: 'solid', autoCodeSplitting: true }),
    stylex.vite({
      useCSSLayers: false,
      runtimeInjection: false,
      styleResolution: 'application-order',
    }),
    solid(),
  ];
}
