import { delimiter } from 'node:path';

import {
  resolveExplicitRepoRoot,
  workspaceIdForRoot,
  workspaceRootFromId,
} from '../config/paths.js';
import { openRepositories, type Repositories } from '../db/index.js';
import { resolveStore, type StoreLocation } from './store.js';

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
  open?: (databaseFilename: string, project: string) => Repositories;
  /** Where a root's state lives; the repository's own store unless global mode applies. */
  resolveStore?: (repoRoot: string) => StoreLocation;
  /**
   * Why no store may be opened now, checked before each first open: a server
   * started while its machine was unlinked keeps running after a login links
   * it, and must not open a local store there.
   */
  refuseOpen?: () => string | undefined;
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
  readonly #open: (databaseFilename: string, project: string) => Repositories;
  readonly #resolveStore: (repoRoot: string) => StoreLocation;
  readonly #refuseOpen: () => string | undefined;
  #activeWorkspaceId: string;
  #selections = 0;

  constructor(initialRoot: string, options: WorkspaceManagerOptions = {}) {
    this.#open = options.open ?? openRepositories;
    this.#resolveStore = options.resolveStore ?? ((root) => resolveStore(root, process.env));
    this.#refuseOpen = options.refuseOpen ?? (() => undefined);
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
    const withStore = { resolveStore: (root: string) => resolveStore(root, env), ...options };
    return new WorkspaceManager(
      initialRoot,
      allowedRoots === undefined ? withStore : { ...withStore, allowedRoots },
    );
  }

  /** How many times a workspace has been chosen explicitly: a join, or a tool call naming one. */
  get selections(): number {
    return this.#selections;
  }

  /**
   * The active workspace's root without throwing.
   * For diagnostics such as telemetry, which must never block a reply.
   */
  get activeRoot(): string | undefined {
    return this.#contexts.get(this.#activeWorkspaceId)?.repoRoot;
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
    this.#selections += 1;
    const repoRoot = resolveExplicitRepoRoot(root);
    this.#assertAllowed(repoRoot);
    const workspaceId = workspaceIdForRoot(repoRoot);
    let context = this.#contexts.get(workspaceId);
    const firstOpen = context === undefined;
    if (context === undefined) {
      const refusal = this.#refuseOpen();
      if (refusal !== undefined) throw new Error(refusal);
      const store = this.#resolveStore(repoRoot);
      context = {
        workspaceId,
        repoRoot,
        concordPath: store.concordPath,
        repos: this.#open(store.databasePath, store.project),
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
    this.#selections += 1;
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
    get project() {
      return manager.current().repos.project;
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
