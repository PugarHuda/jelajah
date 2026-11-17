import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// served from https://pugarhuda.github.io/jelajah/
export default defineConfig({
  base: '/jelajah/',
  plugins: [react()],
})
