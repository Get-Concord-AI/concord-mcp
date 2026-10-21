import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * A disposable machine for one e2e test file: its own HOME, a fresh git
 * repository, the packed Concord on PATH, and harness shims in place of the
 * real `claude`, `codex`, `cursor`, … binaries.
 *
 * The root must not be under a temp directory: Concord treats adapter links
 * into one as a throwaway checkout and reports them as needing repair.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
const SHIM = join(HERE, '..', 'shims', 'harness-shim.mjs');

/** Harness binaries `concord setup` looks for, each played by the shim. */
const SHIMMED = ['claude', 'codex', 'cursor', 'grok', 'goose', 'agy', 'copilot'] as const;

/**
 * Sandboxes made by this worker so far. Each gets its own directory: a
 * harness's last hook can still run after its case ends, and must not land in
 * the next case's workspace.
 */
let created = 0;

export function e2eRoot(): string {
  return resolve(process.env['CONCORD_E2E_ROOT'] ?? join(REPO_ROOT, '.e2e'));
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
}

/** Run a shell command line the way a harness runs a hook. */
export function runShell(command: string, options: RunOptions = {}): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out after ${String(options.timeoutMs)}ms: ${command}\n${stderr}`));
    }, options.timeoutMs ?? 20_000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}

export class Sandbox {
  readonly home: string;
  readonly repo: string;
  readonly bin: string;
  readonly shimDir: string;

  private constructor(
    readonly root: string,
    readonly prefix: string,
    /** Host directories of real harness binaries, searched after Concord's. */
    private readonly harnessPath: readonly string[],
  ) {
    this.home = join(root, 'home');
    this.repo = join(root, 'repo');
    this.bin = join(root, 'bin');
    this.shimDir = join(root, 'shim');
  }

  /**
   * A fresh sandbox named after the test file, with Concord installed at
   * `prefix`. By default the harness binaries are shims; pass `realHarnesses`
   * (host directories holding real `claude`, `codex`, …) to use those instead.
   */
  static create(
    name: string,
    prefix: string,
    options: { realHarnesses?: readonly string[] } = {},
  ): Sandbox {
    created += 1;
    const root = join(e2eRoot(), 'sandboxes', `${name}-${String(process.pid)}-${String(created)}`);
    killSandboxProcesses(root);
    rmSync(root, { recursive: true, force: true });
    const sandbox = new Sandbox(root, prefix, options.realHarnesses ?? []);
    for (const directory of [sandbox.home, sandbox.repo, sandbox.bin, sandbox.shimDir]) {
      mkdirSync(directory, { recursive: true });
    }
    for (const harness of options.realHarnesses === undefined ? SHIMMED : []) {
      const wrapper = join(sandbox.bin, harness);
      writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${SHIM}" ${harness} "$@"\n`);
      chmodSync(wrapper, 0o755);
    }
    const git = (...args: string[]): void => {
      const result = spawnSync('git', ['-C', sandbox.repo, ...args], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    };
    git('init', '-q');
    git('config', 'user.name', 'Concord E2E');
    git('config', 'user.email', 'e2e@concord.invalid');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    return sandbox;
  }

  /** The environment every process in the sandbox starts from. */
  env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      HOME: this.home,
      PATH: [
        this.bin,
        join(this.prefix, 'bin'),
        // After Concord's own bin, so a host-wide `concord` never shadows the build under test.
        ...this.harnessPath,
        dirname(process.execPath),
        '/usr/bin',
        '/bin',
      ].join(':'),
      LANG: 'C.UTF-8',
      CONCORD_NO_UPDATE_CHECK: '1',
      CONCORD_TELEMETRY_DISABLED: '1',
      CONCORD_E2E_SHIM_DIR: this.shimDir,
      ...extra,
    };
  }

  /** Run the installed `concord` CLI in the repository. */
  concord(args: readonly string[], options: RunOptions = {}): Promise<CommandResult> {
    const quoted = args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(' ');
    return runShell(`concord ${quoted}`, {
      cwd: this.repo,
      env: this.env(options.env),
      ...(options.input === undefined ? {} : { input: options.input }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  }

  /** Every shim invocation so far, e.g. `codex app-server daemon start`. */
  shimCalls(): string[] {
    return readJsonLines(join(this.shimDir, 'calls.jsonl')).map((line) => {
      const call = shimCallSchema.parse(JSON.parse(line));
      return [call.harness, ...call.args].join(' ');
    });
  }

  /** Requests the fake Codex app-server received, as raw JSON lines. */
  codexAppServerLog(): string[] {
    return readJsonLines(join(this.shimDir, 'codex-app-server.jsonl'));
  }

  /** How the fake Codex app-server behaves for hosts started after this call. */
  setCodexAppServer(mode: 'idle' | 'busy' | 'down'): void {
    writeFileSync(join(this.shimDir, 'codex-mode'), mode);
  }

  dispose(): void {
    killSandboxProcesses(this.root);
    if (process.env['CONCORD_E2E_KEEP'] !== '1') {
      // A harness may still be flushing files as it exits.
      rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

const shimCallSchema = z.object({ harness: z.string(), args: z.array(z.string()) });

function readJsonLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/**
 * Detached processes (the Codex host, monitors) outlive the hook that started
 * them. Everything a sandbox starts carries its root in its command line.
 */
function killSandboxProcesses(root: string): void {
  spawnSync('pkill', ['-f', root]);
}
