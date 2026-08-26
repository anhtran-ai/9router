// Test-only guard. Loaded before Vitest and again as a setup file.
// No live provider traffic or pre-existing local gateway access is allowed.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');
const cp = require('node:child_process');
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');

const marker = Symbol.for('azox.9router.offline.guard');
if (!globalThis[marker]) {
  const state = { ports: new Set(), blocked: 0 };
  globalThis[marker] = state;
  const logDirectory = process.env.AZOX_AUDIT_NETWORK_DIR;
  const profile = process.env.AZOX_AUDIT_PROFILE;
  if (!logDirectory || !profile) throw new Error('Offline guard requires isolated audit environment');
  fs.mkdirSync(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, `events-${process.pid}.ndjson`);
  const appendFileSync = fs.appendFileSync.bind(fs);
  function event(kind, details = {}) {
    appendFileSync(logPath, JSON.stringify({ kind, pid: process.pid, ...details }) + '\n');
  }
  const isLoopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host || '').toLowerCase());
  function blocked(kind, host, port) {
    state.blocked++;
    event('blocked', { operation: kind, host: String(host || '<unspecified>'), port: Number(port) || 0 });
    const error = new Error(`AZOX_OFFLINE_NETWORK_BLOCKED: ${kind} ${host || '<unspecified>'}:${port || 0}`);
    error.code = 'AZOX_OFFLINE_NETWORK_BLOCKED';
    return error;
  }
  function checkTarget(kind, host, port) {
    if (!isLoopback(host) || !state.ports.has(Number(port))) throw blocked(kind, host, port);
  }
  function optionsFrom(args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    if (values[0] && typeof values[0] === 'object') return values[0];
    if (typeof values[0] === 'number') return { port: values[0], host: typeof values[1] === 'string' ? values[1] : undefined };
    return { path: values[0] };
  }

  const originalListen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = optionsFrom(args);
    const host = options.host || '127.0.0.1';
    if (!isLoopback(host) || Number(options.port) !== 0 || options.path) throw blocked('listen', host, options.port);
    // Node binds a wildcard address when the host is omitted; pin it explicitly.
    if (!options.host) {
      if (args[0] && typeof args[0] === 'object') args[0] = { ...args[0], host };
      else args.splice(1, 0, host);
    }
    // Only ephemeral fixture servers started by this worker are reachable.
    this.once('listening', () => {
      const address = this.address();
      if (address && typeof address === 'object') {
        state.ports.add(address.port);
        event('fixture-listen', { host: address.address, port: address.port });
        this.once('close', () => state.ports.delete(address.port));
      }
    });
    return originalListen.apply(this, args);
  };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = optionsFrom(args);
    checkTarget('socket.connect', options.host || 'localhost', options.port);
    return originalConnect.apply(this, args);
  };

  const originalLookup = dns.lookup.bind(dns);
  dns.lookup = function (hostname, ...args) {
    if (!isLoopback(hostname)) {
      const error = blocked('dns.lookup', hostname, 0);
      const callback = args.find(value => typeof value === 'function');
      if (callback) return queueMicrotask(() => callback(error));
      throw error;
    }
    return originalLookup(hostname, ...args);
  };
  const originalPromiseLookup = dns.promises.lookup.bind(dns.promises);
  dns.promises.lookup = async function (hostname, ...args) {
    if (!isLoopback(hostname)) throw blocked('dns.promises.lookup', hostname, 0);
    return originalPromiseLookup(hostname, ...args);
  };
  for (const operation of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    if (typeof dns[operation] === 'function') dns[operation] = (...args) => { throw blocked(`dns.${operation}`, args[0], 0); };
    if (typeof dns.promises[operation] === 'function') dns.promises[operation] = async (...args) => { throw blocked(`dns.promises.${operation}`, args[0], 0); };
  }
  dgram.Socket.prototype.send = function () { throw blocked('udp.send', '', 0); };
  dgram.Socket.prototype.connect = function () { throw blocked('udp.connect', '', 0); };

  const originalFetch = globalThis.fetch?.bind(globalThis);
  if (originalFetch) globalThis.fetch = async function (input, ...args) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
    catch { throw blocked('fetch.invalid-url', '', 0); }
    if (url.protocol === 'data:') return originalFetch(input, ...args);
    checkTarget('fetch', url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
    return originalFetch(input, ...args);
  };
  // Writable globals remain writable: vi.stubGlobal/vi.fn mocks work normally.
  os.homedir = () => profile;

  const criticalEnvironment = Object.fromEntries(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'DATA_DIR', 'TEMP', 'TMP'].map(key => [key, process.env[key]]));
  function childOptions(options, isNode) {
    const result = { ...(options || {}), windowsHide: true };
    if (result.shell) throw blocked('child-process.shell', 'shell', 0);
    if (isNode) result.env = { ...process.env, ...(result.env || {}), ...criticalEnvironment, NODE_OPTIONS: `--require="${__filename.replaceAll('\\', '/')}"` };
    return result;
  }
  function classify(command, args) {
    const name = path.basename(String(command)).toLowerCase();
    if (name === 'node' || name === 'node.exe' || path.resolve(String(command)).toLowerCase() === process.execPath.toLowerCase()) return 'node';
    if ((name === 'git' || name === 'git.exe') && ['diff', 'show', 'rev-parse', 'status', 'log', 'ls-files'].includes(args?.[0])) return 'git-read';
    if ((name === 'esbuild' || name === 'esbuild.exe') && Array.isArray(args) && args.every(arg => /^--service=/.test(arg) || arg === '--ping')) return 'esbuild';
    throw blocked('child-process', name, 0);
  }
  for (const operation of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[operation].bind(cp);
    cp[operation] = function (command, args, options, callback) {
      if (!Array.isArray(args)) { callback = options; options = args; args = []; }
      if (typeof options === 'function') { callback = options; options = {}; }
      const kind = classify(command, args);
      return original(command, args, childOptions(options, kind === 'node'), callback);
    };
  }
  for (const operation of ['exec', 'execSync']) cp[operation] = () => { throw blocked(`child-process.${operation}`, 'shell', 0); };
  const originalFork = cp.fork.bind(cp);
  cp.fork = function (modulePath, args, options) {
    if (!Array.isArray(args)) { options = args; args = []; }
    return originalFork(modulePath, args, childOptions(options, true));
  };
  syncBuiltinESMExports();
  event('guard-installed', { isolatedProfile: profile });
}

module.exports = globalThis[marker];
