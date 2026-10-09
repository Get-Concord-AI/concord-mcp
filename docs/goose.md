# Using Concord with Goose

Run `concord setup` in the repository. Setup registers Concord's MCP server in
Goose's `config.yaml` when `goose` is detected. The extension is added under the
`extensions` key and preserves any existing extensions and settings.

Goose is an MCP-capable agent with no verified session wake or resume mechanism.
Concord can register its MCP server with Goose, but inbox messaging is not
currently supported because Concord cannot reliably register a Goose session
endpoint for message delivery. Do not rely on `send_agent_message` for Goose
sessions yet.

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
    timeout: 300
```

> **Note:** Goose configuration is loaded and rewritten as YAML during
> installation, so existing YAML comments may not be preserved.
