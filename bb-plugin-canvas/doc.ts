// Server-side tldraw document engine. Pure logic over the serialized tldraw
// store format — no DOM, no editor. All record construction is validated
// against @tldraw/tlschema before it is persisted, so a bad operation becomes
// a tool error instead of a corrupt canvas.
import {
  DocumentRecordType,
  PageRecordType,
  createBindingId,
  createShapeId,
  createTLSchema,
  toRichText,
} from "@tldraw/tlschema";
import { getIndexAbove, type IndexKey } from "@tldraw/utils";
import { z } from "zod";

/** A serialized record as stored in the document (id + typeName + fields). */
export interface DocRecord {
  id: string;
  typeName: string;
  [key: string]: unknown;
}

/** The persisted document: the "document" half of a tldraw snapshot. */
export interface CanvasDocument {
  store: Record<string, DocRecord>;
  schema: unknown;
}

const schema = createTLSchema();

export class CanvasOpError extends Error {}

// ---------------------------------------------------------------------------
// Operation schema (agent-facing). Friendly ids: agents use bare ids like
// "hero" or "cta-button"; we store them as "shape:<id>".
// ---------------------------------------------------------------------------

const friendlyId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const colorSchema = z.enum([
  "black",
  "grey",
  "light-violet",
  "violet",
  "blue",
  "light-blue",
  "yellow",
  "orange",
  "green",
  "light-green",
  "light-red",
  "red",
]);
const fillSchema = z.enum(["none", "semi", "solid", "pattern"]);
const geoKinds = [
  "rectangle",
  "ellipse",
  "triangle",
  "diamond",
  "hexagon",
  "oval",
  "cloud",
  "star",
  "x-box",
  "check-box",
] as const;
const shapeKindSchema = z.enum([...geoKinds, "text", "note", "frame"]);
const pointSchema = z.object({ x: z.number(), y: z.number() });

export const operationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("create_shape"),
      id: friendlyId.optional(),
      shape: shapeKindSchema,
      x: z.number(),
      y: z.number(),
      w: z.number().positive().max(20000).optional(),
      h: z.number().positive().max(20000).optional(),
      text: z.string().max(4000).optional(),
      color: colorSchema.optional(),
      fill: fillSchema.optional(),
      parentId: friendlyId.optional(),
      align: z.enum(["start", "middle", "end"]).optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("update_shape"),
      id: friendlyId,
      x: z.number().optional(),
      y: z.number().optional(),
      w: z.number().positive().max(20000).optional(),
      h: z.number().positive().max(20000).optional(),
      text: z.string().max(4000).optional(),
      color: colorSchema.optional(),
      fill: fillSchema.optional(),
      parentId: friendlyId.nullable().optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete_shapes"),
      ids: z.array(friendlyId).min(1).max(200),
    })
    .strict(),
  z
    .object({
      op: z.literal("create_arrow"),
      id: friendlyId.optional(),
      fromId: friendlyId.optional(),
      toId: friendlyId.optional(),
      fromPoint: pointSchema.optional(),
      toPoint: pointSchema.optional(),
      text: z.string().max(400).optional(),
      color: colorSchema.optional(),
    })
    .strict(),
  z
    .object({
      op: z.literal("create_page"),
      name: z.string().min(1).max(80),
    })
    .strict(),
]);
export type CanvasOperation = z.infer<typeof operationSchema>;

// ---------------------------------------------------------------------------
// Document construction
// ---------------------------------------------------------------------------

export function createEmptyDocument(): CanvasDocument {
  const document = DocumentRecordType.create({
    id: "document:document" as never,
  });
  const page = PageRecordType.create({
    id: PageRecordType.createId("page"),
    name: "Page 1",
    index: "a1" as IndexKey,
  });
  return {
    store: {
      [document.id]: document as unknown as DocRecord,
      [page.id]: page as unknown as DocRecord,
    },
    schema: schema.serialize(),
  };
}

function richTextToPlain(richText: unknown): string {
  const lines: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as { type?: string; text?: string; content?: unknown[] };
    if (record.type === "text" && typeof record.text === "string") {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + record.text;
    }
    if (Array.isArray(record.content)) {
      for (const child of record.content) {
        if ((child as { type?: string }).type === "paragraph") lines.push("");
        walk(child);
      }
    }
  };
  walk(richText);
  return lines.join("\n").trim();
}

