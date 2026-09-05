import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "./server";
import { applyOperations, createEmptyDocument, simplifyDocument } from "./doc";

async function loadPlugin() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "canvas",
    sdk: {
      threads: {
        get: async () => ({ title: "Design the login flow", projectId: "p1" }),
      },
    },
  });
  await plugin(bb);
  return harness;
}

const toolCtx = { threadId: "th_1", projectId: "p1" };

function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  const parts = (result as { content: { type: string; text?: string }[] })
    .content;
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

describe("doc engine", () => {
  it("creates an empty document with one page", () => {
    const document = createEmptyDocument();
    const simplified = simplifyDocument(document);
    expect(simplified.pages).toHaveLength(1);
    expect(simplified.pages[0]!.shapes).toHaveLength(0);
  });

  it("applies create/update/arrow/delete operations", () => {
    let document = createEmptyDocument();
    const first = applyOperations(document, [
      {
        op: "create_shape",
        id: "login",
        shape: "frame",
        x: 0,
        y: 0,
        w: 390,
        h: 760,
        text: "Login",
      },
      {
        op: "create_shape",
        id: "cta",
        shape: "rectangle",
        x: 40,
        y: 600,
        w: 310,
        h: 56,
        text: "Sign in",
        fill: "semi",
        parentId: "login",
      },
      {
        op: "create_shape",
        id: "home",
        shape: "frame",
        x: 520,
        y: 0,
        w: 390,
        h: 760,
        text: "Home",
      },
      { op: "create_arrow", fromId: "login", toId: "home", text: "signs in" },
    ]);
    document = first.document;
    expect(first.puts.length).toBeGreaterThanOrEqual(6); // 3 shapes + arrow + 2 bindings

    const simplified = simplifyDocument(document);
    const shapes = simplified.pages[0]!.shapes;
    const cta = shapes.find((shape) => shape.id === "cta")!;
    expect(cta.parent).toBe("login");
    expect(cta.text).toBe("Sign in");
    expect(cta.fill).toBe("semi");
    const arrow = shapes.find((shape) => shape.type === "arrow")!;
    expect(arrow.from).toBe("login");
    expect(arrow.to).toBe("home");

    const updated = applyOperations(document, [
      { op: "update_shape", id: "cta", text: "Log in", color: "blue" },
    ]);
    const cta2 = simplifyDocument(updated.document)
      .pages[0]!.shapes.find((shape) => shape.id === "cta")!;
    expect(cta2.text).toBe("Log in");
    expect(cta2.color).toBe("blue");

    const deleted = applyOperations(updated.document, [
      { op: "delete_shapes", ids: ["login"] },
    ]);
    const remaining = simplifyDocument(deleted.document).pages[0]!.shapes;
    // Frame cascade: the frame and its child are gone; bindings referencing
    // the frame are gone; the arrow and "home" frame survive.
    expect(remaining.find((shape) => shape.id === "login")).toBeUndefined();
    expect(remaining.find((shape) => shape.id === "cta")).toBeUndefined();
    expect(remaining.find((shape) => shape.id === "home")).toBeDefined();
  });

  it("rejects bad operations with a helpful error", () => {
    const document = createEmptyDocument();
    expect(() =>
      applyOperations(document, [
        { op: "update_shape", id: "missing", x: 1 },
      ]),
    ).toThrowError(/No shape "missing"/);
  });

  it("supports pages", () => {
    const withPage = applyOperations(createEmptyDocument(), [
      { op: "create_page", name: "Checkout" },
    ]);
    const target = applyOperations(
      withPage.document,
      [{ op: "create_shape", shape: "rectangle", x: 0, y: 0 }],
      "Checkout",
    );
    const simplified = simplifyDocument(target.document);
    expect(simplified.pages).toHaveLength(2);
    expect(simplified.pages[1]!.name).toBe("Checkout");
    expect(simplified.pages[1]!.shapes).toHaveLength(1);
    expect(simplified.pages[0]!.shapes).toHaveLength(0);
  });
});

