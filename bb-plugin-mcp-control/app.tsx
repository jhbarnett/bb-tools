import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { EditorFiles, Inventory, rpcContract } from "./contract";
import { harnesses, labels, type Harness } from "./config";
import { AuthTerminal } from "./auth-terminal";
import { Editor } from "./editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function MachinePane({ hostId }: { hostId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<{
    name: string | null;
    files: EditorFiles;
    revision: number;
  } | null>(null);
  const [login, setLogin] = useState<{
    terminalId: string;
    command: string;
    instruction: string;
  } | null>(null);
  const alive = useRef(true);
  const request = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    const id = ++request.current;
    void rpc.call("list", { hostId }).then(
      (result) => {
        if (alive.current && id === request.current) {
          setInventory(result);
          setError("");
        }
      },
      () => {
        if (alive.current && id === request.current)
          setError(
            "Could not read this machine's configurations. Check its connection and refresh.",
          );
      },
    );
  }, [rpc, hostId]);
  useEffect(refresh, [refresh]);
  useRealtime("changed", refresh);
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);

  async function openEditor(name: string | null) {
    if (!inventory) return;
    setBusy(true);
    setError("");
    try {
      const current = await rpc.call("edit", {
        hostId,
        name: name ?? "new-server",
      });
      const files =
        name === null ? current.map((f) => ({ ...f, config: null })) : current;
      if (alive.current) setEditor({ name, files, revision: Date.now() });
    } catch {
      if (alive.current)
        setError("Could not open the server configuration. Refresh and retry.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function authenticate(name: string, harness: Harness) {
    setBusy(true);
    setError("");
    try {
      const result = await rpc.call("authStart", { hostId, name, harness });
      if (!alive.current) {
        await rpc.call("authClose", { terminalId: result.terminalId });
        return;
      }
      setLogin(result);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not start authentication.",
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const rows =
    inventory?.entries.filter((r) =>
      r.name.toLowerCase().includes(filter.toLowerCase()),
    ) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-40 flex-1"
          aria-label="Filter MCP servers"
          placeholder="Filter servers…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button variant="outline" disabled={busy} onClick={refresh}>
          Refresh
        </Button>
        <Button
          disabled={busy || !inventory || !!editor}
          onClick={() => void openEditor(null)}
        >
          Add MCP
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {login && <AuthTerminal login={login} onClose={() => setLogin(null)} />}
      {editor && (
        <Editor
          key={editor.revision}
          hostId={hostId}
          existingName={editor.name}
          files={editor.files}
          names={inventory?.entries.map((e) => e.name) ?? []}
          onClose={() => setEditor(null)}
          onSaved={refresh}
          reload={() => {
            refresh();
            void openEditor(editor.name);
          }}
        />
      )}
      {inventory === null ? (
        <p
          role="status"
          className="py-8 text-center text-sm text-muted-foreground"
        >
          {error
            ? "Configuration unavailable."
            : "Reading native configuration…"}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                MCP user configuration by harness; configured does not mean
                connected
              </caption>
              <thead className="bg-card">
                <tr>
                  <th className="p-3">Server</th>
                  {harnesses.map((h) => (
                    <th key={h} className="p-3">
                      {labels[h]}
                    </th>
                  ))}
                  <th className="p-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name} className="border-t border-border">
                    <th scope="row" className="p-3 font-medium">
                      <span className="block max-w-64 break-all">
                        {row.name}
                      </span>
                    </th>
                    {harnesses.map((h) => {
                      const presence = row.harnesses.find(
                        (p) => p.harness === h,
                      );
                      const unavailable = inventory.files.find(
                        (f) => f.harness === h,
                      )?.error;
                      return (
                        <td key={h} className="p-3 align-top">
                          <span
                            className={`block text-xs ${presence?.enabled ? "font-medium" : "text-muted-foreground"}`}
                          >
                            {unavailable
                              ? "Unreadable"
                              : presence
                                ? presence.enabled
                                  ? "Enabled in config"
                                  : "Disabled"
                                : "Not configured"}
                          </span>
                          {presence && (
                            <span className="mt-1 block max-w-48 break-all text-xs text-muted-foreground">
                              {presence.endpoint}
                            </span>
                          )}
                          {presence?.enabled &&
                            presence.editable &&
                            presence.endpoint.startsWith("http") && (
                              <Button
                                className="mt-2"
                                variant="outline"
                                size="sm"
                                disabled={busy || !!login}
                                onClick={() => void authenticate(row.name, h)}
                              >
                                Authenticate
                              </Button>
                            )}
                        </td>
                      );
                    })}
                    <td className="p-3 align-top">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={
                          busy ||
                          !!editor ||
                          row.harnesses.some((h) => !h.editable)
                        }
                        onClick={() => void openEditor(row.name)}
                      >
                        Edit / remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && (
              <p className="p-8 text-center text-sm text-muted-foreground">
                {filter
                  ? "No matching servers."
                  : "No user-level MCP entries in these files. Add one above."}
              </p>
            )}
          </div>
          <details className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              Configuration files & scope
            </summary>
            <ul className="mt-3 space-y-2">
              {inventory.files.map((f) => (
                <li key={f.harness}>
                  <strong>{labels[f.harness]}</strong> ·{" "}
                  <code className="break-all">{f.path}</code>
                  {f.error && (
                    <p role="alert" className="text-destructive">
                      {f.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3">
              Only these user files are managed. Pi's shared files/imports,
              project overrides, Codex profiles, Claude managed settings, and
              BB-injected tools are not shown. They may override or add servers.
              Pi requires pi-mcp-adapter. Changes apply when the harness next
              loads its configuration.
            </p>
          </details>
          {inventory.files.some((f) => f.error) && (
            <p role="alert" className="text-sm text-destructive">
              Some harness files could not be read. See Configuration files &
              scope. They are protected from writes.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ControlPane() {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<
    { id: string; name: string; connected: boolean }[]
  >([]);
  const [hostId, setHostId] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const load = useCallback(() => {
    void rpc.call("hosts").then(
      (result) => {
        setHosts(result);
        setHostId(
          (current) => current || result.find((h) => h.connected)?.id || "",
        );
        setError("");
        setLoaded(true);
      },
      () => {
        setError("Could not load machines.");
        setLoaded(true);
      },
    );
  }, [rpc]);
  useEffect(load, [load]);
  return (
    <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <p className="text-sm text-muted-foreground">
          One place for your MCP connections. Add a server, choose its coding
          agents, and authenticate with each harness's native tools.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span>Machine</span>
            <select
              aria-label="Machine"
              className="rounded-md border border-border bg-background px-3 py-2"
              value={hostId}
              onChange={(e) => setHostId(e.target.value)}
            >
              <option value="" disabled>
                Select a machine
              </option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id} disabled={!h.connected}>
                  {h.name}
                  {h.connected ? "" : " (offline)"}
                </option>
              ))}
            </select>
          </label>
          <span className="rounded border border-border px-2 py-1 text-xs text-muted-foreground">
            User scope · all projects
          </span>
          <Button size="sm" variant="ghost" onClick={load}>
            Refresh machines
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {hostId ? (
          <MachinePane key={hostId} hostId={hostId} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {loaded
              ? "Connect a machine in BB Settings to manage its configurations."
              : "Loading machines…"}
          </p>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "servers",
    title: "MCP Control",
    icon: "Plug",
    path: "servers",
    component: ControlPane,
  });
});
