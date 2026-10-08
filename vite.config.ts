import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, type Plugin} from 'vite';

const offlinePrecacheManifest: Plugin = {
  name: 'dypos-offline-precache-manifest',
  generateBundle(_options, bundle) {
    const assets = Object.keys(bundle)
      .filter((fileName) => fileName.startsWith('assets/'))
      .map((fileName) => `/${fileName}`)
      .sort();

    this.emitFile({
      type: 'asset',
      fileName: 'dypos-precache.json',
      source: JSON.stringify(assets),
    });
  },
};

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), offlinePrecacheManifest],
    resolve: {
      alias: {
        // import.meta.dirname, not __dirname: Vite's native config loader runs
        // this file as ESM, where __dirname does not exist.
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          // Split the heavy visual/3D libraries out of the entry bundle so the
          // first paint only ships what the initial view needs.
          // Rolldown (Vite 8) requires the function form here.
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return;
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
              return 'react';
            }
            if (/[\\/]node_modules[\\/](three|@types[\\/]three)[\\/]/.test(id)) return 'three';
            // Recharts + d3 + jspdf are only ever imported on the charts/report
            // screens, so they must NOT be preloaded on the login screen.
            // Rolldown (Vite 8) keeps them as separate manual chunks for the
            // lazy-screen importers while the login entry stays lean.
            if (/[\\/]node_modules[\\/](motion)/.test(id)) return 'motion';
            return undefined;
          },
        },
      },
    },
    preview: {
      port: 3000,
      host: '0.0.0.0',
    },
    server: {
      port: 5173,
      host: '0.0.0.0',
      // Production: no proxy — the Cloudflare Worker serves both SPA and API
      // from one origin, so the browser never makes cross-origin calls.
      // Keep dev proxy only if VITE_USE_PROXY=true is set explicitly.
      proxy: process.env.VITE_USE_PROXY === 'true' ? { '/api': 'http://localhost:3000' } : undefined,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
