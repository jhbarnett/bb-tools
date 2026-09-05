# MCP Control for BB

A machine-scoped control pane for **Pi, Claude Code, and Codex** MCP configurations.

## Use

```sh
npm install
npm run check
bb plugin install . --yes
```

Open **MCP Control** in BB's sidebar, select a machine, then:

1. **Add MCP**: enter a server name and its native server JSON (HTTP and stdio templates included).
2. Select **Enable for** Pi, Claude Code, and/or Codex. Portable fields are copied when selecting a new harness. Review each harness's JSON before saving; advanced options and incompatible secret expansion need manual configuration.
3. **Save configuration**, then **Authenticate** under the relevant harness. A native login terminal opens in the pane.
4. **Edit / remove** changes existing entries or removes them with confirmation.

There are no agent-facing write or authentication tools. Read-only inventory:

```sh
bb mcp-control list <host-id>
```

## Scope

Only these **user-level files on the selected machine** are managed:

| Harness | File | Disable behavior |
| --- | --- | --- |
| Pi (`pi-mcp-adapter`) | `$PI_CODING_AGENT_DIR/mcp.json`, normally `~/.pi/agent/mcp.json` | `disabled: true` |
| Claude Code | `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` | Remove its user entry; backup retained |
| Codex | `$CODEX_HOME/config.toml`, normally `~/.codex/config.toml` | `enabled: false` |

Configuration presence is **not live connection or authentication status**. Changes apply when a harness next loads its configuration. Project/shared/managed settings, Pi compatibility imports, Codex profiles, and BB-injected tools are not enumerated or modified. They can add servers or override user-level selections. Removing a user entry does not revoke tokens or guarantee that the server disappears from every project.

Existing entries retain their native, harness-specific fields. Names containing characters outside letters, digits, underscores, dots, and hyphens are visible but read-only. Rename by adding a new entry and then removing the old entry; native credential identity is name-sensitive.

## Authentication

Requires the respective harness CLI on the selected host's PATH. Pi additionally requires `pi-mcp-adapter`; this plugin does not install it or replace it.

- **Pi:** starts `pi --no-session`; run the displayed `/mcp-auth <server>` command in its terminal. For remote OAuth, use the adapter's native `auth-start` / `auth-complete` flow. The plugin does not initiate model prompts.
- **Claude Code:** runs `claude mcp login --no-browser <server>`. Open the printed URL and paste the complete redirect URL into the terminal when prompted. Older Claude versions without this subcommand need upgrading or native `/mcp` authentication.
- **Codex:** runs `codex mcp login <server>`. For remote browsers, paste the unreachable localhost callback address into **Complete remote login**. Relay is offered only after detecting the native CLI's authorization request, and validates its exact loopback origin, path, and OAuth state. It never follows redirects. If a provider uses an unsupported URL format, use the native login/port-forwarding flow.
- **API keys/bearer tokens:** configure native `headers` / `http_headers`, `bearerTokenEnv` (Pi), or `bearer_token_env_var` (Codex). Prefer environment references; the variables must already exist in the harness environment. This plugin does not inject environment variables.

Embedded authentication supports macOS and Linux. Configuration editing is host-routed on all platforms; run native authentication separately on Windows. Pi's secure credential storage requires a working OS keychain (including an unlocked Secret Service on Linux).

Tokens remain in each harness's own credential store and are not shared between harnesses. Authentication terminals close when the pane unmounts or the plugin unloads, and expire after 15 minutes. Read the native process's result: an exited terminal is not by itself proof of successful authentication.

## Safety and recovery

- No configuration writes or MCP subprocess launches occur on plugin load or inventory refresh.
- The host worker resolves native paths; every config read/write goes through `bb.sdk.files` with an explicit host ID.
- All inputs and file revisions are checked before writing. Every file write uses compare-and-swap so a concurrent edit is not silently overwritten.
- Existing files are backed up to `<config-path>.mcp-control-<uuid>.bak` with mode `0600` before modification. New config files use `0600`; BB preserves existing file permissions. Backups contain the original secrets: protect them and delete them manually when no longer needed. No automatic retention policy is applied.
- JSON patches preserve unrelated formatting and settings. **Codex TOML is parsed and reserialized, preserving values but not comments/formatting.** Restore the backup if you need the original text.
- Writes are **not a cross-file transaction**. If a later harness fails or disconnects, earlier successful writes remain applied. The pane reports each result and backup path, stops remaining writes, and asks you to refresh before retrying. A lost response means a write may have completed: inspect actual files rather than blindly restoring.
- Malformed/unreadable files are shown as errors and protected from writes. Readable sibling harnesses remain usable. Removing from all writable harnesses leaves unreadable files untouched.
- Inventory hides credentials, arguments, commands, and URL paths/query strings. Only explicitly opening the JSON editor returns a server's complete native configuration to the authenticated BB frontend. Full configuration documents, unrelated settings, and auth terminal output are not exposed by the read-only CLI.
- Native terminal output/scrollback and the editor may contain sensitive values. Do not share them or paste credentials into agent conversations. BB plugins are full-trust code, not a secret isolation boundary.

## Development

```sh
npm run typecheck
npm test                  # Node's built-in test runner; pure logic + BB fake-host tests
npm run build             # server, app and host artifacts
bb plugin reload mcp-control
```

The test suite uses temporary/in-memory configuration, never your live harness settings. Actual OAuth authorization is interactive and must be verified with your own server and browser.
