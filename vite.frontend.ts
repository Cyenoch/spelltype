import solid from 'vite-plugin-solid';
import stylex from '@stylexjs/unplugin';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

/** 使生产构建与浏览器测试运行在同一套路由、JSX 与 StyleX 管线上。 */
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
