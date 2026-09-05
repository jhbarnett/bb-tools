import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { EditorFiles, rpcContract, SaveInput } from "./contract.js";
import {
  enabled,
  harnesses,
  labels,
  parseEntry,
  translate,
  type Harness,
} from "./config";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Editor({
  hostId,
  existingName,
  files,
  names,
  onClose,
  onSaved,
  reload,
}: {
  hostId: string;
  existingName: string | null;
  files: EditorFiles;
  names: string[];
  onClose: () => void;
  onSaved: () => void;
  reload: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState(existingName ?? "");
  const [selected, setSelected] = useState<Record<Harness, boolean>>(
    () =>
      Object.fromEntries(
        files.map((f) => {
          let active = false;
          try {
            active =
              f.config !== null && enabled(f.harness, JSON.parse(f.config));
          } catch {
            /* Repair invalid entries in the native JSON editor. */
          }
          return [f.harness, active || (!existingName && f.harness === "pi")];
        }),
      ) as Record<Harness, boolean>,
  );
  const [texts, setTexts] = useState<Record<Harness, string>>(
    () =>
      Object.fromEntries(
        files.map((f) => [
          f.harness,
          f.config ??
            JSON.stringify(
              f.harness === "pi"
                ? { url: "", auth: "oauth" }
                : f.harness === "claude"
                  ? { type: "http", url: "" }
                  : { url: "" },
              null,
              2,
            ),
        ]),
      ) as Record<Harness, string>,
  );
  const [active, setActive] = useState<Harness>(
    files.find((f) => f.config !== null)?.harness ?? "pi",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [results, setResults] = useState<
    | {
        harness: Harness;
        saved: boolean;
        error: string | null;
        backupPath: string | null;
      }[]
    | null
  >(null);
  const currentFile = files.find((f) => f.harness === active)!;

  function choose(harness: Harness, checked: boolean) {
    setError("");
    if (checked && files.find((f) => f.harness === harness)?.config === null) {
      const source = harnesses.find((h) => h !== harness && selected[h]);
      if (source) {
        try {
          const copied = JSON.stringify(
            translate(parseEntry(source, texts[source]), source, harness),
            null,
            2,
          );
          setTexts((t) => ({ ...t, [harness]: copied }));
        } catch (cause) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Cannot copy this configuration; fill in the new harness manually.",
          );
        }
      }
    }
    setSelected((s) => ({ ...s, [harness]: checked }));
    setActive(harness);
  }
  async function save(remove = false) {
    setError("");
    setResults(null);
    if (!existingName && names.includes(name.trim())) {
      setError(
        "That name already exists. Close this form and edit its existing row.",
      );
      return;
    }
    if (!remove && !existingName && !Object.values(selected).some(Boolean)) {
      setError("Select at least one harness for a new server.");
      return;
    }
    let changes: SaveInput["changes"];
    try {
      changes = files
        .filter((f) => !f.error && (selected[f.harness] || f.config !== null))
        .map((f) => {
          let config: string | null = null;
          if (
            !remove &&
            (selected[f.harness] ||
              (f.config !== null && f.harness !== "claude"))
          ) {
            const value = parseEntry(f.harness, texts[f.harness]);
            if (f.harness === "pi") {
              if (!selected.pi) value.disabled = true;
              else if (value.disabled === true) value.disabled = false;
            }
            if (f.harness === "codex") {
              if (!selected.codex) value.enabled = false;
              else if (value.enabled === false) value.enabled = true;
            }
            config = JSON.stringify(value);
          }
          return { harness: f.harness, expectedSha256: f.sha256, config };
        });
      if (!changes.length)
        throw new Error("No writable harness configurations are selected.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Invalid configuration.",
      );
      return;
    }
    setBusy(true);
    try {
      const response = await rpc.call("save", {
        hostId,
        name: name.trim(),
        createOnly: existingName === null,
        changes,
      });
      setResults(response);
      onSaved();
      if (response.every((r) => r.saved)) setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }
  const saved = results?.every((r) => r.saved) === true;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="space-y-4 rounded-lg border border-border bg-card p-4"
      aria-label={existingName ? `Edit ${existingName}` : "Add MCP server"}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">
          {existingName ? `Edit ${existingName}` : "Add MCP server"}
        </h2>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
      <fieldset disabled={busy || saved} className="space-y-4">
        <label className="block space-y-1 text-sm">
          <span>Server name</span>
          <Input
            required
            pattern="[A-Za-z0-9_][A-Za-z0-9_.-]*"
            maxLength={128}
            readOnly={existingName !== null}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
          />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Enable for</legend>
          <div className="flex flex-wrap gap-4">
            {files.map((f) => (
              <label
                key={f.harness}
                className="flex items-center gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  checked={selected[f.harness]}
                  disabled={!!f.error}
                  onChange={(e) => choose(f.harness, e.target.checked)}
                />
                {labels[f.harness]}
                {f.error && " (unavailable)"}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          Unchecking disables the native entry in Pi/Codex; Claude's user entry
          is removed (there is no equivalent global disabled flag).
          Project/shared/managed entries can still apply. Newly selected
          harnesses receive only portable connection fields—review
          authentication, environment syntax, and advanced options below.
        </p>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Harness configuration editor"
        >
          {harnesses.map((h) => (
            <Button
              key={h}
              type="button"
              variant={h === active ? "default" : "outline"}
              aria-pressed={h === active}
              onClick={() => setActive(h)}
            >
              {labels[h]}
            </Button>
          ))}
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">
          {currentFile.path}
        </p>
        {currentFile.error ? (
          <p role="alert" className="text-sm text-destructive">
            {currentFile.error}
          </p>
        ) : (
          <>
            {!existingName && (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setTexts((t) => ({
                      ...t,
                      [active]: JSON.stringify(
                        active === "pi"
                          ? { url: "", auth: "oauth" }
                          : active === "claude"
                            ? { type: "http", url: "" }
                            : { url: "" },
                        null,
                        2,
                      ),
                    }))
                  }
                >
                  HTTP template
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setTexts((t) => ({
                      ...t,
                      [active]: JSON.stringify(
                        {
                          ...(active === "claude" ? { type: "stdio" } : {}),
                          command: "",
                          args: [],
                          env: {},
                        },
                        null,
                        2,
                      ),
                    }))
                  }
                >
                  Stdio template
                </Button>
              </div>
            )}
            <label className="block space-y-1 text-sm">
              <span>{labels[active]} server JSON (not the whole file)</span>
              <textarea
                spellCheck={false}
                autoComplete="off"
                className="min-h-64 w-full rounded-md border border-border bg-background p-3 font-mono text-xs"
                value={texts[active]}
                onChange={(e) =>
                  setTexts((t) => ({ ...t, [active]: e.target.value }))
                }
              />
            </label>
          </>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Authentication fields and save behavior
          </summary>
          <div className="mt-2 space-y-2">
            <p>
              Pi: <code>auth: "oauth"</code> or{" "}
              <code>auth: "bearer", bearerTokenEnv: "TOKEN"</code>. Claude:{" "}
              <code>headers: {`{ "Authorization": "Bearer \${TOKEN}" }`}</code>.
              Codex: <code>bearer_token_env_var: "TOKEN"</code> or{" "}
              <code>http_headers</code>. Environment references must exist in
              the harness's environment; this pane does not set environment
              variables.
            </p>
            <p>
              Save first, then Authenticate from the row. OAuth credentials stay
              in each harness's native store; they are not copied between
              agents. Raw JSON may contain secrets: prefer environment
              references and avoid screen sharing this editor.
            </p>
            <p>
              Every changed existing file gets a private .bak copy. JSON edits
              preserve unrelated formatting. Codex TOML is reserialized: values
              are preserved but comments and formatting are not. Writes are
              individually conflict-checked, not an all-or-nothing multi-file
              transaction.
            </p>
          </div>
        </details>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy || !!results}>Save configuration</Button>
          {existingName && (
            <Button
              type="button"
              variant="outline"
              className="text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              Remove from all writable harnesses
            </Button>
          )}
        </div>
        {confirmDelete && (
          <div
            role="alert"
            className="space-y-2 rounded border border-destructive p-3 text-sm"
          >
            <p>
              Remove “{existingName}” from every readable user configuration on
              this machine? This does not revoke OAuth tokens or remove
              project/managed entries.
            </p>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void save(true)}
            >
              Confirm removal
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </div>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {results && (
        <div className="space-y-2 text-sm" role="status">
          {results.map((r) => (
            <div key={r.harness}>
              <p className={r.saved ? "" : "text-destructive"}>
                {labels[r.harness]}: {r.saved ? "Saved" : r.error}
              </p>
              {r.backupPath && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  Backup: {r.backupPath}
                </p>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Start a new harness session to apply changes. Configuration presence
            does not prove a server is connected.
          </p>
        </div>
      )}
      {(error || results) && (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={reload}
        >
          Discard form and reload current files
        </Button>
      )}
    </form>
  );
}
