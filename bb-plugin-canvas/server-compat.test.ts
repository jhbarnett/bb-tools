import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

describe("canvas_save rolling compatibility", () => {
  it("accepts a legacy app payload without echoing it back to itself", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "canvas",
      sdk: {
        threads: {
          get: async () => ({ title: "Legacy canvas", projectId: "p1" }),
        },
      },
    });
    await plugin(bb);

    const meta = (await harness.behavior.callRpc("canvas_create", {
      title: "Legacy canvas",
      projectId: "p1",
    })) as { id: string; version: number };
    const current = (await harness.behavior.callRpc("canvas_get", {
      id: meta.id,
    })) as { document: unknown };

    const saved = await harness.behavior.callRpc("canvas_save", {
      id: meta.id,
      baseVersion: 1,
      document: current.document,
    });
    expect(saved).toMatchObject({ outcome: "saved", version: 2 });

    const userSignals = harness.inspection.realtimeSignals.filter(
      (signal) =>
        signal.channel === "canvas-changed" &&
        (signal.payload as { source?: string }).source === "user",
    );
    expect(userSignals).toHaveLength(0);

    const ops = (await harness.behavior.callRpc("canvas_ops", {
      id: meta.id,
      sinceVersion: 1,
    })) as { ops: { fullReplace: boolean }[] };
    expect(ops.ops).toEqual([expect.objectContaining({ fullReplace: true })]);
  });
});
