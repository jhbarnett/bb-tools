# bb-canvas

A [BB](https://getbb.app) plugin: a collaborative [tldraw](https://tldraw.dev)
canvas for mockups, wireframes, and user flows that you and your agents
iterate on together.

## What you get

- **Canvas sidebar panel** — a library of canvases per project; open one and
  draw on a full tldraw editor.
- **Thread Canvas tab** — open a canvas beside any agent conversation
  (right panel → `+` → Canvas). The thread's canvas is created on demand and
  linked to the thread.
- **Agent tools** — `canvas_list`, `canvas_create`, `canvas_read`,
  `canvas_edit`, `canvas_screenshot`, `canvas_checkpoint`. Agents draw with
  validated structured operations; your open editor merges their changes live.
  `canvas_screenshot` returns a PNG so multimodal agents can *see* your
  freehand annotations.
- **`@canvas` mentions** — attach a canvas's current state to a prompt.
- **Checkpoints** — named snapshots with one-click restore.
- **`.tldr` file opener** — `.tldr` files in a workspace open on a live
  canvas and save back.
- **Skill** — `skills/canvas` teaches agents wireframing conventions
  (frame-per-screen, flow arrows, annotate-then-screenshot loop).

## Install

```sh
bb plugin install git:https://github.com/jhbarnett/bb-tools.git@main --plugin canvas
```

## Licensing note

The canvas is built on tldraw SDK 5.x. tldraw requires a valid trial,
commercial, or hobby license key on HTTPS and other production hosts; without
one, Canvas shows a configuration screen instead of mounting an editor that the
SDK will hide after its license timeout. Keys are public and domain-restricted.

Set the key under **Extensions → Plugins → Canvas**, or run
`bb plugin config canvas set licenseKey <key>`. See
[tldraw's license-key documentation](https://tldraw.dev/sdk-features/license-key)
for current license options and host rules.

## Development

```sh
npm install
npx vitest run      # server + doc-engine tests
bb plugin dev       # rebuild + reload on save against your running bb
```

Architecture notes: canvases are tldraw document snapshots in the plugin's
SQLite database with a versioned op log. The browser editor autosaves with a
compare-and-swap; agent tools mutate the document server-side through
`@tldraw/tlschema`-validated operations and publish a realtime signal, which
open editors apply via `store.mergeRemoteChanges`. Screenshots are produced by
the open editor on request (realtime request → `editor.toImage` → rpc submit).
