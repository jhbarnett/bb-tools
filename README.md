# BB Tools

Extensions for [BB](https://getbb.app).

## MCP Control

Manage user-level MCP configurations for **Pi, Claude Code, and Codex** from one machine-scoped pane. Add, edit, enable/disable, remove, and authenticate servers using native harness configuration and login flows.

```sh
bb plugin install git:https://github.com/jhbarnett/bb-tools.git@main --plugin mcp-control
```

See [MCP Control's README](bb-plugin-mcp-control/README.md) for setup, authentication, safety, and scope limitations.

### Development

```sh
cd bb-plugin-mcp-control
npm ci
npm run check
bb plugin install . --yes
```
