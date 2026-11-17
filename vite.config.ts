import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Vercel serves from "/", GitHub Pages from "/jelajah/" (set VITE_BASE in the Pages workflow)
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
})
