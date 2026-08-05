import { defineConfig } from "vite";

// Skeleton config. Real plugins (React, Tailwind) are wired as the UI and
// renderer gain behavior; the skeleton only needs `vite build` to succeed.
export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
  },
  server: {
    // The dev server sits behind caddy (the public edge). Vite 5 rejects Host
    // headers it doesn't recognise; caddy forwards the browser's original Host,
    // so a containerised browser reaching the stack via host.docker.internal (the
    // e2e harness / CI) is blocked unless listed here. `localhost` is always
    // allowed, so the operator's own browser is unaffected. Dev-only.
    allowedHosts: ["host.docker.internal", "caddy"],
    // The repo is a Windows bind-mount into this Linux container; inotify events
    // do NOT cross that boundary, so vite never sees source edits and serves a
    // stale module transform. Poll instead so HMR + transform-invalidation work.
    watch: { usePolling: true, interval: 300 },
  },
});
