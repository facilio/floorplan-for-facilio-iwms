import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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
              },
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
