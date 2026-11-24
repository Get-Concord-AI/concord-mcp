"""Concord tools for a local OpenHands Agent Server conversation."""

import os
from pathlib import Path
from shutil import which

from openhands.sdk.conversation.state import ConversationState
from openhands.sdk.mcp import MCPServer, create_mcp_tools
from openhands.sdk.tool import ToolDefinition, register_tool
from pydantic import SecretStr


class ConcordToolSet(ToolDefinition):
    name = "concord"
    catalog_description = "Coordinate work with agents in the same repository."

    @classmethod
    def create(cls, conv_state: ConversationState) -> list[ToolDefinition]:
        server_path = os.pathsep.join(
            directory for directory in os.get_exec_path() if os.path.isabs(directory)
        )
        node = which("node", path=server_path)
        if not node:
            raise FileNotFoundError("Install Node.js on the OpenHands Agent Server.")
        entry = Path(__file__).resolve().parents[2] / "dist" / "index.js"
        workspace = str(Path(conv_state.workspace.working_dir).resolve())
        server = MCPServer(
            command=node,
            args=[str(entry)],
            cwd=workspace,
            env={
                # MCP stdio does not inherit these operator preferences by default.
                **{
                    name: SecretStr(os.environ[name])
                    for name in (
                        "CONCORD_TELEMETRY_DISABLED",
                        "DO_NOT_TRACK",
                        "CONCORD_NO_UPDATE_CHECK",
                    )
                    if name in os.environ
                },
                # A server-wide name would give every fork the same inbox.
                "CONCORD_AGENT_ID": SecretStr(""),
                "CONCORD_AGENT_KIND": SecretStr("openhands"),
                "CONCORD_OPENHANDS_CONVERSATION_ID": SecretStr(str(conv_state.id)),
                "CONCORD_REPO_ROOT": SecretStr(workspace),
            },
        )
        return create_mcp_tools({"concord": server}).tools


register_tool(ConcordToolSet.name, ConcordToolSet)
