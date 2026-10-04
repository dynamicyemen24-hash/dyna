import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
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
            if (/[\\/]node_modules[\\/](recharts|d3-|victory-)/.test(id)) return 'charts';
            if (/[\\/]node_modules[\\/](jspdf|jspdf-autotable)/.test(id)) return 'pdf';
            if (/[\\/]node_modules[\\/]motion/.test(id)) return 'motion';
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
      proxy: {
        '/api': 'http://localhost:3000',
      },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
