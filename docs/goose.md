# Using Concord with Goose

Run `concord setup` in the repository. Setup registers Concord's MCP server in
Goose's `config.yaml` when `goose` is detected. The extension is added under the
`extensions` key and preserves any existing extensions and settings.

Goose is an MCP-capable agent with no verified session wake or resume mechanism.
Concord therefore uses **durable inbox delivery** for idle reach: peer messages
are queued in the local SQLite workspace and consumed when the Goose session next
polls the inbox. There is no background monitor or hook to wake an idle session
automatically.

## Configuration

Concord is written to the standard Goose config file:

- **Windows**: `%APPDATA%\Block\goose\config\config.yaml`
- **Unix**: `~/.config/goose/config.yaml`

The entry added looks like:

```yaml
extensions:
  concord-relay:
    enabled: true
    type: stdio
    name: concord-relay
    description: Concord shared work-state for coding agents
    cmd: npx
    args:
      - -y
      - '@concord-ai/concord-mcp'
    envs: {}
    timeout: 300
```
