import { describe, expect, it } from "vitest";
import {
  createPendingChanges,
  hasPendingChanges,
  mergeDelta,
  mergeRecordDiff,
  shouldApplyCanvasSignal,
  takePendingChanges,
} from "./canvas-sync";

type TestRecord = { id: string; value: number };

describe("canvas sync", () => {
  it("coalesces user record history to the latest puts and removes", () => {
    const pending = createPendingChanges<TestRecord>();
    mergeRecordDiff(pending, {
      added: { a: { id: "a", value: 1 } },
      updated: {},
      removed: {},
    });
    mergeRecordDiff(pending, {
      added: {},
      updated: { a: [{ id: "a", value: 1 }, { id: "a", value: 2 }] },
      removed: { b: { id: "b", value: 1 } },
    });

    expect(takePendingChanges(pending)).toEqual({
      puts: [{ id: "a", value: 2 }],
      removes: ["b"],
    });
    expect(hasPendingChanges(pending)).toBe(false);
  });

  it("preserves chronological intent when changes are restored after a conflict", () => {
    const pending = createPendingChanges<TestRecord>();

    mergeDelta(pending, {
      puts: [{ id: "shape", value: 1 }],
      removes: [],
    });
    mergeDelta(pending, { puts: [], removes: ["shape"] });
    expect(takePendingChanges(pending)).toEqual({
      puts: [],
      removes: ["shape"],
    });

    mergeDelta(pending, { puts: [], removes: ["shape"] });
    mergeDelta(pending, {
      puts: [{ id: "shape", value: 2 }],
      removes: [],
    });
    expect(takePendingChanges(pending)).toEqual({
      puts: [{ id: "shape", value: 2 }],
      removes: [],
    });
  });

  it("ignores self echoes, stale versions, and signals for other canvases", () => {
    const current = {
      canvasId: "canvas-a",
      version: 4,
      clientId: "client-a",
    };

    expect(
      shouldApplyCanvasSignal(
        {
          canvasId: "canvas-a",
          version: 5,
          source: "user",
          clientId: "client-a",
        },
        current,
      ),
    ).toBe(false);
    expect(
      shouldApplyCanvasSignal(
        { canvasId: "canvas-a", version: 4, source: "agent" },
        current,
      ),
    ).toBe(false);
    expect(
      shouldApplyCanvasSignal(
        { canvasId: "canvas-b", version: 5, source: "agent" },
        current,
      ),
    ).toBe(false);
    expect(
      shouldApplyCanvasSignal(
        {
          canvasId: "canvas-a",
          version: 5,
          source: "user",
          clientId: "client-b",
        },
        current,
      ),
    ).toBe(true);
  });
});
