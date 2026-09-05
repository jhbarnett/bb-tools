// SQLite persistence for canvases, their op log, and checkpoints.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CanvasDocument, DocRecord } from "./doc";

export interface CanvasMeta {
  id: string;
  title: string;
  projectId: string | null;
  threadId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasOpRow {
  version: number;
  puts: DocRecord[] | null;
  removes: string[] | null;
  fullReplace: boolean;
  source: string;
}

export interface CheckpointMeta {
  id: string;
  canvasId: string;
  name: string;
  version: number;
  createdAt: string;
}

/** Ops older than (version - OPS_RETAINED) are pruned; clients that fall
 * further behind get a full document reload instead. */
const OPS_RETAINED = 500;

interface CanvasRow {
  id: string;
  title: string;
  project_id: string | null;
  thread_id: string | null;
  document: string;
  version: number;
  created_at: string;
  updated_at: string;
}

const toMeta = (row: CanvasRow): CanvasMeta => ({
  id: row.id,
  title: row.title,
  projectId: row.project_id,
  threadId: row.thread_id,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function openCanvasStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS canvases (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       project_id TEXT,
       thread_id TEXT,
       document TEXT NOT NULL,
       version INTEGER NOT NULL DEFAULT 1,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS canvas_ops (
       canvas_id TEXT NOT NULL,
       version INTEGER NOT NULL,
       puts TEXT,
       removes TEXT,
       full_replace INTEGER NOT NULL DEFAULT 0,
       source TEXT NOT NULL,
       created_at TEXT NOT NULL,
       PRIMARY KEY (canvas_id, version)
     )`,
    `CREATE TABLE IF NOT EXISTS checkpoints (
       id TEXT PRIMARY KEY,
       canvas_id TEXT NOT NULL,
       name TEXT NOT NULL,
       document TEXT NOT NULL,
       version INTEGER NOT NULL,
       created_at TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_canvases_thread ON canvases (thread_id)`,
    `CREATE INDEX IF NOT EXISTS idx_checkpoints_canvas ON checkpoints (canvas_id)`,
  ]);

  const now = (): string => new Date().toISOString();

  function list(projectId?: string): CanvasMeta[] {
    const rows = (
      projectId === undefined
        ? db
            .prepare(
              `SELECT id, title, project_id, thread_id, version, created_at, updated_at, '' AS document
               FROM canvases ORDER BY updated_at DESC`,
            )
            .all()
        : db
            .prepare(
              `SELECT id, title, project_id, thread_id, version, created_at, updated_at, '' AS document
               FROM canvases WHERE project_id = ? ORDER BY updated_at DESC`,
            )
            .all(projectId)
    ) as CanvasRow[];
    return rows.map(toMeta);
  }

  function get(
    id: string,
  ): { meta: CanvasMeta; document: CanvasDocument } | null {
    const row = db.prepare(`SELECT * FROM canvases WHERE id = ?`).get(id) as
      | CanvasRow
      | undefined;
    if (row === undefined) return null;
    return {
      meta: toMeta(row),
      document: JSON.parse(row.document) as CanvasDocument,
    };
  }

  function getMeta(id: string): CanvasMeta | null {
    const row = db
      .prepare(
        `SELECT id, title, project_id, thread_id, version, created_at, updated_at, '' AS document
         FROM canvases WHERE id = ?`,
      )
      .get(id) as CanvasRow | undefined;
    return row === undefined ? null : toMeta(row);
  }

  function getByThread(threadId: string): CanvasMeta | null {
    const row = db
      .prepare(
        `SELECT id, title, project_id, thread_id, version, created_at, updated_at, '' AS document
         FROM canvases WHERE thread_id = ? ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(threadId) as CanvasRow | undefined;
    return row === undefined ? null : toMeta(row);
  }

  function create(input: {
    title: string;
    projectId?: string | null;
    threadId?: string | null;
    document: CanvasDocument;
  }): CanvasMeta {
    const id = `cnv_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const timestamp = now();
    db.prepare(
      `INSERT INTO canvases (id, title, project_id, thread_id, document, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.title,
      input.projectId ?? null,
      input.threadId ?? null,
      JSON.stringify(input.document),
      timestamp,
      timestamp,
    );
    return getMeta(id)!;
  }

  function rename(id: string, title: string): void {
    db.prepare(`UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?`).run(
      title,
      now(),
      id,
    );
  }

  function linkThread(id: string, threadId: string): void {
    db.prepare(`UPDATE canvases SET thread_id = ? WHERE id = ?`).run(
      threadId,
      id,
    );
  }

  function remove(id: string): void {
    db.prepare(`DELETE FROM canvases WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM canvas_ops WHERE canvas_id = ?`).run(id);
    db.prepare(`DELETE FROM checkpoints WHERE canvas_id = ?`).run(id);
  }

  /** Persist a new document version plus its op-log row. Returns the new
   * version, or null when expectedVersion no longer matches. */
  function applyChange(
    id: string,
    change: {
      document: CanvasDocument;
      puts?: DocRecord[];
      removes?: string[];
      fullReplace?: boolean;
      source: string;
      expectedVersion?: number;
    },
  ): number | null {
    const transaction = db.transaction((): number | null => {
      const row = db
        .prepare(`SELECT version FROM canvases WHERE id = ?`)
        .get(id) as { version: number } | undefined;
      if (row === undefined) return null;
      if (
        change.expectedVersion !== undefined &&
        row.version !== change.expectedVersion
      ) {
        return null;
      }
      const version = row.version + 1;
      db.prepare(
        `UPDATE canvases SET document = ?, version = ?, updated_at = ? WHERE id = ?`,
      ).run(JSON.stringify(change.document), version, now(), id);
      db.prepare(
        `INSERT INTO canvas_ops (canvas_id, version, puts, removes, full_replace, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        version,
        change.puts === undefined ? null : JSON.stringify(change.puts),
        change.removes === undefined ? null : JSON.stringify(change.removes),
        change.fullReplace === true ? 1 : 0,
        change.source,
        now(),
      );
      db.prepare(
        `DELETE FROM canvas_ops WHERE canvas_id = ? AND version <= ?`,
      ).run(id, version - OPS_RETAINED);
      return version;
    });
    return transaction();
  }

  /** Ops after sinceVersion. `complete` is false when the log was pruned past
   * sinceVersion, in which case the caller should full-reload. */
  function opsSince(
    id: string,
    sinceVersion: number,
  ): { ops: CanvasOpRow[]; complete: boolean } {
    const rows = db
      .prepare(
        `SELECT version, puts, removes, full_replace, source
         FROM canvas_ops WHERE canvas_id = ? AND version > ? ORDER BY version ASC`,
      )
      .all(id, sinceVersion) as {
      version: number;
      puts: string | null;
      removes: string | null;
      full_replace: number;
      source: string;
    }[];
    const ops = rows.map(
      (row): CanvasOpRow => ({
        version: row.version,
        puts: row.puts === null ? null : (JSON.parse(row.puts) as DocRecord[]),
        removes:
          row.removes === null ? null : (JSON.parse(row.removes) as string[]),
        fullReplace: row.full_replace === 1,
        source: row.source,
      }),
    );
    // Contiguity: every version in (sinceVersion, latest] must be present.
    let complete = true;
    let expected = sinceVersion + 1;
    for (const op of ops) {
      if (op.version !== expected) {
        complete = false;
        break;
      }
      expected += 1;
    }
    return { ops, complete };
  }

  function listCheckpoints(canvasId: string): CheckpointMeta[] {
    const rows = db
      .prepare(
        `SELECT id, canvas_id, name, version, created_at
         FROM checkpoints WHERE canvas_id = ? ORDER BY created_at DESC`,
      )
      .all(canvasId) as {
      id: string;
      canvas_id: string;
      name: string;
      version: number;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      canvasId: row.canvas_id,
      name: row.name,
      version: row.version,
      createdAt: row.created_at,
    }));
  }

  function createCheckpoint(canvasId: string, name: string): CheckpointMeta | null {
    const canvas = get(canvasId);
    if (canvas === null) return null;
    const id = `chk_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    db.prepare(
      `INSERT INTO checkpoints (id, canvas_id, name, document, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      canvasId,
      name,
      JSON.stringify(canvas.document),
      canvas.meta.version,
      now(),
    );
    return listCheckpoints(canvasId).find((c) => c.id === id) ?? null;
  }

  function getCheckpointDocument(
    checkpointId: string,
  ): { canvasId: string; document: CanvasDocument } | null {
    const row = db
      .prepare(`SELECT canvas_id, document FROM checkpoints WHERE id = ?`)
      .get(checkpointId) as
      | { canvas_id: string; document: string }
      | undefined;
    if (row === undefined) return null;
    return {
      canvasId: row.canvas_id,
      document: JSON.parse(row.document) as CanvasDocument,
    };
  }

  return {
    list,
    get,
    getMeta,
    getByThread,
    create,
    rename,
    linkThread,
    remove,
    applyChange,
    opsSince,
    listCheckpoints,
    createCheckpoint,
    getCheckpointDocument,
  };
}

export type CanvasStore = ReturnType<typeof openCanvasStore>;
