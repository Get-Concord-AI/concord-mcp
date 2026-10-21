#!/usr/bin/env node
/**
 * Stand-in for a coding harness's executable inside the e2e sandbox.
 *
 * `concord setup` and the Codex host shell out to the real harness binaries
 * (`claude --version`, `codex app-server daemon start`, `grok plugin install`).
 * This shim answers those calls with the verified minimum version so setup
 * installs every adapter, records each call, and plays a Codex app-server so
 * the managed controller's `turn/start` and `turn/steer` can be observed.
 *
 * Usage: harness-shim.mjs <harness> [args...]. Everything is recorded under
 * $CONCORD_E2E_SHIM_DIR.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSIONS = {
  claude: '2.1.105 (Claude Code)',
  codex: 'codex-cli 0.147.0',
  cursor: '3.0.0',
  grok: 'grok 1.0.0',
  goose: '1.52.0',
  agy: '1.0.0',
};

const [harness = 'unknown', ...args] = process.argv.slice(2);
const shimDir = process.env.CONCORD_E2E_SHIM_DIR ?? process.cwd();
mkdirSync(shimDir, { recursive: true });

function record(file, entry) {
  appendFileSync(join(shimDir, file), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

record('calls.jsonl', { harness, args });

function grokPlugins() {
  const path = join(shimDir, 'grok-plugins.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

function saveGrokPlugins(plugins) {
  writeFileSync(join(shimDir, 'grok-plugins.json'), JSON.stringify(plugins));
}

/** JSONL app-server: answer every request, record the ones that deliver to a turn. */
function codexAppServer() {
  const modePath = join(shimDir, 'codex-mode');
  const mode = existsSync(modePath) ? readFileSync(modePath, 'utf8').trim() : 'idle';
  if (mode === 'down') {
    process.stderr.write('codex app-server unavailable (e2e shim)\n');
    process.exit(1);
  }
  let turn = 0;
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    const frame = JSON.parse(line);
    record('codex-app-server.jsonl', { method: frame.method, params: frame.params ?? null });
    if (frame.id === undefined) return;
    let result = {};
    if (frame.method === 'turn/start') {
      turn += 1;
      result = { turn: { id: `turn-${String(turn)}` } };
    }
    if (frame.method === 'turn/steer') result = { turnId: frame.params?.expectedTurnId ?? null };
    process.stdout.write(`${JSON.stringify({ id: frame.id, result })}\n`);
    // A busy session has a turn in flight, so the controller steers it.
    if (frame.method === 'thread/resume' && mode === 'busy') {
      const started = { method: 'turn/started', params: { turn: { id: 'turn-active' } } };
      process.stdout.write(`${JSON.stringify(started)}\n`);
    }
  });
  lines.on('close', () => process.exit(0));
}

if (args[0] === '--version') {
  process.stdout.write(`${VERSIONS[harness] ?? '0.0.0'}\n`);
} else if (harness === 'codex' && args[0] === 'app-server' && args[1] === 'proxy') {
  codexAppServer();
} else if (harness === 'grok' && args[0] === 'plugin') {
  const plugins = grokPlugins();
  if (args[1] === 'list') {
    process.stdout.write(`${JSON.stringify(plugins)}\n`);
  } else if (args[1] === 'install' && args[2] !== undefined) {
    saveGrokPlugins([
      ...plugins.filter((plugin) => plugin.name !== 'concord-relay'),
      { name: 'concord-relay', source: args[2], enabled: true },
    ]);
  } else if (args[1] === 'uninstall') {
    saveGrokPlugins(plugins.filter((plugin) => plugin.name !== args[2]));
  }
}
// Anything else (daemon bootstrap/start/version, …) succeeds silently.
