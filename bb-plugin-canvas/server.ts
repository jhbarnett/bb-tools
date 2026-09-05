// bb-plugin-canvas — collaborative tldraw canvas for mockups and wireframes.
//
// Documents are tldraw snapshots persisted in the plugin database. The open
// editor (app.tsx) autosaves with a version CAS; agent tools mutate the
// document server-side through validated operations (doc.ts) and publish a
// realtime signal so open editors merge the change live.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applyOperations,
  createEmptyDocument,
  CanvasOpError,
  operationSchema,
  simplifyDocument,
  type CanvasDocument,
  type DocRecord,
} from "./doc";
import { openCanvasStore, type CanvasMeta, type CanvasStore } from "./store";

// Realtime channels (payloads are ephemeral signals; clients refetch via rpc).
export const CANVAS_CHANGED = "canvas-changed";
export const CANVAS_LIST_CHANGED = "canvas-list-changed";
export const SCREENSHOT_REQUEST = "canvas-screenshot-request";

const canvasMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  threadId: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const documentSchema = z.object({
  store: z.record(z.string(), z.unknown()),
  schema: z.unknown(),
});

const opRowSchema = z.object({
  version: z.number(),
  puts: z.array(z.unknown()).nullable(),
  removes: z.array(z.string()).nullable(),
  fullReplace: z.boolean(),
  source: z.string(),
});

const checkpointSchema = z.object({
  id: z.string(),
  canvasId: z.string(),
  name: z.string(),
  version: z.number(),
  createdAt: z.string(),
});

const fileSourceSchema = z.object({
  kind: z.enum(["workspace", "host", "thread-storage"]),
  environmentId: z.string().nullable().optional(),
  hostId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
});

export const rpcContract = defineRpcContract({
  canvas_list: {
    input: z.object({ projectId: z.string().optional() }),
    output: z.object({ canvases: z.array(canvasMetaSchema) }),
  },
  canvas_create: {
    input: z.object({
      title: z.string().trim().min(1).max(120),
      projectId: z.string().optional(),
      threadId: z.string().optional(),
    }),
    output: canvasMetaSchema,
  },
  canvas_get: {
    input: z.object({ id: z.string() }),
    output: z.object({ meta: canvasMetaSchema, document: documentSchema }),
  },
  canvas_get_or_create_for_thread: {
    input: z.object({ threadId: z.string() }),
    output: canvasMetaSchema,
  },
  canvas_rename: {
    input: z.object({ id: z.string(), title: z.string().trim().min(1).max(120) }),
    output: canvasMetaSchema,
  },
  canvas_delete: {
    input: z.object({ id: z.string() }),
    output: z.object({ deleted: z.boolean() }),
  },
  canvas_save: {
    input: z.object({
      id: z.string(),
      baseVersion: z.number(),
      clientId: z.string().min(1).max(120).optional(),
      document: documentSchema,
      puts: z.array(z.unknown()).optional(),
      removes: z.array(z.string()).optional(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("saved"), version: z.number() }),
      z.object({
        outcome: z.literal("conflict"),
        version: z.number(),
        ops: z.array(opRowSchema),
        document: documentSchema.optional(),
      }),
    ]),
  },
  canvas_ops: {
    input: z.object({ id: z.string(), sinceVersion: z.number() }),
    output: z.object({
      version: z.number(),
      ops: z.array(opRowSchema),
      document: documentSchema.optional(),
    }),
  },
  checkpoint_list: {
    input: z.object({ canvasId: z.string() }),
    output: z.object({ checkpoints: z.array(checkpointSchema) }),
  },
  checkpoint_create: {
    input: z.object({
      canvasId: z.string(),
      name: z.string().trim().min(1).max(120),
    }),
    output: checkpointSchema,
  },
  checkpoint_restore: {
    input: z.object({ checkpointId: z.string() }),
    output: z.object({ version: z.number() }),
  },
  screenshot_submit: {
    input: z.object({
      nonce: z.string(),
      data: z.string().optional(),
      mimeType: z.string().optional(),
      error: z.string().optional(),
    }),
    output: z.object({ accepted: z.boolean() }),
  },
  file_read: {
    input: z.object({ path: z.string(), source: fileSourceSchema }),
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        content: z.string(),
        sha256: z.string(),
        absolutePath: z.string(),
        hostId: z.string().nullable(),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
  },
  file_save: {
    input: z.object({
      absolutePath: z.string(),
      hostId: z.string().nullable(),
      content: z.string(),
      expectedSha256: z.string(),
    }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("saved"), sha256: z.string() }),
      z.object({ outcome: z.literal("conflict") }),
    ]),
  },
});

