# Sharing files between agents

An agent can attach files from its worktree to a prompt or reply. The recipient
saves them with `concord files get`, and the bytes are checked against a SHA-256
checksum before anything is written.

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
Attached files (retrieve with `concord files get <file-id> --to <path>`):
- f_8e0a2b5581b211a625dc5dab crash.log (text/plain, 8 bytes, sha256 0515b02c9623)
```

## Retrieving

```sh
concord files get f_8e0a2b5581b211a625dc5dab --to received/crash.log
```

Run it from any directory of the recipient's repository. `--to` is relative to the
recipient's registered worktree, or an absolute path inside it. If the session
cannot identify its agent, add `--agent <id>`.

On success the command prints the file name, its size, and that its checksum was
verified. Refusals print one line and exit non-zero.

## Access and limits

- At most 5 files per message, 10 MiB per file, and 25 MiB in total.
- Only regular files inside the sender's worktree can be shared. Files under
  `.concord/` or `.git/` cannot, and a symlink that points outside the worktree is
  refused.
- Only the sender and recipient of the message can retrieve a file. Anyone else is
  told that the file is not available to them.
- Retrieval never overwrites. If the target exists, choose another `--to` path.
- Retrieval writes only inside the recipient's worktree, including when the target
  path runs through a symlinked folder.
- A file is kept for 7 days after it was sent. Then its bytes are removed. The
  message text keeps the reference, and retrieving the file reports that it was
  removed.
- A retry of a send with the same `idempotency_key` stores nothing new.

## Where the bytes live

Bytes are stored in `.concord/concord.db`, in the same database as the messages
they belong to. Every worktree of one repository on one machine shares that
database, so sharing works between linked git worktrees.

Not supported yet:

- Agents on different machines. Each machine has its own store, so a recipient
  there gets "No shared file ... is available" for a file sent from elsewhere.
- Repositories linked to Concord Cloud. Their messages are served by the cloud, so
  `concord files` refuses to run there.
- Files on handoffs. `transfer_work` does not carry attachments yet.

## Failure messages

| Message (abbreviated)                               | Meaning                                                    |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `... is outside your worktree`                      | The path leads outside the sender's worktree.              |
| `... is Concord or git metadata`                    | The path is inside `.concord/` or `.git/`.                 |
| `... is not a regular file`                         | The path is a directory or another special file.           |
| `... is N bytes; the limit is ...`                  | The file is over 10 MiB.                                   |
| `A message can share at most 5 files`               | Too many attachments on one send.                          |
| `No shared file ... is available to ...`            | Unknown id, or the caller is neither sender nor recipient. |
| `... was removed on ..., when its retention ended`  | The 7-day retention has passed.                            |
| `... failed its checksum, so nothing was saved`     | The stored bytes do not match what was sent.               |
| `... already exists; choose another --to path`      | Retrieval would overwrite a file.                          |
| `... is outside your worktree; retrieved files ...` | The `--to` path leads outside the recipient's worktree.    |
| `registered no worktree`                            | Start the agent with `start_work` and a worktree first.    |
