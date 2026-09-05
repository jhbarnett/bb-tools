export interface RecordLike {
  id: string;
}

export interface RecordDiff<T extends RecordLike = RecordLike> {
  added: Record<string, T>;
  updated: Record<string, [from: T, to: T]>;
  removed: Record<string, T>;
}

export interface SerializedDelta<T extends RecordLike = RecordLike> {
  puts: T[];
  removes: string[];
}

export interface PendingChanges<T extends RecordLike = RecordLike> {
  puts: Map<string, T>;
  removes: Set<string>;
}

export interface CanvasChangedSignal {
  canvasId: string;
  version: number;
  source: string;
  clientId?: string;
}

export function createPendingChanges<
  T extends RecordLike = RecordLike,
>(): PendingChanges<T> {
  return { puts: new Map(), removes: new Set() };
}

export function mergeDelta<T extends RecordLike>(
  pending: PendingChanges<T>,
  delta: SerializedDelta<T>,
): void {
  for (const id of delta.removes) {
    pending.puts.delete(id);
    pending.removes.add(id);
  }
  for (const record of delta.puts) {
    pending.removes.delete(record.id);
    pending.puts.set(record.id, record);
  }
}

export function mergeRecordDiff<T extends RecordLike>(
  pending: PendingChanges<T>,
  diff: RecordDiff<T>,
): void {
  mergeDelta(pending, {
    puts: [
      ...Object.values(diff.added),
      ...Object.values(diff.updated).map(([, to]) => to),
    ],
    removes: Object.keys(diff.removed),
  });
}

export function takePendingChanges<T extends RecordLike>(
  pending: PendingChanges<T>,
): SerializedDelta<T> {
  const delta = {
    puts: [...pending.puts.values()],
    removes: [...pending.removes],
  };
  pending.puts.clear();
  pending.removes.clear();
  return delta;
}

export function hasPendingChanges(pending: PendingChanges): boolean {
  return pending.puts.size > 0 || pending.removes.size > 0;
}

export function shouldApplyCanvasSignal(
  signal: CanvasChangedSignal,
  current: { canvasId: string; version: number; clientId: string },
): boolean {
  return (
    signal.canvasId === current.canvasId &&
    signal.version > current.version &&
    signal.clientId !== current.clientId
  );
}
