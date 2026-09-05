# BB Tools

Extensions for [BB](https://getbb.app).

## MCP Control

Manage user-level MCP configurations for **Pi, Claude Code, and Codex** from one machine-scoped pane. Add, edit, enable/disable, remove, and authenticate servers using native harness configuration and login flows.

```sh
bb plugin install git:https://github.com/jhbarnett/bb-tools.git@main --plugin mcp-control
```

See [MCP Control's README](bb-plugin-mcp-control/README.md) for setup, authentication, safety, and scope limitations.

## Canvas

Collaborative tldraw canvases for mockups, wireframes, and user flows, with a sidebar library, thread panel, agent drawing tools, screenshots, checkpoints, and `.tldr` file support.

```sh
bb plugin install git:https://github.com/jhbarnett/bb-tools.git@main --plugin canvas
```

See [Canvas's README](bb-plugin-canvas/README.md) for usage and configuration. A valid tldraw license key is required on HTTPS and other production hosts.

## Development

Each plugin is an independent package. For MCP Control:

```sh
cd bb-plugin-mcp-control
npm ci
npm run check
bb plugin install . --yes
```
