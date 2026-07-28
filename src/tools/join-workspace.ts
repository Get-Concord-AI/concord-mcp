import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { joinWorkspaceInputShape } from '../domain/schemas.js';
import type { WorkspaceManager } from '../workspaces/manager.js';

export function registerJoinWorkspace(
  server: McpServer,
  manager: WorkspaceManager,
  onChange?: () => void,
): void {
  server.registerTool(
    'join_workspace',
    {
      title: 'Join workspace',
      description:
        'Validate and join a repository after this MCP server has started. Returns a workspace_id ' +
        'that can be supplied to every other Concord operation. Linked Git worktrees resolve to ' +
        'their shared primary workspace.',
      inputSchema: joinWorkspaceInputShape,
    },
    ({ root }) => {
      const result = manager.join(root);
      onChange?.();
      const verb = result.firstOpen ? 'Joined' : 'Selected';
      return {
        content: [
          {
            type: 'text',
            text: `${verb} workspace ${result.workspaceId} at ${result.repoRoot}.`,
          },
        ],
        structuredContent: {
          workspace_id: result.workspaceId,
          repo_root: result.repoRoot,
          first_open: result.firstOpen,
        },
      };
    },
  );
}