const shapeIdOf = (ref: string): string =>
  ref.startsWith("shape:") ? ref : `shape:${ref}`;
const shortId = (id: string): string => id.replace(/^[a-z_]+:/, "");

interface ShapeRecord extends DocRecord {
  typeName: "shape";
  type: string;
  x: number;
  y: number;
  rotation: number;
  parentId: string;
  index: string;
  isLocked: boolean;
  opacity: number;
  meta: Record<string, unknown>;
  props: Record<string, unknown>;
}

function isShape(record: DocRecord): record is ShapeRecord {
  return record.typeName === "shape";
}

function pagesOf(store: Record<string, DocRecord>): DocRecord[] {
  return Object.values(store)
    .filter((record) => record.typeName === "page")
    .sort((a, b) => String(a.index).localeCompare(String(b.index)));
}

/** Resolve a page by id, short id, or name (case-insensitive). */
export function resolvePage(
  document: CanvasDocument,
  page: string | undefined,
): DocRecord {
  const pages = pagesOf(document.store);
  if (pages.length === 0) throw new CanvasOpError("Document has no pages.");
  if (page === undefined) return pages[0]!;
  const match = pages.find(
    (candidate) =>
      candidate.id === page ||
      shortId(candidate.id) === page ||
      String(candidate.name).toLowerCase() === page.toLowerCase(),
  );
  if (match === undefined) {
    throw new CanvasOpError(
      `No page "${page}". Pages: ${pages.map((p) => String(p.name)).join(", ")}`,
    );
  }
  return match;
}

function nextShapeIndex(
  store: Record<string, DocRecord>,
  parentId: string,
): IndexKey {
  let max: IndexKey | null = null;
  for (const record of Object.values(store)) {
    if (!isShape(record) || record.parentId !== parentId) continue;
    const index = record.index as IndexKey;
    if (max === null || index > max) max = index;
  }
  return max === null ? ("a1" as IndexKey) : getIndexAbove(max);
}

/** Absolute page coordinates of a shape's top-left (walking frame parents). */
function pagePointOf(
  store: Record<string, DocRecord>,
  shape: ShapeRecord,
): { x: number; y: number } {
  let x = shape.x;
  let y = shape.y;
  let parentId = shape.parentId;
  let guard = 0;
  while (parentId.startsWith("shape:") && guard < 32) {
    const parent = store[parentId];
    if (parent === undefined || !isShape(parent)) break;
    x += parent.x;
    y += parent.y;
    parentId = parent.parentId;
    guard += 1;
  }
  return { x, y };
}

function sizeOf(shape: ShapeRecord): { w: number; h: number } {
  const props = shape.props;
  const w = typeof props.w === "number" ? props.w : 100;
  const h = typeof props.h === "number" ? props.h : 100;
  if (shape.type === "note") return { w: 200, h: 200 };
  return { w, h };
}

// Complete, schema-valid prop templates for tldraw 5.3 (validated in tests).
function geoProps(op: {
  shape: string;
  w?: number;
  h?: number;
  text?: string;
  color?: string;
  fill?: string;
  align?: string;
}): Record<string, unknown> {
  return {
    geo: op.shape,
    dash: "draw",
    url: "",
    w: op.w ?? 160,
    h: op.h ?? 100,
    growY: 0,
    scale: 1,
    flipX: false,
    flipY: false,
    labelColor: op.color ?? "black",
    color: op.color ?? "black",
    fill: op.fill ?? "none",
    size: "m",
    font: "draw",
    align: op.align ?? "middle",
    verticalAlign: "middle",
    richText: toRichText(op.text ?? ""),
  };
}

function textProps(op: {
  w?: number;
  text?: string;
  color?: string;
  align?: string;
}): Record<string, unknown> {
  return {
    color: op.color ?? "black",
    size: "m",
    font: "draw",
    textAlign: op.align ?? "start",
    w: op.w ?? 240,
    richText: toRichText(op.text ?? ""),
    scale: 1,
    autoSize: false,
  };
}