interface PendingScreenshot {
  resolve: (result: { data: string; mimeType: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    licenseKey: {
      type: "string",
      label: "tldraw SDK license key (required on HTTPS and production hosts)",
      default: "",
    },
  });
  void settings;

  const store: CanvasStore = openCanvasStore(bb);
  const pendingScreenshots = new Map<string, PendingScreenshot>();

  const notifyChange = (
    canvasId: string,
    version: number,
    source: string,
    clientId?: string,
  ) => {
    bb.realtime.publish(CANVAS_CHANGED, {
      canvasId,
      version,
      source,
      ...(clientId === undefined ? {} : { clientId }),
    });
  };
  const notifyList = () => {
    bb.realtime.publish(CANVAS_LIST_CHANGED, {});
  };

  const requireCanvas = (id: string) => {
    const canvas = store.get(id);
    if (canvas === null) throw new Error(`No canvas with id ${id}`);
    return canvas;
  };

  // ------------------------------------------------------------------ rpc --
  bb.rpc.register(rpcContract, {
    canvas_list: ({ projectId }) => ({ canvases: store.list(projectId) }),
    canvas_create: ({ title, projectId, threadId }) => {
      const meta = store.create({
        title,
        projectId: projectId ?? null,
        threadId: threadId ?? null,
        document: createEmptyDocument(),
      });
      notifyList();
      return meta;
    },
    canvas_get: ({ id }) => {
      const canvas = requireCanvas(id);
      return {
        meta: canvas.meta,
        document: canvas.document as unknown as {
          store: Record<string, unknown>;
          schema: unknown;
        },
      };
    },
    canvas_get_or_create_for_thread: async ({ threadId }) => {
      const existing = store.getByThread(threadId);
      if (existing !== null) return existing;
      let title = "Thread canvas";
      let projectId: string | null = null;
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        projectId = thread.projectId ?? null;
        if (typeof thread.title === "string" && thread.title.trim() !== "") {
          title = thread.title.slice(0, 100);
        }
      } catch {
        // Thread lookup is best-effort; an unlabeled canvas still works.
      }
      const meta = store.create({
        title,
        projectId,
        threadId,
        document: createEmptyDocument(),
      });
      notifyList();
      return meta;
    },
    canvas_rename: ({ id, title }) => {
      requireCanvas(id);
      store.rename(id, title);
      notifyList();
      return store.getMeta(id)!;
    },
    canvas_delete: ({ id }) => {
      const exists = store.getMeta(id) !== null;
      if (exists) {
        store.remove(id);
        notifyList();
      }
      return { deleted: exists };
    },
    canvas_save: ({ id, baseVersion, clientId, document, puts, removes }) => {
      requireCanvas(id);
      const hasDelta = puts !== undefined && removes !== undefined;
      const version = store.applyChange(id, {
        document: document as CanvasDocument,
        ...(hasDelta
          ? { puts: puts as DocRecord[], removes }
          : { fullReplace: true }),
        source: "user",
        expectedVersion: baseVersion,
      });
      if (version !== null) {
        // Old app generations did not send a client id. Accept their save,
        // but do not echo it back: without an identity they cannot suppress
        // their own signal and would replay the document over live UI state.
        if (clientId !== undefined) notifyChange(id, version, "user", clientId);
        return { outcome: "saved" as const, version };
      }
      const current = requireCanvas(id);
      const { ops, complete } = store.opsSince(id, baseVersion);
      return {
        outcome: "conflict" as const,
        version: current.meta.version,
        ops: complete ? ops : [],
        ...(complete
          ? {}
          : {
              document: current.document as unknown as {
                store: Record<string, unknown>;
                schema: unknown;
              },
            }),
      };
    },
    canvas_ops: ({ id, sinceVersion }) => {
      const canvas = requireCanvas(id);
      const { ops, complete } = store.opsSince(id, sinceVersion);
      return {
        version: canvas.meta.version,
        ops: complete ? ops : [],
        ...(complete
          ? {}
          : {
              document: canvas.document as unknown as {
                store: Record<string, unknown>;
                schema: unknown;
              },
            }),
      };
    },
    checkpoint_list: ({ canvasId }) => ({
      checkpoints: store.listCheckpoints(canvasId),
    }),
    checkpoint_create: ({ canvasId, name }) => {
      requireCanvas(canvasId);
      const checkpoint = store.createCheckpoint(canvasId, name);
      if (checkpoint === null) throw new Error("Checkpoint failed");
      return checkpoint;
    },
    checkpoint_restore: ({ checkpointId }) => {
      const checkpoint = store.getCheckpointDocument(checkpointId);
      if (checkpoint === null) throw new Error("No such checkpoint");
      const version = store.applyChange(checkpoint.canvasId, {
        document: checkpoint.document,
        fullReplace: true,
        source: "restore",
      });
      if (version === null) throw new Error("Canvas no longer exists");
      notifyChange(checkpoint.canvasId, version, "restore");
      return { version };
    },
    screenshot_submit: ({ nonce, data, mimeType, error }) => {
      const pending = pendingScreenshots.get(nonce);
      if (pending === undefined) return { accepted: false };
      pendingScreenshots.delete(nonce);
      clearTimeout(pending.timer);
      if (data !== undefined && data !== "") {
        pending.resolve({ data, mimeType: mimeType ?? "image/png" });
      } else {
        pending.reject(new Error(error ?? "Screenshot failed"));
      }
      return { accepted: true };
    },
    file_read: async ({ path, source }) => {
      try {
        const resolved = await resolveFile(bb, path, source);
        const file = await bb.sdk.files.read({
          path: resolved.absolutePath,
          ...(resolved.hostId !== null ? { hostId: resolved.hostId } : {}),
        });
        const content =
          file.contentEncoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf8")
            : file.content;
        return {
          ok: true as const,
          content,
          sha256: file.sha256,
          absolutePath: resolved.absolutePath,
          hostId: resolved.hostId,
        };
      } catch (cause) {
        return {
          ok: false as const,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    file_save: async ({ absolutePath, hostId, content, expectedSha256 }) => {
      const result = await bb.sdk.files.write({
        path: absolutePath,
        ...(hostId !== null ? { hostId } : {}),
        content,
        expectedSha256,
      });
      if (result.outcome === "conflict") return { outcome: "conflict" as const };
      return { outcome: "saved" as const, sha256: result.sha256 };
    },
  });

  // -------------------------------------------------------------- helpers --

  async function canvasForTool(
    canvasId: string | undefined,
    ctx: { threadId: string; projectId: string },
  ): Promise<CanvasMeta> {
    if (canvasId !== undefined) {
      const meta = store.getMeta(canvasId);
      if (meta === null) {
        throw new Error(
          `No canvas with id ${canvasId}. Use canvas_list to see canvases, or omit canvasId to use this thread's canvas.`,
        );
      }
      return meta;
    }
    const existing = store.getByThread(ctx.threadId);
    if (existing !== null) return existing;
    let title = "Thread canvas";
    try {
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (typeof thread.title === "string" && thread.title.trim() !== "") {
        title = thread.title.slice(0, 100);
      }
    } catch {
      // best-effort naming
    }
    const meta = store.create({
      title,
      projectId: ctx.projectId,
      threadId: ctx.threadId,
      document: createEmptyDocument(),
    });
    notifyList();
    return meta;
  }

  function requestScreenshot(
    canvasId: string,
  ): Promise<{ data: string; mimeType: string }> {
    const nonce = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingScreenshots.delete(nonce);
        reject(
          new Error(
            "No open canvas view answered within 15s. Ask the user to open the canvas (Canvas panel in the sidebar, or the thread's Canvas tab), then retry — or continue with canvas_read instead.",
          ),
        );
      }, 15_000);
      pendingScreenshots.set(nonce, { resolve, reject, timer });
      bb.realtime.publish(SCREENSHOT_REQUEST, { canvasId, nonce });
    });
  }

  const toolError = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });

  // ---------------------------------------------------------- agent tools --

  bb.agents.registerTool({
    name: "canvas_list",
    description:
      "List mockup/wireframe canvases (id, title, linked thread) available in this project, most recently updated first.",
    presentation: {
      label: { pending: "Listing canvases", completed: "Listed canvases" },
    },
    parameters: z.object({}),
    execute(_params, ctx) {
      const canvases = store
        .list()
        .filter(
          (canvas) =>
            canvas.projectId === ctx.projectId ||
            canvas.threadId === ctx.threadId,
        );
      if (canvases.length === 0) {
        return "No canvases yet. canvas_edit with no canvasId creates this thread's canvas automatically, or use canvas_create.";
      }
      return canvases
        .map(
          (canvas) =>
            `${canvas.id}  "${canvas.title}"  v${canvas.version}${
              canvas.threadId === ctx.threadId ? "  (this thread)" : ""
            }  updated ${canvas.updatedAt}`,
        )
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "canvas_create",
    description:
      "Create a new, empty canvas in this project. Returns its id. If this thread has no linked canvas yet, the new canvas is linked to the thread so later canvas_* calls can omit canvasId.",
    presentation: {
      label: { pending: "Creating canvas", completed: "Created canvas" },
    },
    parameters: z.object({
      title: z.string().trim().min(1).max(120),
    }),
    execute({ title }, ctx) {
      const linkToThread = store.getByThread(ctx.threadId) === null;
      const meta = store.create({
        title,
        projectId: ctx.projectId,
        threadId: linkToThread ? ctx.threadId : null,
        document: createEmptyDocument(),
      });
      notifyList();
      return `Created canvas ${meta.id} ("${title}")${linkToThread ? ", linked to this thread" : ""}. The user can open it from the Canvas panel in the sidebar or the thread's Canvas tab.`;
    },
  });

  bb.agents.registerTool({
    name: "canvas_read",
    description:
      "Read a canvas as simplified JSON: pages and shapes with id, type, x/y/w/h, text, parent frame, and arrow from/to links. Coordinates of shapes inside a frame are relative to that frame. Omit canvasId to use this thread's canvas.",
    presentation: {
      label: { pending: "Reading canvas", completed: "Read canvas" },
    },
    parameters: z.object({
      canvasId: z.string().optional(),
    }),
    async execute({ canvasId }, ctx) {
      try {
        const meta = await canvasForTool(canvasId, ctx);
        const canvas = store.get(meta.id)!;
        const simplified = simplifyDocument(canvas.document);
        return `Canvas ${meta.id} "${meta.title}" (version ${meta.version}):\n${JSON.stringify(simplified, null, 1)}`;
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "canvas_edit",
    description: [
      "Apply a batch of operations to a canvas (omit canvasId to use this thread's canvas; it is created if missing). The user sees changes live.",
      'Operations: create_shape {op, id?, shape: rectangle|ellipse|triangle|diamond|hexagon|oval|cloud|star|x-box|check-box|text|note|frame, x, y, w?, h?, text?, color?, fill?, parentId?, align?} — parentId puts the shape inside a frame, with x/y relative to that frame;',
      "update_shape {op, id, x?, y?, w?, h?, text?, color?, fill?, parentId?};",
      "delete_shapes {op, ids};",
      "create_arrow {op, id?, fromId?/fromPoint?, toId?/toPoint?, text?, color?} — bound arrows follow their shapes;",
      "create_page {op, name}. Optional top-level page selects which page ops apply to (name or id; defaults to the first page).",
      "Ids are yours to choose (e.g. 'hero', 'cta'); reuse them in later updates. Colors: black grey blue light-blue violet light-violet red light-red green light-green yellow orange. Fill: none|semi|solid|pattern.",
    ].join(" "),
    presentation: {
      label: { pending: "Drawing on canvas", completed: "Drew on canvas" },
    },
    parameters: z.object({
      canvasId: z.string().optional(),
      page: z.string().optional(),
      operations: z.array(operationSchema).min(1).max(100),
    }),
    async execute({ canvasId, page, operations }, ctx) {
      try {
        const meta = await canvasForTool(canvasId, ctx);
        const canvas = store.get(meta.id)!;
        const result = applyOperations(canvas.document, operations, page);
        const version = store.applyChange(meta.id, {
          document: result.document,
          puts: result.puts,
          removes: result.removes,
          source: "agent",
        });
        if (version === null) throw new Error("Canvas was deleted");
        notifyChange(meta.id, version, "agent");
        return `Canvas ${meta.id} v${version}: ${result.summary.join("; ")}. Use canvas_screenshot to see the result.`;
      } catch (cause) {
        if (cause instanceof CanvasOpError) return toolError(cause.message);
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "canvas_screenshot",
    description:
      "Render a PNG screenshot of a canvas so you can SEE it — including the user's freehand annotations, which canvas_read cannot show. Requires the user to have the canvas open in a BB window. Omit canvasId to use this thread's canvas.",
    presentation: {
      label: {
        pending: "Photographing canvas",
        completed: "Photographed canvas",
      },
    },
    parameters: z.object({
      canvasId: z.string().optional(),
    }),
    async execute({ canvasId }, ctx) {
      try {
        const meta = await canvasForTool(canvasId, ctx);
        const { data, mimeType } = await requestScreenshot(meta.id);
        return {
          content: [
            { type: "image" as const, data, mimeType },
            {
              type: "text" as const,
              text: `Screenshot of canvas ${meta.id} "${meta.title}" (current page of the open view).`,
            },
          ],
        };
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  bb.agents.registerTool({
    name: "canvas_checkpoint",
    description:
      "Save a named checkpoint (version snapshot) of a canvas — e.g. 'v0 concept' before reworking it. The user can restore checkpoints from the canvas view. Omit canvasId to use this thread's canvas.",
    presentation: {
      label: { pending: "Saving checkpoint", completed: "Saved checkpoint" },
    },
    parameters: z.object({
      canvasId: z.string().optional(),
      name: z.string().trim().min(1).max(120),
    }),
    async execute({ canvasId, name }, ctx) {
      try {
        const meta = await canvasForTool(canvasId, ctx);
        const checkpoint = store.createCheckpoint(meta.id, name);
        if (checkpoint === null) throw new Error("Checkpoint failed");
        return `Saved checkpoint "${name}" (${checkpoint.id}) of canvas ${meta.id} at v${checkpoint.version}.`;
      } catch (cause) {
        return toolError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  // ---------------------------------------------------------- @canvas -----

  bb.ui.registerMentionProvider({
    id: "canvas",
    label: "Canvases",
    search({ query }) {
      const needle = query.trim().toLowerCase();
      return store
        .list()
        .filter(
          (canvas) =>
            needle === "" || canvas.title.toLowerCase().includes(needle),
        )
        .slice(0, 20)
        .map((canvas) => ({
          id: canvas.id,
          title: canvas.title,
          subtitle: `Canvas · v${canvas.version}`,
        }));
    },
    resolve(itemId) {
      const canvas = store.get(itemId);
      if (canvas === null) throw new Error(`Canvas ${itemId} no longer exists`);
      const simplified = simplifyDocument(canvas.document);
      return {
        context: [
          `# Canvas "${canvas.meta.title}" (id ${canvas.meta.id}, version ${canvas.meta.version})`,
          "Simplified shape listing (use the canvas_read / canvas_edit / canvas_screenshot tools with this canvasId to work with it):",
          JSON.stringify(simplified, null, 1),
        ].join("\n"),
      };
    },
  });

  bb.onDispose(() => {
    for (const pending of pendingScreenshots.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Plugin reloading"));
    }
    pendingScreenshots.clear();
  });
}

async function resolveFile(
  bb: BbPluginApi,
  path: string,
  source: {
    kind: "workspace" | "host" | "thread-storage";
    environmentId?: string | null;
    hostId?: string | null;
    threadId?: string | null;
  },
): Promise<{ absolutePath: string; hostId: string | null }> {
  if (source.kind === "host") {
    return { absolutePath: path, hostId: source.hostId ?? null };
  }
  if (source.kind === "workspace") {
    if (source.environmentId == null) {
      throw new Error("Workspace file has no environment id");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: source.environmentId,
    });
    if (environment.path == null) {
      throw new Error("Environment has no workspace path");
    }
    const root = environment.path.replace(/\/+$/, "");
    return {
      absolutePath: `${root}/${path.replace(/^\/+/, "")}`,
      hostId: environment.hostId,
    };
  }
  throw new Error("Thread-storage .tldr files are not supported yet");
}
