import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { Sandbox } from '../support/sandbox.js';
import type { FakeModel } from './fake-model/server.js';

/**
 * Real harness binaries, pointed at the fake model. Each entry does what a
 * user does once per machine (accept onboarding, trust the folder or hooks,
 * choose a provider) and says how to start a one-turn headless session and,
 * where idle delivery exists, an interactive one.
 */

export type RealHarnessName = 'claude-code' | 'codex' | 'copilot-cli' | 'grok' | 'goose';

export interface RealHarness {
  name: RealHarnessName;
  /** Executable looked up on the host PATH. */
  executable: string;
  /** How a session idles: in a TUI, in a headless run kept alive by its monitor, or not at all. */
  idle: 'tui' | 'headless' | 'none';
  configure(sandbox: Sandbox, model: FakeModel): void;
  env(model: FakeModel): Record<string, string>;
  headless(prompt: string): string[];
  interactive(prompt: string): string[];
}

const FAKE_KEY = 'sk-ant-e2e-fake-model-0123456789abcdef';

function readJsonObject(path: string): Record<string, z.infer<ReturnType<typeof z.json>>> {
  if (!existsSync(path)) return {};
  return z.record(z.string(), z.json()).parse(JSON.parse(readFileSync(path, 'utf8')));
}

const claudeCode: RealHarness = {
  name: 'claude-code',
  executable: 'claude',
  idle: 'tui',
  configure(sandbox) {
    // First-run onboarding, the API key prompt, folder trust, and the project
    // MCP server approval: each answered once by a user, here up front.
    const statePath = join(sandbox.home, '.claude.json');
    const state = readJsonObject(statePath);
    writeFileSync(
      statePath,
      JSON.stringify({
        ...state,
        hasCompletedOnboarding: true,
        theme: 'dark',
        customApiKeyResponses: { approved: [FAKE_KEY.slice(-20)], rejected: [] },
        projects: {
          [sandbox.repo]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            enabledMcpjsonServers: ['concord'],
          },
        },
      }),
    );
    const settingsPath = join(sandbox.home, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        ...readJsonObject(settingsPath),
        enableAllProjectMcpServers: true,
        permissions: { defaultMode: 'bypassPermissions' },
        skipDangerousModePermissionPrompt: true,
      }),
    );
  },
  env: (model) => ({ ANTHROPIC_BASE_URL: model.origin, ANTHROPIC_API_KEY: FAKE_KEY }),
  headless: (prompt) => [
    'claude',
    '-p',
    prompt,
    '--model',
    'claude-haiku-4-5',
    '--permission-mode',
    'bypassPermissions',
  ],
  interactive: (prompt) => [
    'claude',
    '--model',
    'claude-haiku-4-5',
    '--dangerously-skip-permissions',
    prompt,
  ],
};

/**
 * Codex skips hooks until a user trusts them in `/hooks`, which records a hash
 * of each hook's definition. These are the hashes of Concord's three hook
 * commands; a Codex that hashes differently fails the identity check loudly.
 */
const CODEX_HOOK_TRUST: Record<string, string> = {
  session_start: 'sha256:f1921c86c53414742ff8eeab40334b6b32e7dbd75e6e2ee408633cb2771d0533',
  post_tool_use: 'sha256:7a21a227ed91b2a34bee521d7881d35a3640bb1a33e982574872cabf35e93582',
  stop: 'sha256:4111763c3f2997c80a72c7e05765f181c777672646e7c52bc9ad6b8fed8f0930',
};

const codex: RealHarness = {
  name: 'codex',
  executable: 'codex',
  idle: 'tui',
  configure(sandbox, model) {
    const configPath = join(sandbox.home, '.codex', 'config.toml');
    const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    // Top-level keys must precede every table, so they go first.
    const trust = Object.entries(CODEX_HOOK_TRUST)
      .map(
        ([event, hash]) => `[hooks.state."${configPath}:${event}:0:0"]\ntrusted_hash = "${hash}"\n`,
      )
      .join('\n');
    writeFileSync(
      configPath,
      [
        'model_provider = "fake"',
        'model = "fake-model"',
        '',
        existing,
        '',
        '[model_providers.fake]',
        'name = "fake"',
        `base_url = "${model.baseUrl}"`,
        'env_key = "FAKE_MODEL_KEY"',
        'wire_api = "responses"',
        '',
        trust,
      ].join('\n'),
    );
  },
  env: () => ({ FAKE_MODEL_KEY: 'fake' }),
  headless: (prompt) => [
    'codex',
    'exec',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    prompt,
  ],
  // Codex is reachable while idle only when launched through Concord's controller.
  interactive: (prompt) => [
    'concord',
    'adapters',
    'codex',
    '--',
    '--dangerously-bypass-approvals-and-sandbox',
    prompt,
  ],
};

