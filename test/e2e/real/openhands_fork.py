"""Manual integration test (outside CI). Run from the checkout with SDK 1.63, Node.js and the candidate concord on PATH:

    PYTHONPATH=plugin/openhands python test/e2e/real/openhands_fork.py
"""

import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack, chdir
from pathlib import Path

from concord_openhands import ConcordToolSet
from openhands.sdk import LLM, Agent, Conversation, Tool


class OpenHandsForkTest(unittest.TestCase):
    def test_fork_owns_its_claim_and_receives_literal_messages(self):
        with tempfile.TemporaryDirectory() as tmpdir, chdir(tmpdir), ExitStack() as sessions:
            workspace = Path("project")
            workspace.mkdir()
            workdir = str(workspace.resolve())
            agent = Agent(
                llm=LLM(model="gpt-4o-mini"), tools=[Tool(name=ConcordToolSet.name)]
            )
            parent = Conversation(agent=agent, workspace=str(workspace))
            sessions.callback(parent.close)
            parent.send_message("Initialize the tools.")

            def claim(conversation, task, **arguments):
                tool = conversation.agent.tools_map["start_work"]
                action = tool.action_from_arguments(
                    {"task_id": task, "title": task, "kind": "openhands", **arguments}
                )
                result = tool.executor(action, conversation)
                self.assertFalse(result.is_error, result.text)
                return result.text

            def owner(task):
                output = subprocess.check_output(
                    ["concord", "work", "inspect", "--task", task],
                    cwd=workdir,
                    env={**os.environ, "CONCORD_REPO_ROOT": workdir},
                    text=True,
                )
                view = json.loads(output)
                self.assertEqual(view["repo_root"], workdir)
                return view["task"]["agentId"]

            claim(parent, "parent-task")
            parent_id = owner("parent-task")
            child = parent.fork()
            sessions.callback(child.close)
            child.send_message("Initialize the fork's tools.")
            claim(child, "child-task", agent_id=parent_id)
            child_id = owner("child-task")
            self.assertRegex(parent_id, r"^openhands:[0-9a-f]{8}$")
            self.assertRegex(child_id, r"^openhands:[0-9a-f]{8}$")
            self.assertNotEqual(parent_id, child_id)
            self.assertEqual(owner("parent-task"), parent_id)

            parent.update_secrets({"EXAMPLE_LABEL": "example-only"})
            content = "Use $EXAMPLE_LABEL or ${EXAMPLE_LABEL} in the template."
            tool = parent.agent.tools_map["update_work"]
            action = tool.action_from_arguments({
                "operation": "prompt",
                "to_agent_id": child_id,
                "content": content,
                "idempotency_key": "literal-template",
            })
            result = tool.executor(action, parent)
            self.assertFalse(result.is_error, result.text)
            messages = subprocess.check_output(
                ["concord", "messages", "--agent", child_id, "--json"],
                cwd=workdir,
                env={**os.environ, "CONCORD_REPO_ROOT": workdir},
                text=True,
            )
            self.assertEqual(
                [message["content"] for message in json.loads(messages)], [content]
            )

            response = claim(parent, "example-only")
            self.assertIn("Started <secret-hidden>", response)
            self.assertNotIn("example-only", response)


if __name__ == "__main__":
    unittest.main()
