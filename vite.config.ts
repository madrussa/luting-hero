import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  // .lute songs are bundled as plain text so the picker can list them without
  // a fetch round-trip per song.
  assetsInclude: ['**/*.lute'],
})
