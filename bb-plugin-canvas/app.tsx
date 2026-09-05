// bb-plugin-canvas frontend: the Canvas sidebar panel (library + editor), the
// per-thread Canvas side tab, and the .tldr file opener.
import "tldraw/tldraw.css";
import { useEffect, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { CanvasEditor } from "./components/canvas-editor";
import { CanvasLibrary } from "./components/canvas-library";
import { TldrFileView } from "./components/tldr-file";

function CanvasPanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  if (subPath === "") {
    return (
      <CanvasLibrary
        onOpen={(id) => navigate.toPluginPanel("canvas", { subPath: id })}
      />
    );
  }
  return (
    <CanvasEditor
      canvasId={subPath}
      onBack={() => navigate.toPluginPanel("canvas", { subPath: "" })}
    />
  );
}

function ThreadCanvasTab({
  threadId,
  params,
}: {
  threadId: string;
  params: unknown;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const paramCanvasId =
    params !== null &&
    typeof params === "object" &&
    typeof (params as { canvasId?: unknown }).canvasId === "string"
      ? (params as { canvasId: string }).canvasId
      : null;
  const [canvasId, setCanvasId] = useState<string | null>(paramCanvasId);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (paramCanvasId !== null) {
      setCanvasId(paramCanvasId);
      return;
    }
    let cancelled = false;
    rpc
      .call("canvas_get_or_create_for_thread", { threadId })
      .then((meta) => {
        if (!cancelled) setCanvasId(meta.id);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, paramCanvasId]);
  if (error !== null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {error}
      </div>
    );
  }
  if (canvasId === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Opening canvas…
      </div>
    );
  }
  return <CanvasEditor canvasId={canvasId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "canvas",
    title: "Canvas",
    icon: "Palette",
    path: "canvas",
    component: CanvasPanel,
  });
  app.slots.threadPanelAction({
    id: "canvas",
    title: "Canvas",
    icon: "Palette",
    layout: "flush",
    component: ThreadCanvasTab,
  });
  app.slots.fileOpener({
    id: "tldr",
    title: "tldraw canvas",
    extensions: ["tldr"],
    component: TldrFileView,
  });
});
