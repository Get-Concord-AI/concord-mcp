import { repoRelativePath } from '../config/paths.js';
import type { WorkspaceContext, WorkspaceIdentity } from '../workspaces/manager.js';

export type SelectWorkspace = (workspaceId?: string) => WorkspaceContext;

export function selectToolWorkspace(
  selectWorkspace: SelectWorkspace | undefined,
  workspaceId: string | undefined,
): WorkspaceContext | undefined {
  return selectWorkspace?.(workspaceId);
}

export function workspaceStructured(workspace: WorkspaceIdentity | undefined): {
  workspace_id?: string;
  repo_root?: string;
} {
  return workspace === undefined
    ? {}
    : { workspace_id: workspace.workspaceId, repo_root: workspace.repoRoot };
}

/**
 * Declared files as the workspace's repository names them, so an absolute or
 * symlinked path claims the same file as its repo-relative spelling.
 */
export function filesInWorkspace(
  files: string[] | undefined,
  workspace: WorkspaceIdentity | undefined,
): string[] | undefined {
  if (files === undefined || workspace === undefined) {
    return files;
  }
  return files.map((file) => repoRelativePath([workspace.repoRoot], file));
}

export function withWorkspaceText(text: string, workspace: WorkspaceIdentity | undefined): string {
  if (workspace === undefined) {
    return text;
  }
  return `Workspace: ${workspace.workspaceId} (${workspace.repoRoot})\n${text}`;
}
