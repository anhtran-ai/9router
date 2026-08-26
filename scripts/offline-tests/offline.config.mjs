import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = process.env.AZOX_AUDIT_REPO;
const output = process.env.AZOX_AUDIT_OUTPUT;
if (!repo || !output) throw new Error('Use run-offline.mjs to provide isolated configuration');
const base = (await import(pathToFileURL(resolve(repo, 'tests/vitest.config.js')).href)).default;
const here = fileURLToPath(new URL('.', import.meta.url));

export default {
  ...base,
  root: repo,
  cacheDir: resolve(output, 'vite-cache'),
  test: {
    ...base.test,
    exclude: [...(base.test?.exclude || []), '**/*.real.test.js'],
    setupFiles: [...(base.test?.setupFiles || []), resolve(here, 'offline.setup.mjs')],
    pool: 'forks',
    maxWorkers: 4,
    retry: 0,
    reporters: ['default', 'json'],
    outputFile: { json: resolve(output, 'vitest.json') },
  },
};
