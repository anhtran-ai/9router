import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const [repoArgument, outputArgument] = process.argv.slice(2);
if (!repoArgument || !outputArgument) throw new Error('Usage: node run-offline.mjs <source-worktree> <fresh-output-directory>');
const repo = resolve(repoArgument);
const output = resolve(outputArgument);
const here = fileURLToPath(new URL('.', import.meta.url));
if (existsSync(resolve(output, 'run.json'))) throw new Error('Refusing to overwrite an earlier run; use a fresh output directory and document any rerun');
const profile = resolve(output, 'profile');
const directories = {
  HOME: profile,
  USERPROFILE: profile,
  APPDATA: resolve(profile, 'AppData/Roaming'),
  LOCALAPPDATA: resolve(profile, 'AppData/Local'),
  DATA_DIR: resolve(output, 'data'),
  TEMP: resolve(output, 'temp'),
  TMP: resolve(output, 'temp'),
};
for (const directory of [output, ...Object.values(directories), resolve(output, 'network')]) mkdirSync(directory, { recursive: true });
const safeEnvironmentNames = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'number_of_processors', 'processor_architecture', 'processor_identifier', 'os']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => safeEnvironmentNames.has(key.toLowerCase())));
Object.assign(env, directories, {
  NODE_ENV: 'test',
  NODE_OPTIONS: `--require="${resolve(here, 'network-guard.cjs').replaceAll('\\', '/')}"`,
  NO_COLOR: '1',
  CI: '1',
  RUN_REAL: '0',
  RUN_E2E: '0',
  AG_CACHE_TEST: '0',
  AZOX_AUDIT_REPO: repo,
  AZOX_AUDIT_OUTPUT: output,
  AZOX_AUDIT_PROFILE: profile,
  AZOX_AUDIT_NETWORK_DIR: resolve(output, 'network'),
  GIT_CONFIG_GLOBAL: resolve(profile, 'empty.gitconfig'),
});
writeFileSync(env.GIT_CONFIG_GLOBAL, '');
const command = process.execPath;
const args = [resolve(repo, 'tests/node_modules/vitest/vitest.mjs'), 'run', '--config', resolve(here, 'offline.config.mjs')];
const metadata = {
  repo, output, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  node: process.version,
  vitest: JSON.parse(readFileSync(resolve(repo, 'tests/node_modules/vitest/package.json'), 'utf8')).version,
  command, args, startedAt: new Date().toISOString(),
  excludedPattern: '**/*.real.test.js', maxWorkers: 4, retry: 0,
  environment: { ...directories, RUN_REAL: '0', RUN_E2E: '0', AG_CACHE_TEST: '0' },
};
writeFileSync(resolve(output, 'run.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ event: 'start', revision: metadata.revision, output, node: metadata.node, vitest: metadata.vitest }));
const stdout = createWriteStream(resolve(output, 'stdout.log'));
const stderr = createWriteStream(resolve(output, 'stderr.log'));
const child = spawn(command, args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(stdout);
child.stderr.pipe(stderr);
const exit = await new Promise((resolvePromise, reject) => {
  child.on('error', reject);
  child.on('close', (code, signal) => resolvePromise({ code, signal }));
});
metadata.finishedAt = new Date().toISOString();
metadata.exit = exit;
writeFileSync(resolve(output, 'run.json'), JSON.stringify(metadata, null, 2) + '\n');
const reportPath = resolve(output, 'vitest.json');
if (!existsSync(reportPath)) {
  console.log(JSON.stringify({ event: 'no-json-report', ...exit, output }));
  process.exitCode = exit.code || 1;
} else {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const failedAssertions = [];
  const collectionErrors = [];
  const suiteErrors = [];
  for (const file of report.testResults || []) {
    const name = relative(repo, file.name).replaceAll('\\', '/');
    for (const assertion of file.assertionResults || []) {
      if (assertion.status === 'failed') failedAssertions.push({ file: name, name: assertion.fullName || [...(assertion.ancestorTitles || []), assertion.title].join(' > '), messages: assertion.failureMessages });
    }
    if (file.status === 'failed' && !(file.assertionResults || []).length) collectionErrors.push({ file: name, message: file.message });
    if (file.status === 'failed' && (file.message || !(file.assertionResults || []).some(assertion => assertion.status === 'failed'))) {
      suiteErrors.push({ file: name, message: file.message || 'Suite failed without assertion details' });
    }
  }
  const networkEvents = readdirSync(resolve(output, 'network')).flatMap(file => readFileSync(resolve(output, 'network', file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  const blocked = networkEvents.filter(event => event.kind === 'blocked');
  const summary = {
    revision: metadata.revision, node: metadata.node, vitest: metadata.vitest, exit,
    totalTests: report.numTotalTests, passedTests: report.numPassedTests, failedTests: report.numFailedTests,
    pendingTests: report.numPendingTests, todoTests: report.numTodoTests,
    files: report.testResults?.length, failedAssertions: failedAssertions.length, collectionErrors: collectionErrors.length,
    failedTestSuites: report.numFailedTestSuites, suiteErrors: suiteErrors.length,
    blockedNetworkOrProcessAttempts: blocked.length,
    blockedDestinations: [...new Set(blocked.map(event => `${event.operation} ${event.host}:${event.port}`))].sort(),
  };
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  writeFileSync(resolve(output, 'failed-assertions.json'), JSON.stringify(failedAssertions, null, 2) + '\n');
  writeFileSync(resolve(output, 'failed-identities.txt'), failedAssertions.map(assertion => `${assertion.file} :: ${assertion.name}`).sort().join('\n') + '\n');
  writeFileSync(resolve(output, 'collection-errors.json'), JSON.stringify(collectionErrors, null, 2) + '\n');
  writeFileSync(resolve(output, 'suite-errors.json'), JSON.stringify(suiteErrors, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'complete', summary, output }));
  process.exitCode = exit.code ?? 1;
}