describe("agent tools", () => {
  it("canvas_edit auto-creates a thread canvas and canvas_read shows it", async () => {
    const harness = await loadPlugin();
    const edited = await harness.behavior.callAgentTool(
      "canvas_edit",
      {
        operations: [
          {
            op: "create_shape",
            id: "hero",
            shape: "rectangle",
            x: 0,
            y: 0,
            w: 200,
            h: 100,
            text: "Hero",
          },
        ],
      },
      toolCtx,
    );
    expect(textOf(edited)).toContain('created rectangle "hero"');

    const read = await harness.behavior.callAgentTool("canvas_read", {}, toolCtx);
    const readText = textOf(read);
    expect(readText).toContain("Design the login flow");
    expect(readText).toContain('"hero"');

    const listed = await harness.behavior.callAgentTool("canvas_list", {}, toolCtx);
    expect(textOf(listed)).toContain("(this thread)");
  });

  it("agent edits publish realtime signals and bump versions", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callAgentTool(
      "canvas_edit",
      { operations: [{ op: "create_shape", shape: "note", x: 0, y: 0, text: "hi" }] },
      toolCtx,
    );
    const signals = harness.inspection.realtimeSignals.filter(
      (signal) => signal.channel === "canvas-changed",
    );
    expect(signals).toHaveLength(1);
    expect((signals[0]!.payload as { source: string }).source).toBe("agent");
    expect((signals[0]!.payload as { version: number }).version).toBe(2);
  });

  it("returns a tool error for invalid ops without corrupting the canvas", async () => {
    const harness = await loadPlugin();
    const result = await harness.behavior.callAgentTool(
      "canvas_edit",
      { operations: [{ op: "create_arrow" }] },
      toolCtx,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    const read = await harness.behavior.callAgentTool("canvas_read", {}, toolCtx);
    expect(textOf(read)).toContain("version 1");
  });

  it("canvas_screenshot round-trips through screenshot_submit", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callAgentTool(
      "canvas_edit",
      { operations: [{ op: "create_shape", shape: "rectangle", x: 0, y: 0 }] },
      toolCtx,
    );
    const pending = harness.behavior.callAgentTool(
      "canvas_screenshot",
      {},
      toolCtx,
    );
    // Wait for the realtime request, then answer like an open editor would.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const request = harness.inspection.realtimeSignals.find(
      (signal) => signal.channel === "canvas-screenshot-request",
    );
    expect(request).toBeDefined();
    const nonce = (request!.payload as { nonce: string }).nonce;
    const submit = await harness.behavior.callRpc("screenshot_submit", {
      nonce,
      data: "aGVsbG8=",
      mimeType: "image/png",
    });
    expect(submit).toEqual({ accepted: true });
    const result = (await pending) as {
      content: { type: string; data?: string }[];
    };
    expect(result.content[0]!.type).toBe("image");
    expect(result.content[0]!.data).toBe("aGVsbG8=");
  });

  it("canvas_checkpoint saves and rpc restore rolls back", async () => {
    const harness = await loadPlugin();
    await harness.behavior.callAgentTool(
      "canvas_edit",
      { operations: [{ op: "create_shape", id: "v0", shape: "rectangle", x: 0, y: 0 }] },
      toolCtx,
    );
    const checkpointed = await harness.behavior.callAgentTool(
      "canvas_checkpoint",
      { name: "v0" },
      toolCtx,
    );
    expect(textOf(checkpointed)).toContain('Saved checkpoint "v0"');

    await harness.behavior.callAgentTool(
      "canvas_edit",
      { operations: [{ op: "delete_shapes", ids: ["v0"] }] },
      toolCtx,
    );
    let read = textOf(
      await harness.behavior.callAgentTool("canvas_read", {}, toolCtx),
    );
    expect(read).not.toContain('"v0"');

    const listed = (await harness.behavior.callRpc("canvas_list", {})) as {
      canvases: { id: string }[];
    };
    const canvasId = listed.canvases[0]!.id;
    const checkpoints = (await harness.behavior.callRpc("checkpoint_list", {
      canvasId,
    })) as { checkpoints: { id: string }[] };
    await harness.behavior.callRpc("checkpoint_restore", {
      checkpointId: checkpoints.checkpoints[0]!.id,
    });
    read = textOf(
      await harness.behavior.callAgentTool("canvas_read", {}, toolCtx),
    );
    expect(read).toContain('"v0"');
  });
});

