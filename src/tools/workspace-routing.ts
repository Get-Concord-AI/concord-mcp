import type { WorkspaceContext, WorkspaceIdentity } from '../workspaces/manager.js';

export type SelectWorkspace = (workspaceId?: string) => WorkspaceContext;

export function selectToolWorkspace(
  selectWorkspace: SelectWorkspace | undefined,
  workspaceId: string | undefined,
): WorkspaceIdentity | undefined {
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

export function withWorkspaceText(text: string, workspace: WorkspaceIdentity | undefined): string {
  if (workspace === undefined) {
    return text;
  }
  return `Workspace: ${workspace.workspaceId} (${workspace.repoRoot})\n${text}`;
}