function noteProps(op: {
  text?: string;
  color?: string;
  align?: string;
}): Record<string, unknown> {
  return {
    color: op.color ?? "yellow",
    labelColor: "black",
    size: "m",
    font: "draw",
    fontSizeAdjustment: 0,
    align: op.align ?? "middle",
    verticalAlign: "middle",
    growY: 0,
    url: "",
    richText: toRichText(op.text ?? ""),
    scale: 1,
    textLastEditedBy: "",
  };
}

function frameProps(op: {
  w?: number;
  h?: number;
  text?: string;
  color?: string;
}): Record<string, unknown> {
  return {
    w: op.w ?? 400,
    h: op.h ?? 720,
    name: op.text ?? "Frame",
    color: op.color ?? "black",
  };
}

function arrowProps(op: {
  text?: string;
  color?: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
}): Record<string, unknown> {
  return {
    kind: "arc",
    labelColor: op.color ?? "black",
    color: op.color ?? "black",
    fill: "none",
    dash: "draw",
    size: "m",
    arrowheadStart: "none",
    arrowheadEnd: "arrow",
    font: "draw",
    start: op.start,
    end: op.end,
    bend: 0,
    richText: toRichText(op.text ?? ""),
    labelPosition: 0.5,
    scale: 1,
    elbowMidPoint: 0.5,
  };
}

