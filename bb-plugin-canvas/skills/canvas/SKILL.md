---
name: canvas
description: Draw wireframes, screen flows, architecture diagrams, flowcharts, and explanatory system maps on the shared tldraw canvas with the canvas_* tools. Use when the user asks to sketch, wireframe, mock up, map a process, or diagram components and relationships; the user sees and annotates the same canvas live.
---

# Drawing wireframes on the shared canvas

The Canvas plugin gives you a tldraw canvas the user sees live (sidebar "Canvas"
panel, or the thread's Canvas side tab). Use the native tools — `canvas_read`,
`canvas_edit`, `canvas_screenshot`, `canvas_list`, `canvas_create`,
`canvas_checkpoint`. Omit `canvasId` to use this thread's canvas (created
automatically on first edit).

## Core loop

1. `canvas_read` (or `canvas_screenshot`) before editing — never draw blind on
   a non-empty canvas. Screenshots show the user's freehand ink annotations,
   which `canvas_read` cannot.
2. `canvas_edit` with a batch of operations.
3. `canvas_screenshot` after substantial edits to check layout, overlaps, and
   spacing — then fix what looks wrong.
4. Before reworking a design the user liked, save a `canvas_checkpoint`
   (e.g. "v0 concept") so they can restore it.

## Choose the diagram grammar

Choose one dominant grammar before placing shapes:

- **Screen flow** — one `frame` per screen, arranged left-to-right in the
  journey's order.
- **Architecture** — components grouped by tier, region, ownership, or trust
  boundary; use a `frame` around two or more related nodes.
- **Flowchart** — top-to-bottom; `oval` for start/end, `rectangle` for an
  action, and `diamond` for a decision. Label every decision exit.
- **Hierarchy** — parent above children, with each level aligned consistently.
- **Layer stack** — wide horizontal bands ordered from highest abstraction
  to lowest implementation or enforcement surface.

Keep one reading grammar per page. When the request needs both an overview and
detailed behavior, use separate pages.

## Screen-flow conventions

- **One frame per screen.** Create a `frame` (mobile ~390×760, desktop
  ~1280×800) named for the screen ("Login", "Dashboard"). Put the screen's
  shapes inside it via `parentId` — child x/y are relative to the frame.
- **Lay screens out left-to-right** in flow order with ~120px gaps between
  frames; connect frames with labeled arrows to show user flows
  ("taps Sign up →").
- **Lo-fi first**: grey/black rectangles for containers and buttons,
  `text` shapes for headings and labels, `x-box` as an image placeholder,
  `check-box` for checkboxes, `oval`/`ellipse` for avatars. `fill: "semi"`
  for buttons and emphasized areas; leave the rest `none`.
- **Notes for commentary**: `note` (sticky) shapes for rationale, open
  questions, and alternatives — outside the frames, near what they discuss.
- **Space generously.** Text grows with content; leave ≥16px padding inside
  containers and ≥24px between siblings so nothing overlaps.
- Separate journeys go on separate pages (`create_page`), not one giant page.

## Diagram quality

- Pick one reading direction—left-to-right or top-to-bottom—and hold it.
- Work on an 8px grid. Prefer 24, 32, or 48px gaps and at least 16px internal
  padding. Peer nodes should use matching dimensions.
- Aim for no more than 9 primary nodes and 12 arrows on one page. If the
  diagram exceeds that, split it into overview and detail pages.
- Use color by semantic role and keep ordinary nodes neutral. Reserve the
  strongest accent for at most two focal shapes.
- Use `fromId` and `toId` for relationships so arrows remain attached when
  the user moves nodes.
- Route by layout: no arrow should pass through an unrelated shape, and remove
  crossings by repositioning nodes. Keep labels short and action-oriented.
- A frame used as a zone needs a clear name and header space before its first
  child. Keep legends and commentary outside zones.
- Before finishing, try to remove or merge one node, arrow, or label. Keep it
  only if the diagram becomes less understandable without it.

Example: for “browser → API → queue → workers → database”, place the five
components left-to-right. Put API, queue, and workers inside a `SERVICES`
frame and the database in a `DATA` frame. Bind arrows by shape id and label
only non-obvious semantics such as `publishes` and `writes`. Put retries,
dead-letter handling, and observability on a second “Failure paths” page.

## Final screenshot check

After the final `canvas_screenshot`, verify:

1. The reading order is obvious without explanation.
2. No labels, nodes, or arrows overlap.
3. Every arrow can be traced end-to-end and avoids unrelated nodes.
4. Decision exits and non-obvious relationships are labeled.
5. Boundaries contain the intended nodes and leave visible header padding.
6. No more than two shapes dominate through color or fill.
7. The diagram still works if decorative notes are ignored.

## Working with the user

- The user annotates in freehand ink and sticky notes. When asked to revise,
  take a `canvas_screenshot` first and treat ink circles/arrows/notes as the
  feedback to address.
- Iterate versions side by side when exploring: copy the concept into a new
  frame ("Login v2") rather than destroying v1, or checkpoint before replacing.
- Give shapes meaningful ids (`login-frame`, `cta`, `hero-img`) so later
  `update_shape` calls are easy.
