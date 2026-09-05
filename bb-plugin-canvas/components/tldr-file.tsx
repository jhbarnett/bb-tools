// File opener for .tldr files: renders the file on a live tldraw canvas and
// autosaves edits back with a sha CAS. Unparseable files fall back to BB's
// built-in preview.
import { useEffect, useRef, useState, type ComponentType } from "react";
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
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerSource } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { resolveTldrawLicenseKey } from "../tldraw-license";
import { TldrawLicenseRequired } from "./tldraw-license-required";
import { TldrawLicenseBoundary } from "./tldraw-license-boundary";

type FileFormat =
  | { kind: "tldr"; fileFormatVersion: unknown }
  | { kind: "snapshot" };

interface ReadyState {
  store: TLStore;
  format: FileFormat;
  absolutePath: string;
  hostId: string | null;
  sha256: string;
}

function parseDocument(content: string): {
  document: { store: Record<string, unknown>; schema: unknown };
  format: FileFormat;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const value = parsed as {
    records?: unknown;
    schema?: unknown;
    store?: unknown;
    document?: { store?: unknown; schema?: unknown };
    tldrawFileFormatVersion?: unknown;
  };
  if (Array.isArray(value.records) && value.schema !== undefined) {
    const store: Record<string, unknown> = {};
    for (const record of value.records) {
      const id = (record as { id?: unknown }).id;
      if (typeof id === "string") store[id] = record;
    }
    return {
      document: { store, schema: value.schema },
      format: {
        kind: "tldr",
        fileFormatVersion: value.tldrawFileFormatVersion ?? 1,
      },
    };
  }
  if (
    value.store !== null &&
    typeof value.store === "object" &&
    value.schema !== undefined
  ) {
    return {
      document: {
        store: value.store as Record<string, unknown>,
        schema: value.schema,
      },
      format: { kind: "snapshot" },
    };
  }
  if (
    value.document !== undefined &&
    value.document.store !== null &&
    typeof value.document.store === "object"
  ) {
    return {
      document: {
        store: value.document.store as Record<string, unknown>,
        schema: value.document.schema,
      },
      format: { kind: "snapshot" },
    };
  }
  return null;
}

function serializeDocument(
  store: TLStore,
  format: FileFormat,
): string {
  const { document } = getSnapshot(store);
  const snapshot = document as unknown as {
    store: Record<string, unknown>;
    schema: unknown;
  };
  if (format.kind === "tldr") {
    return JSON.stringify(
      {
        tldrawFileFormatVersion: format.fileFormatVersion,
        schema: snapshot.schema,
        records: Object.values(snapshot.store),
      },
      null,
      "\t",
    );
  }
  return JSON.stringify(snapshot, null, "\t");
}

export function TldrFileView({
  path,
  source,
  Original,
}: {
  path: string;
  source: PluginFileOpenerSource;
  Original: ComponentType;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { values, isLoading: settingsLoading } = useSettings();
  const licenseKey = resolveTldrawLicenseKey(values?.licenseKey);

  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "ready"; ready: ReadyState }
    | { phase: "fallback" }
  >({ phase: "loading" });
  const readyRef = useRef<ReadyState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading" });
    readyRef.current = null;
    rpc
      .call("file_read", {
        path,
        source: {
          kind: source.kind,
          environmentId: source.environmentId,
          threadId: source.threadId,
        },
      })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setState({ phase: "fallback" });
          return;
        }
        const parsed = parseDocument(result.content);
        if (parsed === null) {
          setState({ phase: "fallback" });
          return;
        }
        const store = createTLStore({
          shapeUtils: defaultShapeUtils,
          bindingUtils: defaultBindingUtils,
        });
        try {
          loadSnapshot(store, { document: parsed.document as never });
        } catch {
          setState({ phase: "fallback" });
          return;
        }
        const ready: ReadyState = {
          store,
          format: parsed.format,
          absolutePath: result.absolutePath,
          hostId: result.hostId,
          sha256: result.sha256,
        };
        readyRef.current = ready;
        setState({ phase: "ready", ready });
      })
      .catch(() => {
        if (!cancelled) setState({ phase: "fallback" });
      });
    return () => {
      cancelled = true;
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      if (dirtyRef.current) void flushSave();
      unlistenRef.current?.();
      unlistenRef.current = null;
      readyRef.current = null;
    };
  }, [rpc, path, source.kind, source.environmentId, source.threadId]);

  const flushSave = async (): Promise<void> => {
    const ready = readyRef.current;
    if (ready === null || savingRef.current) return;
    savingRef.current = true;
    dirtyRef.current = false;
    try {
      const content = serializeDocument(ready.store, ready.format);
      const result = await rpc.call("file_save", {
        absolutePath: ready.absolutePath,
        hostId: ready.hostId,
        content,
        expectedSha256: ready.sha256,
      });
      if (result.outcome === "saved") {
        ready.sha256 = result.sha256;
      } else {
        toast.error(
          `${path} changed on disk — reopen the file to pick up the new version before editing.`,
        );
      }
    } catch (cause) {
      toast.error(`Saving ${path} failed: ${String(cause)}`);
    } finally {
      savingRef.current = false;
      if (dirtyRef.current) scheduleSave();
    }
  };
  const scheduleSave = (): void => {
    dirtyRef.current = true;
    if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, 1000);
  };

  if (state.phase === "fallback") return <Original />;
  if (state.phase === "loading" || settingsLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading canvas…
      </div>
    );
  }
  if (licenseKey === undefined) return <TldrawLicenseRequired />;
  return (
    <TldrawLicenseBoundary>
      <Tldraw
        store={state.ready.store}
        licenseKey={licenseKey}
        onMount={(editor: Editor) => {
          editor.user.updateUserPreferences({ colorScheme: "system" });
          unlistenRef.current = editor.store.listen(() => scheduleSave(), {
            scope: "document",
            source: "user",
          });
        }}
      />
    </TldrawLicenseBoundary>
  );
}
