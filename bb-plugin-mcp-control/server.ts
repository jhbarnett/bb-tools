import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract, hostContract, nameSchema } from "./contract";
import {
  enabled,
  endpoint,
  harnesses,
  labels,
  object,
  own,
  parseDocument,
  parseEntry,
  servers,
  updateDocument,
  type Config,
  type Harness,
} from "./config";
import { authCommand, findCallback } from "./auth";
export { rpcContract } from "./contract";

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  type Snapshot = {
    harness: Harness;
    path: string;
    sha256: string | null;
    text: string;
    document: Config;
    error: string | null;
  };

  async function snapshots(hostId: string): Promise<Snapshot[]> {
    const info = await host.call("inspect", null, { hostId });
    return Promise.all(
      harnesses.map(async (harness) => {
        const file = info.files[harness];
        const snapshot: Snapshot = {
          harness,
          path: file.path,
          sha256: null,
          text: harness === "codex" ? "" : "{}\n",
          document: {},
          error: null,
        };
        try {
          if (file.exists) {
            const read = await bb.sdk.files.read({ hostId, path: file.path });
            if (
              read.contentEncoding !== "utf8" ||
              read.sizeBytes > 2 * 1024 * 1024
            )
              throw new Error(
                "Configuration must be UTF-8 and no larger than 2 MiB.",
              );
            snapshot.text = read.content;
            snapshot.sha256 = read.sha256;
          }
          snapshot.document = parseDocument(harness, snapshot.text);
        } catch {
          snapshot.error = `Cannot read or parse ${labels[harness]} configuration. Check its syntax, size (2 MiB maximum), and permissions. It will not be overwritten.`;
        }
        return snapshot;
      }),
    );
  }

  const fileView = (s: Snapshot) => ({
    harness: s.harness,
    path: s.path,
    sha256: s.sha256,
    error: s.error,
  });
  async function list(hostId: string) {
    const files = await snapshots(hostId);
    const rows = new Map<
      string,
      {
        name: string;
        harnesses: {
          harness: Harness;
          enabled: boolean;
          endpoint: string;
          editable: boolean;
        }[];
      }
    >();
    for (const file of files) {
      if (file.error) continue;
      for (const [name, value] of Object.entries(
        servers(file.document, file.harness),
      )) {
        const row = rows.get(name) ?? { name, harnesses: [] };
        row.harnesses.push({
          harness: file.harness,
          enabled: object(value) && enabled(file.harness, value),
          endpoint: object(value) ? endpoint(value) : "Invalid entry",
          editable: nameSchema.safeParse(name).success,
        });
        rows.set(name, row);
      }
    }
    return {
      files: files.map(fileView),
      entries: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  type AuthSession = {
    hostId: string;
    harness: Harness;
    name: string;
    created: number;
    output: string;
    callback: ReturnType<typeof findCallback>;
  };
  const sessions = new Map<string, AuthSession>();
  function session(id: string): AuthSession {
    const found = sessions.get(id);
    if (!found)
      throw new Error(
        "Login terminal expired or was closed. Start authentication again.",
      );
    return found;
  }
  async function close(id: string) {
    session(id);
    await bb.sdk.terminals.close({ terminalId: id, mode: "force" });
    sessions.delete(id);
  }
  const expiry = setInterval(() => {
    for (const [id, s] of sessions)
      if (Date.now() - s.created > 15 * 60_000) void close(id).catch(() => {});
  }, 30_000);
  bb.onDispose(async () => {
    clearInterval(expiry);
    await Promise.allSettled([...sessions.keys()].map(close));
    sessions.clear();
  });

  bb.rpc.register(rpcContract, {
    async hosts() {
      return (await bb.sdk.hosts.list()).map((h) => ({
        id: h.id,
        name: h.name,
        connected: h.status === "connected",
      }));
    },
    list: ({ hostId }) => list(hostId),
    async edit({ hostId, name }) {
      return (await snapshots(hostId)).map((s) => {
        const entries = servers(s.document, s.harness);
        return {
          ...fileView(s),
          config: own(entries, name)
            ? JSON.stringify(entries[name], null, 2)
            : null,
        };
      });
    },
    async save({ hostId, name, createOnly, changes }) {
      if (new Set(changes.map((c) => c.harness)).size !== changes.length)
        throw new Error("Duplicate harness changes.");
      const files = await snapshots(hostId);
      if (
        createOnly &&
        files.some((f) => own(servers(f.document, f.harness), name))
      )
        throw new Error(
          "That server name already exists. Open its existing row instead.",
        );
      // Preflight all inputs and revisions before writing ANY file. Native tools can still
      // race later; each write has a CAS guard and partial completion is reported explicitly.
      const planned = changes.map((change) => {
        const file = files.find((f) => f.harness === change.harness)!;
        if (file.error) throw new Error(file.error);
        if (file.sha256 !== change.expectedSha256)
          throw new Error(
            `${labels[file.harness]} changed since this editor opened. Reload the editor and merge your changes.`,
          );
        const config =
          change.config === null
            ? null
            : parseEntry(change.harness, change.config);
        const existing = servers(file.document, file.harness);
        const noChange =
          config === null
            ? !own(existing, name)
            : own(existing, name) &&
              JSON.stringify(existing[name]) === JSON.stringify(config);
        return {
          file,
          text: noChange
            ? file.text
            : updateDocument(file.harness, file.text, name, config),
        };
      });
      const results: {
        harness: Harness;
        saved: boolean;
        error: string | null;
        backupPath: string | null;
      }[] = [];
      let failed = false;
      for (const { file, text } of planned) {
        const result = {
          harness: file.harness,
          saved: false,
          error: null as string | null,
          backupPath: null as string | null,
        };
        if (failed) {
          result.error =
            "Not attempted because an earlier harness write failed.";
          results.push(result);
          continue;
        }
        try {
          if (text !== file.text) {
            if (file.sha256 !== null) {
              const backupPath = `${file.path}.mcp-control-${randomUUID()}.bak`;
              const backup = await bb.sdk.files.write({
                hostId,
                path: backupPath,
                content: file.text,
                expectedSha256: null,
                mode: 0o600,
              });
              if (backup.outcome !== "written")
                throw new Error(
                  "Backup failed; configuration was not written.",
                );
              result.backupPath = backupPath;
            }
            const written = await bb.sdk.files.write({
              hostId,
              path: file.path,
              content: text,
              expectedSha256: file.sha256,
              mode: 0o600,
              createParents: true,
            });
            if (written.outcome !== "written")
              throw new Error(
                "Configuration changed during save; refresh before retrying.",
              );
          }
          result.saved = true;
        } catch {
          failed = true;
          result.error =
            "Save could not be confirmed (conflict, permissions, or disconnected host). Refresh to inspect current state before retrying. Earlier successful writes remain applied; backups are listed below.";
        }
        results.push(result);
      }
      bb.realtime.publish("changed", { hostId });
      return results;
    },
    async authStart({ hostId, harness, name }) {
      if (sessions.size >= 8)
        throw new Error("Close an existing login terminal first (maximum 8).");
      if (
        [...sessions.values()].some(
          (s) =>
            s.hostId === hostId && s.harness === harness && s.name === name,
        )
      )
        throw new Error(
          "A login for this server is already open. Close it first.",
        );
      const info = await host.call("inspect", null, { hostId });
      if (info.platform === "win32")
        throw new Error(
          "Embedded authentication currently supports macOS and Linux. Run the harness's MCP login command on Windows.",
        );
      const file = (await snapshots(hostId)).find(
        (f) => f.harness === harness,
      )!;
      const entry = servers(file.document, harness)[name];
      if (
        file.error ||
        !object(entry) ||
        !enabled(harness, entry) ||
        typeof entry.url !== "string"
      )
        throw new Error(
          "Authentication requires an enabled HTTP server in this harness's user configuration.",
        );
      const { command, instruction } = authCommand(harness, name);
      const terminal = await bb.sdk.terminals.create({
        scope: { kind: "host_path", hostId, cwd: info.home },
        cols: 100,
        rows: 24,
        title: `MCP login · ${labels[harness]} · ${name}`,
        start: { mode: "command", command },
      });
      sessions.set(terminal.id, {
        hostId,
        harness,
        name,
        created: Date.now(),
        output: "",
        callback: null,
      });
      return { terminalId: terminal.id, command, instruction };
    },
    async authRead({ terminalId, sinceSeq }) {
      const s = session(terminalId);
      const [output, terminal] = await Promise.all([
        bb.sdk.terminals.output({
          terminalId,
          sinceSeq,
          limitChunks: 100,
          tailBytes: 65536,
        }),
        bb.sdk.terminals.get({ terminalId }),
      ]);
      if (s.harness === "codex" && !s.callback) {
        s.output = (
          s.output +
          output.chunks
            .map((c) => Buffer.from(c.dataBase64, "base64").toString("utf8"))
            .join("")
        ).slice(-131072);
        s.callback = findCallback(s.output);
        if (s.callback) s.output = "";
      }
      return {
        ...output,
        status: terminal.status,
        exitCode: terminal.exitCode,
        canRelay: s.callback !== null,
      };
    },
    async authInput({ terminalId, data }) {
      session(terminalId);
      await bb.sdk.terminals.input({
        terminalId,
        dataBase64: Buffer.from(data).toString("base64"),
      });
      return null;
    },
    async authResize({ terminalId, cols, rows }) {
      session(terminalId);
      await bb.sdk.terminals.resize({ terminalId, cols, rows });
      return null;
    },
    async authCallback({ terminalId, redirectUrl }) {
      const s = session(terminalId);
      if (!s.callback)
        throw new Error(
          "No native loopback OAuth callback has been detected yet.",
        );
      const result = await host.call(
        "callback",
        { redirectUrl, ...s.callback },
        { hostId: s.hostId },
      );
      if (result.delivered) s.callback = null;
      return result;
    },
    async authClose({ terminalId }) {
      await close(terminalId);
      return null;
    },
  });

  // Deliberately read-only: configuration secrets and auth terminal contents never enter agent tools.
  bb.cli.register({
    name: "mcp-control",
    summary:
      "Inspect MCP configuration across Pi, Claude Code, and Codex (no secrets)",
    commands: [
      {
        name: "list",
        summary: "List user-level MCP configurations on a machine",
        usage: "bb mcp-control list <host-id>",
      },
    ],
    async run(argv) {
      if (argv[0] !== "list" || !argv[1] || argv.length !== 2)
        return { exitCode: 1, stderr: "Usage: bb mcp-control list <host-id>" };
      return {
        exitCode: 0,
        stdout: JSON.stringify(await list(argv[1]), null, 2),
      };
    },
  });
}
