import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { ProxyOptions } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_FACILIO_API_BASE_URL;
  return {
    plugins: [react()],
    server: {
      port: 9090,
      strictPort: true,
      // Same-origin proxy for the org's REST API in dev: the Facilio API has no CORS
      // allowance for localhost origins, so browser calls must go through the dev
      // server ('/fapi/v2/forms' -> '<VITE_FACILIO_API_BASE_URL>/v2/forms'). The app
      // switches its axios baseURL to '/fapi' in dev mode (see lib/facilioApi.ts).
      ...(apiTarget
        ? {
            proxy: {
              '/fapi': {
                target: apiTarget,
                changeOrigin: true,
                rewrite: (p: string) => p.replace(/^\/fapi/, ''),
                // `changeOrigin` only rewrites the outgoing Host header — the browser's real
                // `Origin: http://localhost:9090` still rides along, and the org's edge (WAF/ALB)
                // 403s any request whose Origin doesn't match its own domain, even with a valid
                // token. Overwrite it to the target's origin so the proxied request looks
                // same-origin to the backend (confirmed live: matching Origin -> 200, foreign -> 403).
                configure: (proxy) => {
                  const targetOrigin = new URL(apiTarget).origin;
                  proxy.on('proxyReq', (proxyReq, req) => {
                    if (req.headers.origin) proxyReq.setHeader('origin', targetOrigin);
                  });
                },
              } satisfies ProxyOptions,
            },
          }
        : {}),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
