import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// a vendor chunk: modules under node_modules/<one of these packages>/ (either path separator)
const vendor = (pkgs: string) => new RegExp(`node_modules[/\\\\](${pkgs})[/\\\\]`)

// Vercel serves from "/", GitHub Pages from "/jelajah/" (set VITE_BASE in the Pages workflow)
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react()],
  build: {
    sourcemap: true, // the code is open source anyway; Lighthouse wants maps for big bundles
    chunkSizeWarningLimit: 700, // ponytail: the bch chunk is mostly libauth (~600 kB); lazy-load it per page if first paint matters
    rolldownOptions: {
      output: {
        // vendor chunks download in parallel and stay cached across app releases
        codeSplitting: {
          groups: [
            { name: 'react', test: vendor('react|react-dom|scheduler') },
            { name: 'bch', test: vendor('@bitauth|cashscript|@cashscript|@electrum-cash') },
            { name: 'wallet', test: vendor('@wizardconnect|@walletconnect|@reown|@noble|@scure') },
            { name: 'nostr', test: vendor('nostr-tools') },
          ],
        },
      },
    },
  },
})