function validateRecord(record: DocRecord): void {
  const type = schema.types[record.typeName as keyof typeof schema.types];
  if (type === undefined) {
    throw new CanvasOpError(`Unknown record typeName "${record.typeName}"`);
  }
  try {
    (type as { validate(record: unknown): unknown }).validate(record);
  } catch (cause) {
    throw new CanvasOpError(
      `Invalid ${record.typeName} record ${record.id}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export interface ApplyResult {
  document: CanvasDocument;
  puts: DocRecord[];
  removes: string[];
  summary: string[];
}

export function applyOperations(
  document: CanvasDocument,
  operations: CanvasOperation[],
  page?: string,
): ApplyResult {
  const store: Record<string, DocRecord> = { ...document.store };
  const targetPage = resolvePage(document, page);
  const puts = new Map<string, DocRecord>();
  const removes = new Set<string>();
  const summary: string[] = [];

  const put = (record: DocRecord): void => {
    validateRecord(record);
    store[record.id] = record;
    puts.set(record.id, record);
    removes.delete(record.id);
  };
  const requireShape = (ref: string): ShapeRecord => {
    const record = store[shapeIdOf(ref)];
    if (record === undefined || !isShape(record)) {
      throw new CanvasOpError(
        `No shape "${ref}" on this canvas. Use canvas_read to list shapes.`,
      );
    }
    return record;
  };
  const resolveParent = (parentRef: string | undefined): string => {
    if (parentRef === undefined) return targetPage.id;
    const parent = requireShape(parentRef);
    if (parent.type !== "frame") {
      throw new CanvasOpError(
        `parentId "${parentRef}" is a ${parent.type}; only frames can contain shapes.`,
      );
    }
    return parent.id;
  };
  const freshShapeId = (ref: string | undefined, kind: string): string => {
    const id = ref !== undefined ? shapeIdOf(ref) : createShapeId();
    if (store[id] !== undefined) {
      throw new CanvasOpError(
        `Shape id "${shortId(id)}" already exists; pick a new id or update_shape it.`,
      );
    }
    void kind;
    return id;
  };

  for (const op of operations) {
    switch (op.op) {
      case "create_shape": {
        const id = freshShapeId(op.id, op.shape);
        const parentId = resolveParent(op.parentId);
        const type =
          op.shape === "text" || op.shape === "note" || op.shape === "frame"
            ? op.shape
            : "geo";
        const props =
          type === "geo"
            ? geoProps(op)
            : type === "text"
              ? textProps(op)
              : type === "note"
                ? noteProps(op)
                : frameProps(op);
        put({
          id,
          typeName: "shape",
          type,
          x: op.x,
          y: op.y,
          rotation: 0,
          parentId,
          index: nextShapeIndex(store, parentId),
          isLocked: false,
          opacity: 1,
          meta: {},
          props,
        } satisfies ShapeRecord);
        summary.push(`created ${op.shape} "${shortId(id)}"`);
        break;
      }
      case "update_shape": {
        const shape = requireShape(op.id);
        const props = { ...shape.props };
        if (op.w !== undefined && "w" in props) props.w = op.w;
        if (op.h !== undefined && "h" in props) props.h = op.h;
        if (op.color !== undefined) {
          if ("color" in props) props.color = op.color;
          if ("labelColor" in props) props.labelColor = op.color;
        }
        if (op.fill !== undefined && "fill" in props) props.fill = op.fill;
        if (op.text !== undefined) {
          if (shape.type === "frame") props.name = op.text;
          else if ("richText" in props) props.richText = toRichText(op.text);
        }
        const next: ShapeRecord = {
          ...shape,
          x: op.x ?? shape.x,
          y: op.y ?? shape.y,
          props,
        };
        if (op.parentId !== undefined) {
          const parentId =
            op.parentId === null ? targetPage.id : resolveParent(op.parentId);
          if (parentId !== shape.parentId) {
            next.parentId = parentId;
            next.index = nextShapeIndex(store, parentId);
          }
        }
        put(next);
        summary.push(`updated "${op.id}"`);
        break;
      }
      case "delete_shapes": {
        const doomed = new Set<string>();
        const visit = (id: string): void => {
          if (doomed.has(id)) return;
          doomed.add(id);
          for (const record of Object.values(store)) {
            if (isShape(record) && record.parentId === id) visit(record.id);
          }
        };
        for (const ref of op.ids) visit(requireShape(ref).id);
        for (const record of Object.values(store)) {
          if (record.typeName !== "binding") continue;
          const binding = record as DocRecord & { fromId?: string; toId?: string };
          if (
            (binding.fromId !== undefined && doomed.has(binding.fromId)) ||
            (binding.toId !== undefined && doomed.has(binding.toId))
          ) {
            doomed.add(record.id);
          }
        }
        for (const id of doomed) {
          delete store[id];
          puts.delete(id);
          removes.add(id);
        }
        summary.push(`deleted ${doomed.size} record(s)`);
        break;
      }
      case "create_arrow": {
        if (op.fromId === undefined && op.fromPoint === undefined) {
          throw new CanvasOpError("create_arrow needs fromId or fromPoint.");
        }
        if (op.toId === undefined && op.toPoint === undefined) {
          throw new CanvasOpError("create_arrow needs toId or toPoint.");
        }
        const centerOf = (ref: string): { x: number; y: number } => {
          const shape = requireShape(ref);
          const point = pagePointOf(store, shape);
          const size = sizeOf(shape);
          return { x: point.x + size.w / 2, y: point.y + size.h / 2 };
        };
        const from = op.fromId !== undefined ? centerOf(op.fromId) : op.fromPoint!;
        const to = op.toId !== undefined ? centerOf(op.toId) : op.toPoint!;
        const arrowId = freshShapeId(op.id, "arrow");
        put({
          id: arrowId,
          typeName: "shape",
          type: "arrow",
          x: from.x,
          y: from.y,
          rotation: 0,
          parentId: targetPage.id,
          index: nextShapeIndex(store, targetPage.id),
          isLocked: false,
          opacity: 1,
          meta: {},
          props: arrowProps({
            text: op.text,
            color: op.color,
            start: { x: 0, y: 0 },
            end: { x: to.x - from.x, y: to.y - from.y },
          }),
        } satisfies ShapeRecord);
        const bind = (terminal: "start" | "end", targetRef: string): void => {
          put({
            id: createBindingId(),
            typeName: "binding",
            type: "arrow",
            fromId: arrowId,
            toId: shapeIdOf(targetRef),
            meta: {},
            props: {
              terminal,
              normalizedAnchor: { x: 0.5, y: 0.5 },
              isExact: false,
              isPrecise: false,
              snap: "none",
            },
          });
        };
        if (op.fromId !== undefined) bind("start", op.fromId);
        if (op.toId !== undefined) bind("end", op.toId);
        summary.push(`created arrow "${shortId(arrowId)}"`);
        break;
      }
      case "create_page": {
        const pages = pagesOf(store);
        const last = pages[pages.length - 1];
        const index =
          last === undefined
            ? ("a1" as IndexKey)
            : getIndexAbove(last.index as IndexKey);
        const pageRecord = PageRecordType.create({
          name: op.name,
          index,
        });
        put(pageRecord as unknown as DocRecord);
        summary.push(`created page "${op.name}" (${shortId(pageRecord.id)})`);
        break;
      }
    }
  }

  return {
    document: { store, schema: document.schema },
    puts: [...puts.values()],
    removes: [...removes],
    summary,
  };
}

// ---------------------------------------------------------------------------
// Simplified read model for agents
// ---------------------------------------------------------------------------

export interface SimplifiedShape {
  id: string;
  type: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  text?: string;
  parent?: string;
  color?: string;
  fill?: string;
  from?: string;
  to?: string;
  fromPoint?: { x: number; y: number };
  toPoint?: { x: number; y: number };
}

export interface SimplifiedDocument {
  pages: { id: string; name: string; shapes: SimplifiedShape[] }[];
}

export function simplifyDocument(document: CanvasDocument): SimplifiedDocument {
  const store = document.store;
  const bindingsByArrow = new Map<
    string,
    { terminal: string; toId: string }[]
  >();
  for (const record of Object.values(store)) {
    if (record.typeName !== "binding") continue;
    const binding = record as DocRecord & {
      fromId: string;
      toId: string;
      props: { terminal?: string };
    };
    const list = bindingsByArrow.get(binding.fromId) ?? [];
    list.push({ terminal: binding.props?.terminal ?? "", toId: binding.toId });
    bindingsByArrow.set(binding.fromId, list);
  }

  const shapesByParent = new Map<string, ShapeRecord[]>();
  for (const record of Object.values(store)) {
    if (!isShape(record)) continue;
    const list = shapesByParent.get(record.parentId) ?? [];
    list.push(record);
    shapesByParent.set(record.parentId, list);
  }
  const collect = (parentId: string, out: ShapeRecord[]): void => {
    const children = (shapesByParent.get(parentId) ?? []).sort((a, b) =>
      String(a.index).localeCompare(String(b.index)),
    );
    for (const child of children) {
      out.push(child);
      collect(child.id, out);
    }
  };

  const round = (value: number): number => Math.round(value * 10) / 10;
  const simplifyShape = (shape: ShapeRecord): SimplifiedShape => {
    const props = shape.props;
    const entry: SimplifiedShape = {
      id: shortId(shape.id),
      type: shape.type === "geo" ? String(props.geo ?? "geo") : shape.type,
      x: round(shape.x),
      y: round(shape.y),
    };
    if (typeof props.w === "number") entry.w = round(props.w);
    if (typeof props.h === "number") entry.h = round(props.h);
    if (shape.parentId.startsWith("shape:")) {
      entry.parent = shortId(shape.parentId);
    }
    const text =
      shape.type === "frame"
        ? String(props.name ?? "")
        : "richText" in props
          ? richTextToPlain(props.richText)
          : "";
    if (text !== "") entry.text = text;
    if (typeof props.color === "string" && props.color !== "black") {
      entry.color = props.color;
    }
    if (typeof props.fill === "string" && props.fill !== "none") {
      entry.fill = props.fill;
    }
    if (shape.type === "arrow") {
      const bindings = bindingsByArrow.get(shape.id) ?? [];
      for (const binding of bindings) {
        if (binding.terminal === "start") entry.from = shortId(binding.toId);
        if (binding.terminal === "end") entry.to = shortId(binding.toId);
      }
      const start = props.start as { x: number; y: number } | undefined;
      const end = props.end as { x: number; y: number } | undefined;
      if (entry.from === undefined && start !== undefined) {
        entry.fromPoint = { x: round(shape.x + start.x), y: round(shape.y + start.y) };
      }
      if (entry.to === undefined && end !== undefined) {
        entry.toPoint = { x: round(shape.x + end.x), y: round(shape.y + end.y) };
      }
      delete entry.w;
      delete entry.h;
    }
    return entry;
  };

  return {
    pages: pagesOf(store).map((page) => {
      const shapes: ShapeRecord[] = [];
      collect(page.id, shapes);
      return {
        id: shortId(page.id),
        name: String(page.name),
        shapes: shapes.map(simplifyShape),
      };
    }),
  };
}