describe("rpc save/sync", () => {
  it("CAS-saves and reports conflicts with mergeable ops", async () => {
    const harness = await loadPlugin();
    const meta = (await harness.behavior.callRpc("canvas_create", {
      title: "Board",
      projectId: "p1",
    })) as { id: string; version: number };

    // Agent writes v2.
    await harness.behavior.callAgentTool(
      "canvas_edit",
      {
        canvasId: meta.id,
        operations: [{ op: "create_shape", id: "a", shape: "rectangle", x: 0, y: 0 }],
      },
      toolCtx,
    );

    // A client saving from v1 conflicts and receives the agent's op.
    const current = (await harness.behavior.callRpc("canvas_get", {
      id: meta.id,
    })) as { meta: { version: number }; document: unknown };
    expect(current.meta.version).toBe(2);
    const savedRecords = Object.values(
      (current.document as { store: Record<string, unknown> }).store,
    );

    const conflict = (await harness.behavior.callRpc("canvas_save", {
      id: meta.id,
      baseVersion: 1,
      clientId: "client-a",
      document: current.document,
      puts: savedRecords,
      removes: [],
    })) as { outcome: string; version: number; ops: { puts: unknown[] | null }[] };
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.version).toBe(2);
    expect(conflict.ops).toHaveLength(1);
    expect(conflict.ops[0]!.puts).not.toBeNull();

    // Retrying from the current version succeeds.
    const saved = (await harness.behavior.callRpc("canvas_save", {
      id: meta.id,
      baseVersion: 2,
      clientId: "client-a",
      document: current.document,
      puts: savedRecords,
      removes: [],
    })) as { outcome: string; version: number };
    expect(saved).toMatchObject({ outcome: "saved", version: 3 });
    const userSignal = harness.inspection.realtimeSignals.find(
      (signal) =>
        signal.channel === "canvas-changed" &&
        (signal.payload as { source?: string }).source === "user",
    );
    expect(userSignal?.payload).toMatchObject({ clientId: "client-a" });


    // User saves stay mergeable record deltas for every other open editor.
    const ops = (await harness.behavior.callRpc("canvas_ops", {
      id: meta.id,
      sinceVersion: 2,
    })) as { ops: { fullReplace: boolean }[]; version: number };
    expect(ops.version).toBe(3);
    expect(ops.ops[0]!.fullReplace).toBe(false);
  });

  it("mention provider resolves canvas context", async () => {
    const harness = await loadPlugin();
    const meta = (await harness.behavior.callRpc("canvas_create", {
      title: "Signup flow",
      projectId: "p1",
    })) as { id: string };
    const providers = harness.inspection.registrations.mentionProviders as {
      id: string;
      search: (ctx: unknown) => unknown;
      resolve: (id: string) => { context: string } | Promise<{ context: string }>;
    }[];
    const provider = providers.find((candidate) => candidate.id === "canvas")!;
    const resolved = await provider.resolve(meta.id);
    expect(resolved.context).toContain("Signup flow");
    expect(resolved.context).toContain(meta.id);
  });
});

// Type-only sanity: the contract exports stay importable by the app bundle.
void ((): typeof rpcContract | null => null);
type _FakeHost = FakePluginHost;