const copilot: RealHarness = {
  name: 'copilot-cli',
  executable: 'copilot',
  idle: 'tui',
  configure: () => undefined,
  // A custom provider needs no GitHub login, and offline mode keeps the
  // session from reaching GitHub at all. `COPILOT_ALLOW_ALL=true` also trusts
  // the folder, which loads its MCP servers and hooks.
  env: (model) => ({
    COPILOT_OFFLINE: 'true',
    COPILOT_PROVIDER_TYPE: 'anthropic',
    COPILOT_PROVIDER_BASE_URL: model.origin,
    COPILOT_PROVIDER_API_KEY: FAKE_KEY,
    COPILOT_MODEL: 'claude-haiku-4-5',
    COPILOT_ALLOW_ALL: 'true',
    COPILOT_AUTO_UPDATE: 'false',
  }),
  headless: (prompt) => ['copilot', '--yolo', '-p', prompt],
  // Copilot is reachable while idle only when launched through Concord's adapter.
  interactive: (prompt) => ['concord', 'adapters', 'copilot', '--yolo', '-i', prompt],
};

const grok: RealHarness = {
  name: 'grok',
  executable: 'grok',
  // A headless run stays alive while its persistent monitor runs.
  idle: 'headless',
  configure(sandbox, model) {
    const grokHome = join(sandbox.home, '.grok');
    mkdirSync(grokHome, { recursive: true });
    appendFileSync(
      join(grokHome, 'config.toml'),
      [
        '',
        '[models]',
        'default = "fake"',
        '',
        '[model.fake]',
        'model = "fake-model"',
        `base_url = "${model.baseUrl}"`,
        'name = "Fake model"',
        'api_key = "fake"',
        'api_backend = "messages"',
        '',
      ].join('\n'),
    );
    // Folder trust gates the repository's MCP server and hooks.
    appendFileSync(
      join(grokHome, 'trusted_folders.toml'),
      `[folders."${sandbox.repo}"]\ntrusted = true\ndecided_at = 1792000000\n`,
    );
  },
  env: () => ({}),
  headless: (prompt) => ['grok', '--always-approve', '-p', prompt],
  interactive: (prompt) => ['grok', '--always-approve', '-p', prompt],
};

const goose: RealHarness = {
  name: 'goose',
  executable: 'goose',
  idle: 'none',
  configure(sandbox) {
    // Goose starts Concord as `npx -y @concord-ai/concord-mcp`; resolve that to
    // the build under test rather than whatever npm has published.
    const npx = join(sandbox.bin, 'npx');
    writeFileSync(
      npx,
      [
        '#!/bin/sh',
        '[ "$1" = "-y" ] && shift',
        'if [ "$1" = "@concord-ai/concord-mcp" ]; then shift; exec concord-mcp "$@"; fi',
        'echo "e2e sandbox: npx $* is not available" >&2; exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(npx, 0o755);
  },
  env: (model) => ({
    GOOSE_PROVIDER: 'anthropic',
    GOOSE_MODEL: 'claude-haiku-4-5',
    ANTHROPIC_HOST: model.origin,
    ANTHROPIC_API_KEY: FAKE_KEY,
    GOOSE_DISABLE_KEYRING: '1',
    GOOSE_MODE: 'auto',
  }),
  headless: (prompt) => ['goose', 'run', '--no-session', '-t', prompt],
  interactive: (prompt) => ['goose', 'run', '--no-session', '-t', prompt],
};

export const REAL_HARNESSES: readonly RealHarness[] = [claudeCode, codex, copilot, grok, goose];

/** The host directory holding a harness's executable, if it is installed. */
export function hostBinaryDir(executable: string): string | undefined {
  const found = spawnSync('/bin/sh', ['-c', `command -v ${executable}`], { encoding: 'utf8' });
  const path = found.stdout.trim();
  return found.status === 0 && path !== '' ? dirname(path) : undefined;
}
