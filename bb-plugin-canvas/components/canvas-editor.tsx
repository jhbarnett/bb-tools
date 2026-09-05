// The live tldraw editor bound to one stored canvas: loads the snapshot,
// autosaves user edits with a version CAS, merges agent/server changes in via
// mergeRemoteChanges, and answers screenshot requests from agent tools.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Tldraw,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  getSnapshot,
  loadSnapshot,
  type Editor,
  type TLStore,
} from "tldraw";
import { toast } from "sonner";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { resolveTldrawLicenseKey } from "../tldraw-license";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createPendingChanges,
  hasPendingChanges,
  mergeDelta,
  mergeRecordDiff,
  shouldApplyCanvasSignal,
  takePendingChanges,
  type CanvasChangedSignal,
  type RecordLike,
  type SerializedDelta,
} from "../canvas-sync";
import { TldrawLicenseRequired } from "./tldraw-license-required";
import { TldrawLicenseBoundary } from "./tldraw-license-boundary";


type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type CanvasDoc = { store: Record<string, unknown>; schema: unknown };
type OpRow = {
  version: number;
  puts: unknown[] | null;
  removes: string[] | null;
  fullReplace: boolean;
  source: string;
};

const DOCUMENT_TYPES = new Set(["document", "page", "shape", "binding", "asset"]);

