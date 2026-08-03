import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cspPlugin from './vite-csp-plugin.js'

// HELLO integration: route-level lazy chunks already split Dashboard /
// Session detail / Candidate detail / Mission Control out of the main
// bundle. `manualChunks` below additionally keeps the two heavy vendor
// groups (Apache ECharts + zrender; Motion) in dedicated cacheable chunks
// shared by every route that imports them — no per-route duplication, no
// unsafe over-splitting. The warning limit is raised modestly so the
// genuinely large ECharts subset (only the used chart types are
// tree-shaken in src/components/charts/echarts.ts) is reported, not the
// main app bundle.
export default defineConfig({
  plugins: [react(), cspPlugin()],
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/echarts') ||
            id.includes('node_modules/zrender')
          ) {
            return 'charts-vendor';
          }
          if (
            id.includes('node_modules/motion') ||
            id.includes('node_modules/framer-motion')
          ) {
            return 'motion-vendor';
          }
        },
      },
    },
  },
})
