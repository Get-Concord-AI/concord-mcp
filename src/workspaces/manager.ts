import { delimiter } from 'node:path';

import {
  concordDir,
  databasePath,
  resolveExplicitRepoRoot,
  workspaceIdForRoot,
  workspaceRootFromId,
} from '../config/paths.js';
import { openRepositories, type Repositories } from '../db/index.js';

export interface WorkspaceIdentity {
  workspaceId: string;
  repoRoot: string;
}

export interface WorkspaceContext extends WorkspaceIdentity {
  concordPath: string;
  repos: Repositories;
}

export interface WorkspaceSelection extends WorkspaceIdentity {
  firstOpen: boolean;
}

export interface WorkspaceManagerOptions {
  allowedRoots?: readonly string[];
  open?: (databaseFilename: string) => Repositories;
}

/**
 * Open and route Concord workspaces within one MCP server process.
 *
 * Workspace ids are reversible path-backed ids, so a CLI process can select
 * the same workspace without relying on a separate global registry.
 */
export class WorkspaceManager {
  readonly #contexts = new Map<string, WorkspaceContext>();
  readonly #allowedRoots: Set<string> | undefined;
  readonly #open: (databaseFilename: string) => Repositories;
  #activeWorkspaceId: string;

  constructor(initialRoot: string, options: WorkspaceManagerOptions = {}) {
    this.#open = options.open ?? openRepositories;
    this.#allowedRoots =
      options.allowedRoots === undefined
        ? undefined
        : new Set(options.allowedRoots.map((root) => resolveExplicitRepoRoot(root)));
    const initial = this.join(initialRoot);
    this.#activeWorkspaceId = initial.workspaceId;
  }

  /** Build a manager using the optional path-delimited environment allowlist. */
  static fromEnvironment(
    initialRoot: string,
    env: NodeJS.ProcessEnv,
    options: Omit<WorkspaceManagerOptions, 'allowedRoots'> = {},
  ): WorkspaceManager {
    const raw = env['CONCORD_ALLOWED_ROOTS'];
    const allowedRoots =
      raw === undefined || raw.trim() === ''
        ? undefined
        : raw
            .split(delimiter)
            .map((root) => root.trim())
            .filter((root) => root !== '');
    return new WorkspaceManager(
      initialRoot,
      allowedRoots === undefined ? options : { ...options, allowedRoots },
    );
  }

  /** The active/default context used when an operation omits `workspace_id`. */
  current(): WorkspaceContext {
    const context = this.#contexts.get(this.#activeWorkspaceId);
    if (context === undefined) {
      throw new Error('Concord has no active workspace.');
    }
    return context;
  }

  /** Validate, open (once), and make a repository root active. */
  join(root: string): WorkspaceSelection {
    const repoRoot = resolveExplicitRepoRoot(root);
    this.#assertAllowed(repoRoot);
    const workspaceId = workspaceIdForRoot(repoRoot);
    let context = this.#contexts.get(workspaceId);
    const firstOpen = context === undefined;
    if (context === undefined) {
      context = {
        workspaceId,
        repoRoot,
        concordPath: concordDir(repoRoot),
        repos: this.#open(databasePath(repoRoot)),
      };
      this.#contexts.set(workspaceId, context);
    }
    this.#activeWorkspaceId = workspaceId;
    return { workspaceId, repoRoot, firstOpen };
  }

  /**
   * Select an already-known or path-decodable workspace. Omitting the id keeps
   * the current selection for backward-compatible clients.
   */
  select(workspaceId?: string): WorkspaceContext {
    if (workspaceId === undefined) {
      return this.current();
    }
    const cached = this.#contexts.get(workspaceId);
    if (cached !== undefined) {
      this.#activeWorkspaceId = workspaceId;
      return cached;
    }
    const root = workspaceRootFromId(workspaceId);
    this.join(root);
    return this.current();
  }

  #assertAllowed(repoRoot: string): void {
    if (this.#allowedRoots !== undefined && !this.#allowedRoots.has(repoRoot)) {
      throw new Error(
        `Workspace root is not allowed: ${repoRoot}. Add it to CONCORD_ALLOWED_ROOTS.`,
      );
    }
  }
}

/**
 * A getter-backed repository facade. Existing tool handlers can remain pure
 * and continue accepting `Repositories`; each property resolves against the
 * workspace selected immediately before the handler runs.
 */
export function routedRepositories(manager: WorkspaceManager): Repositories {
  return {
    get db() {
      return manager.current().repos.db;
    },
    get tasks() {
      return manager.current().repos.tasks;
    },
    get handoffs() {
      return manager.current().repos.handoffs;
    },
    get reviews() {
      return manager.current().repos.reviews;
    },
    get taskUpdates() {
      return manager.current().repos.taskUpdates;
    },
    get events() {
      return manager.current().repos.events;
    },
    get agents() {
      return manager.current().repos.agents;
    },
    get ownershipEvents() {
      return manager.current().repos.ownershipEvents;
    },
    get agentEndpoints() {
      return manager.current().repos.agentEndpoints;
    },
    get agentMessages() {
      return manager.current().repos.agentMessages;
    },
  };
}