function replaceDocument(store: TLStore, document: CanvasDoc): void {
  const incoming = document.store as Record<
    string,
    { id: string; typeName: string }
  >;
  store.mergeRemoteChanges(() => {
    const stale = store
      .allRecords()
      .filter(
        (record) =>
          DOCUMENT_TYPES.has(record.typeName) &&
          incoming[record.id] === undefined,
      )
      .map((record) => record.id);
    if (stale.length > 0) store.remove(stale as never[]);
    store.put(Object.values(incoming) as never[]);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to encode screenshot"));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function CheckpointsDialog({
  canvasId,
  rpc,
  open,
  onOpenChange,
}: {
  canvasId: string;
  rpc: Rpc;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [checkpoints, setCheckpoints] = useState<
    { id: string; name: string; version: number; createdAt: string }[] | null
  >(null);
  const [name, setName] = useState("");
  const refetch = useCallback(() => {
    rpc
      .call("checkpoint_list", { canvasId })
      .then((result) => setCheckpoints(result.checkpoints))
      .catch(() => setCheckpoints([]));
  }, [rpc, canvasId]);
  useEffect(() => {
    if (open) refetch();
  }, [open, refetch]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Checkpoints</DialogTitle>
        </DialogHeader>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (trimmed === "") return;
            rpc
              .call("checkpoint_create", { canvasId, name: trimmed })
              .then(() => {
                setName("");
                refetch();
                toast.success(`Checkpoint "${trimmed}" saved`);
              })
              .catch((cause) => toast.error(String(cause)));
          }}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Checkpoint name (e.g. v1 concept)"
            aria-label="Checkpoint name"
          />
          <Button type="submit" disabled={name.trim() === ""}>
            Save
          </Button>
        </form>
        <div className="mt-1 max-h-64 space-y-1 overflow-y-auto">
          {checkpoints === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : checkpoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No checkpoints yet. Save one before big changes.
            </p>
          ) : (
            checkpoints.map((checkpoint) => (
              <div
                key={checkpoint.id}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  {checkpoint.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    v{checkpoint.version} ·{" "}
                    {new Date(checkpoint.createdAt).toLocaleString()}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    rpc
                      .call("checkpoint_restore", {
                        checkpointId: checkpoint.id,
                      })
                      .then(() => {
                        toast.success(`Restored "${checkpoint.name}"`);
                        onOpenChange(false);
                      })
                      .catch((cause) => toast.error(String(cause)));
                  }}
                >
                  Restore
                </Button>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CanvasEditor({
  canvasId,
  onBack,
}: {
  canvasId: string;
  onBack?: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { values, isLoading: settingsLoading } = useSettings();
  const realtimeState = useRealtimeConnectionState();
  const licenseKey = resolveTldrawLicenseKey(values?.licenseKey);

  const [loaded, setLoaded] = useState<{
    title: string;
    store: TLStore;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentPulse, setAgentPulse] = useState(false);
  const [checkpointsOpen, setCheckpointsOpen] = useState(false);

  const storeRef = useRef<TLStore | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const clientIdRef = useRef(`draw-${crypto.randomUUID()}`);
  const versionRef = useRef(0);
  const pendingRef = useRef(createPendingChanges<RecordLike>());
  const savingRef = useRef(false);
  const syncingRef = useRef(false);
  const syncAgainRef = useRef(false);
  const unlistenRef = useRef<(() => void) | null>(null);
  const previousRealtimeStateRef = useRef(realtimeState);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ------------------------------------------------------------- loading --
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setLoadError(null);
    rpc
      .call("canvas_get", { id: canvasId })
      .then(({ meta, document }) => {
        if (cancelled) return;
        const store = createTLStore({
          shapeUtils: defaultShapeUtils,
          bindingUtils: defaultBindingUtils,
        });
        loadSnapshot(store, { document: document as never });
        versionRef.current = meta.version;
        storeRef.current = store;
        setLoaded({ title: meta.title, store });
      })
      .catch((cause) => {
        if (!cancelled) setLoadError(String(cause));
      });
    return () => {
      cancelled = true;
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      // Flush any pending edits before tearing down (getSnapshot runs
      // synchronously inside flush, before the store ref is cleared).
      if (hasPendingChanges(pendingRef.current)) flushRef.current();
      unlistenRef.current?.();
      unlistenRef.current = null;
      storeRef.current = null;
      editorRef.current = null;
    };
  }, [rpc, canvasId]);

  const flushRef = useRef<() => void>(() => {});

  // -------------------------------------------------------------- saving --
  const applyRemote = useCallback(
    async (result: {
      version: number;
      ops: OpRow[];
      document?: CanvasDoc;
    }): Promise<void> => {
      const store = storeRef.current;
      if (store === null) return;
      if (result.document !== undefined) {
        replaceDocument(store, result.document);
      } else if (result.ops.some((op) => op.fullReplace && op.puts === null)) {
        const fresh = await rpc.call("canvas_get", { id: canvasId });
        replaceDocument(store, fresh.document as CanvasDoc);
        versionRef.current = fresh.meta.version;
        return;
      } else {
        store.mergeRemoteChanges(() => {
          for (const op of result.ops) {
            if (op.removes !== null && op.removes.length > 0) {
              store.remove(op.removes as never[]);
            }
            if (op.puts !== null && op.puts.length > 0) {
              store.put(op.puts as never[]);
            }
          }
        });
      }
      versionRef.current = result.version;
    },
    [rpc, canvasId],
  );

  const restorePending = useCallback(
    (
      batch: SerializedDelta<RecordLike>,
    ): SerializedDelta<RecordLike> => {
      const newer = takePendingChanges(pendingRef.current);
      mergeDelta(pendingRef.current, batch);
      mergeDelta(pendingRef.current, newer);
      return newer;
    },
    [],
  );

  const flushSave = useCallback(async (): Promise<void> => {
    const store = storeRef.current;
    if (
      store === null ||
      savingRef.current ||
      !hasPendingChanges(pendingRef.current)
    ) {
      return;
    }
    savingRef.current = true;
    const batch = takePendingChanges(pendingRef.current);
    try {
      const { document } = getSnapshot(store);
      const result = await rpc.call("canvas_save", {
        id: canvasId,
        baseVersion: versionRef.current,
        clientId: clientIdRef.current,
        document: document as unknown as CanvasDoc,
        puts: batch.puts,
        removes: batch.removes,
      });
      if (result.outcome === "saved") {
        versionRef.current = result.version;
      } else {
        // Someone (an agent, another window) wrote first: merge their changes
        // into the live store, then save again on top of them.
        await applyRemote(result);
        const newer = restorePending(batch);
        store.mergeRemoteChanges(() => {
          if (batch.removes.length > 0) store.remove(batch.removes as never[]);
          if (batch.puts.length > 0) store.put(batch.puts as never[]);
          if (newer.removes.length > 0) store.remove(newer.removes as never[]);
          if (newer.puts.length > 0) store.put(newer.puts as never[]);
        });
      }
    } catch (cause) {
      restorePending(batch);
      toast.error(`Canvas save failed: ${String(cause)}`);
    } finally {
      savingRef.current = false;
      if (hasPendingChanges(pendingRef.current)) scheduleSaveRef.current();
    }
  }, [rpc, canvasId, applyRemote, restorePending]);

  flushRef.current = () => void flushSave();

  const scheduleSaveRef = useRef<() => void>(() => {});
  scheduleSaveRef.current = () => {
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, 800);
  };

  // ------------------------------------------------------------- realtime --
  const syncFromServer = useCallback(async (): Promise<void> => {
    if (syncingRef.current) {
      syncAgainRef.current = true;
      return;
    }
    syncingRef.current = true;
    try {
      do {
        syncAgainRef.current = false;
        const result = await rpc.call("canvas_ops", {
          id: canvasId,
          sinceVersion: versionRef.current,
        });
        if (result.version > versionRef.current) {
          await applyRemote(result as never);
        }
      } while (syncAgainRef.current);
    } catch {
      // A later signal (or reload) will retry.
    } finally {
      syncingRef.current = false;
    }
  }, [rpc, canvasId, applyRemote]);

  useEffect(() => {
    const previous = previousRealtimeStateRef.current;
    previousRealtimeStateRef.current = realtimeState;
    if (previous === "reconnecting" && realtimeState === "connected") {
      void syncFromServer();
    }
  }, [realtimeState, syncFromServer]);

  useRealtime("canvas-changed", (payload) => {
    const signal = payload as CanvasChangedSignal;
    if (
      !shouldApplyCanvasSignal(signal, {
        canvasId,
        version: versionRef.current,
        clientId: clientIdRef.current,
      })
    ) {
      return;
    }
    if (signal.source === "agent") {
      setAgentPulse(true);
      if (pulseTimerRef.current !== null) clearTimeout(pulseTimerRef.current);
      pulseTimerRef.current = setTimeout(() => setAgentPulse(false), 4000);
    }
    void syncFromServer();
  });

  useRealtime("canvas-screenshot-request", (payload) => {
    const request = payload as { canvasId: string; nonce: string };
    if (request.canvasId !== canvasId) return;
    const editor = editorRef.current;
    if (editor === null) return;
    void (async () => {
      try {
        const ids = [...editor.getCurrentPageShapeIds()];
        if (ids.length === 0) {
          await rpc.call("screenshot_submit", {
            nonce: request.nonce,
            error: "The canvas is empty — nothing to screenshot yet.",
          });
          return;
        }
        const bounds = editor.getCurrentPageBounds();
        const longest = Math.max(bounds?.w ?? 1000, bounds?.h ?? 1000);
        const scale = Math.min(1.5, Math.max(0.2, 2000 / longest));
        const { blob } = await editor.toImage(ids, {
          format: "png",
          background: true,
          padding: 24,
          scale,
        });
        const data = await blobToBase64(blob);
        await rpc.call("screenshot_submit", {
          nonce: request.nonce,
          data,
          mimeType: "image/png",
        });
      } catch (cause) {
        void rpc
          .call("screenshot_submit", {
            nonce: request.nonce,
            error: `Screenshot failed: ${String(cause)}`,
          })
          .catch(() => {});
      }
    })();
  });

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor;
    editor.user.updateUserPreferences({ colorScheme: "system" });
    unlistenRef.current?.();
    unlistenRef.current = editor.store.listen((entry) => {
      mergeRecordDiff(pendingRef.current, entry.changes as never);
      scheduleSaveRef.current();
    }, {
      scope: "document",
      source: "user",
    });
  }, []);

  const editorArea = useMemo(() => {
    if (loadError !== null) {
      return (
        <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
          {loadError}
        </div>
      );
    }
    if (settingsLoading) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading canvas…
        </div>
      );
    }
    if (licenseKey === undefined) {
      return <TldrawLicenseRequired />;
    }

    if (loaded === null) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading canvas…
        </div>
      );
    }
    return (
      <TldrawLicenseBoundary>
        <Tldraw
          store={loaded.store}
          licenseKey={licenseKey}
          onMount={handleMount}
        />
      </TldrawLicenseBoundary>
    );
  }, [loaded, loadError, settingsLoading, licenseKey, handleMount]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        {onBack !== undefined ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Back to canvases"
            onClick={onBack}
          >
            <Icon name="ChevronLeft" className="size-4" />
          </Button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {loaded?.title ?? "Canvas"}
        </span>
        {agentPulse ? (
          <span className="flex items-center gap-1.5 rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground">
            <Icon name="Bot" className="size-3.5" />
            Agent drew on the canvas
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => setCheckpointsOpen(true)}
        >
          <Icon name="Clock" className="size-3.5" />
          Checkpoints
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">{editorArea}</div>
      <CheckpointsDialog
        canvasId={canvasId}
        rpc={rpc}
        open={checkpointsOpen}
        onOpenChange={setCheckpointsOpen}
      />
    </div>
  );
}
