# Sharing files between agents

An agent can attach files from its worktree to a prompt or reply. Concord checks
each file, stores it with the message, and lists the files in the message text.

**Status:** sending works. Retrieval, meaning a recipient saving a file to its own
worktree, is not part of this release. Recipients see the file references but
cannot save the bytes yet.

## Sending

Pass `attachments` to `update_work` with `operation` set to `prompt` or `reply`.
Paths are relative to the worktree you registered with `start_work`, or absolute
paths inside it.

```json
{
  "operation": "prompt",
  "to_agent_id": "agent-beta",
  "idempotency_key": "crash-1",
  "content": "The crash log is attached.",
  "attachments": ["logs/crash.log"]
}
```

The result lists the file ids it stored. The same references are appended to the
message text, so the recipient sees them in live delivery, in `inspect_work`, and
in `concord messages`:

```text
Attached files (listed for reference; retrieval is not available yet):
- f_8e0a2b5581b211a625dc5dab crash.log (text/plain, 8 bytes, sha256 0515b02c9623)
```

## Access and limits

- At most 5 files per message, 10 MiB per file, and 25 MiB in total.
- Only regular files inside the sender's worktree can be shared. Files under
  `.concord/` or `.git/` cannot, and a symlink that points outside the worktree is
  refused.
- The worktree must be a checkout of this repository. A worktree registered
  anywhere else cannot share files.
- A file is kept for 7 days after it was sent. Then its bytes are removed. The
  message text keeps the reference.
- A retry of a send with the same `idempotency_key` stores nothing new.

## Where the bytes live

Bytes are stored in `.concord/concord.db`, in the same database as the messages
they belong to. Every worktree of one repository on one machine shares that
database.

Not supported yet:

- Retrieval by the recipient. The bytes are stored, but there is no command or
  tool to save them.
- Agents on different machines.
- Repositories linked to Concord Cloud.
- Files on handoffs. `transfer_work` does not carry attachments yet.

## Failure messages

| Message (abbreviated)                               | Meaning                                                 |
| --------------------------------------------------- | ------------------------------------------------------- |
| `... is outside your worktree`                      | The path leads outside the sender's worktree.           |
| `... is Concord or git metadata`                    | The path is inside `.concord/` or `.git/`.              |
| `... is not a regular file`                         | The path is a directory or another special file.        |
| `... does not exist`                                | The path is not in the worktree.                        |
| `... is larger than the N-byte limit per file`      | The file is over 10 MiB.                                |
| `These files total more than N bytes`               | The attachments together are over 25 MiB.               |
| `A message can share at most 5 files`               | Too many attachments on one send.                       |
| `Agent ... registered no worktree`                  | Start the agent with `start_work` and a worktree first. |
| `Worktree ... is not a checkout of this repository` | The registered worktree belongs to another repository.  |
| `Files cannot be shared here`                       | The server does not know its workspace root.            |
