// Node-test resolution shim — registered via `--import` in BOTH the `test` and
// `test:dom` scripts (unit tier added 2026-07-20: `ui/admin/roles.ts` grew its
// first extensionless relative VALUE import into a unit-tested component, so the
// unit tier now needs the same mapping the DOM tier always did). NOT a bundler
// and NOT a transform: it only maps module specifiers so Node's ESM resolver can
// load the real UI components.
//
// Why it is needed (a correction to the spike memo's plain script): the UI
// components import their siblings WITHOUT a file extension — e.g.
// CreateDatasetWizard does `import { pollJob } from "./jobPoll"`. vite and tsc
// (allowImportingTsExtensions) resolve those; Node's ESM resolver does not, so
// importing the real CreateDatasetWizard/AdminScreen into `node --test` fails
// with ERR_MODULE_NOT_FOUND. This teaches the resolver to append `.ts` for an
// extensionless relative import when that sibling file exists. Node's built-in
// `--experimental-strip-types` still does the actual type-stripped load; type-
// only imports are already elided before resolution, so only value imports of
// real `.ts` files reach this hook.
//
// `module.registerHooks` is synchronous and same-thread (Node >= 22.15; the
// frontend image is node 22.22), so this is one file with no separate hooks
// module.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.[a-z0-9]+$/i.test(specifier);
    if (isRelative && !hasExtension && context.parentURL !== undefined) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
