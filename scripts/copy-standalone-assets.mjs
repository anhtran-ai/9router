import { cpSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  // sql.js resolves its WebAssembly binary at runtime, so Next's file tracer does
  // not discover it from the externalized JavaScript entrypoint. Keep the
  // documented SQLite fallback usable in standalone builds instead of shipping a
  // bundle that fails only after better-sqlite3/node:sqlite are unavailable.
  const sqlJsWasmSource = resolve(projectRoot, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const sqlJsWasmDestination = resolve(standaloneDir, "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  if (!existsSync(sqlJsWasmSource)) {
    throw new Error(`[standalone-assets] Required SQL.js runtime asset is missing: ${sqlJsWasmSource}`);
  }
  mkdirSync(dirname(sqlJsWasmDestination), { recursive: true });
  cpSync(sqlJsWasmSource, sqlJsWasmDestination, { force: true });
  console.log(`[standalone-assets] Copied SQL.js runtime asset to ${sqlJsWasmDestination}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
