/**
 * Vite config of the web app (`vp dev`, `vp build`, `vp preview`). Lint, format and test settings
 * live in the root `vite.config.ts`.
 *
 * Environment:
 * - `VITE_API_MODE=mock` serves a mock API in the browser (generated leaderboard, fixture games,
 *   a fake live game). The mock is a separate chunk loaded only in that mode.
 * - `VITE_API_BASE` overrides the API origin (default: same origin), e.g. `http://localhost:1337`
 *   for `alchemy dev`.
 */
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  optimizeDeps: {
    entries: ["src/entry.ts"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
});
