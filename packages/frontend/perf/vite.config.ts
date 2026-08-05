import { defineConfig } from "vite";

// Perf-harness vite config (brief §3) — separate from the app's root config so
// `npm run perf` serves perf/index.html without pulling in the app entry. No
// plugins: the renderer is framework-free Three.js + GLSL, and vite strips the
// .ts imports natively. `npm run perf` runs the dev server; `vite build` against
// this config is what the build-clean check (test-frontend's typecheck path)
// confirms compiles.
export default defineConfig({
  root: __dirname,
  server: {
    host: "0.0.0.0",
    port: 5174,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
