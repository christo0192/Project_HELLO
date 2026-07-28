import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cspPlugin from './vite-csp-plugin.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cspPlugin()],
})
