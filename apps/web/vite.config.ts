import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'TPacket',
        short_name: 'TPacket',
        description: 'Simulateur réseau et plateforme pédagogique BTS SIO',
        theme_color: '#0b1220',
        background_color: '#0b1220',
        display: 'standalone',
        icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,svg,woff2}'], navigateFallbackDenylist: [/^\/api\//] },
    }),
  ],
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:8000', ws: true } },
  },
});
