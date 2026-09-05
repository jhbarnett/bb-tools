// The Canvas panel's root view: browse, create, rename, and delete canvases.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CanvasMeta {
  id: string;
  title: string;
  projectId: string | null;
  threadId: string | null;
  version: number;
  updatedAt: string;
}

export function CanvasLibrary({ onOpen }: { onOpen: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [canvases, setCanvases] = useState<CanvasMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<CanvasMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CanvasMeta | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const refetch = useCallback(() => {
    rpc
      .call("canvas_list", {})
      .then((result) => {
        setCanvases(result.canvases);
        setError(null);
      })
      .catch((cause) => setError(String(cause)));
  }, [rpc]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("canvas-list-changed", refetch);
  useRealtime("canvas-changed", refetch);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Wireframes and mockups you and your agents draw together. Mention a
            canvas with <code>@</code> in chat, or let agents use the{" "}
            <code>canvas_*</code> tools.
          </p>
          <Button
            onClick={() => {
              setDraftTitle("");
              setCreateOpen(true);
            }}
          >
            <Icon name="Plus" className="size-4" />
            New canvas
          </Button>
        </div>
        {error !== null ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="mt-4">
          {canvases === null ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Loading canvases…
            </div>
          ) : canvases.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No canvases yet. Create one, or ask an agent to sketch something —
              its canvas appears here.
            </div>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {canvases.map((canvas) => (
                <li
                  key={canvas.id}
                  className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm hover:bg-accent/50"
                  onClick={() => onOpen(canvas.id)}
                >
                  <Icon
                    name="Palette"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {canvas.title}
                  </span>
                  {canvas.threadId !== null ? (
                    <span className="hidden rounded-full bg-accent px-2 py-0.5 text-xs text-accent-foreground sm:inline">
                      thread
                    </span>
                  ) : null}
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {new Date(canvas.updatedAt).toLocaleDateString()}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-foreground"
                    aria-label={`Rename "${canvas.title}"`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDraftTitle(canvas.title);
                      setRenameTarget(canvas);
                    }}
                  >
                    <Icon name="Edit" className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete "${canvas.title}"`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteTarget(canvas);
                    }}
                  >
                    <Icon name="Trash2" className="size-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New canvas</DialogTitle>
          </DialogHeader>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const title = draftTitle.trim();
              if (title === "") return;
              rpc
                .call("canvas_create", { title })
                .then((meta) => {
                  setCreateOpen(false);
                  onOpen(meta.id);
                })
                .catch((cause) => toast.error(String(cause)));
            }}
          >
            <Input
              autoFocus
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder="Onboarding flow v1"
              aria-label="Canvas title"
            />
            <Button type="submit" disabled={draftTitle.trim() === ""}>
              Create
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename canvas</DialogTitle>
          </DialogHeader>
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const title = draftTitle.trim();
              if (title === "" || renameTarget === null) return;
              rpc
                .call("canvas_rename", { id: renameTarget.id, title })
                .then(() => {
                  setRenameTarget(null);
                  refetch();
                })
                .catch((cause) => toast.error(String(cause)));
            }}
          >
            <Input
              autoFocus
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              aria-label="Canvas title"
            />
            <Button type="submit" disabled={draftTitle.trim() === ""}>
              Rename
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{deleteTarget?.title}”?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This deletes the canvas and its checkpoints. There is no undo.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget === null) return;
                rpc
                  .call("canvas_delete", { id: deleteTarget.id })
                  .then(() => {
                    setDeleteTarget(null);
                    refetch();
                  })
                  .catch((cause) => toast.error(String(cause)));
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
