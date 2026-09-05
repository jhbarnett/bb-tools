import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const harnessSchema = z.enum(["pi", "claude", "codex"]);
export const nameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/,
    "Use letters, numbers, underscores, dots, or hyphens; do not start with a hyphen.",
  );
export const hostIdSchema = z.string().min(1).max(200);
const fileSchema = z.object({ path: z.string(), exists: z.boolean() });
export const hostContract = defineRpcContract({
  inspect: {
    input: z.null(),
    output: z.object({
      platform: z.string(),
      home: z.string(),
      files: z.object({
        pi: fileSchema,
        claude: fileSchema,
        codex: fileSchema,
      }),
    }),
  },
  callback: {
    input: z
      .object({
        redirectUrl: z.string().max(16384),
        callbackUrl: z.string().max(4096),
        state: z.string().min(1).max(4096),
      })
      .strict(),
    output: z.object({ delivered: z.boolean() }),
  },
});

const target = z.object({ hostId: hostIdSchema });
const entryTarget = target.extend({ name: nameSchema });
const revision = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const changeSchema = z
  .object({
    harness: harnessSchema,
    expectedSha256: revision,
    config: z.string().max(65536).nullable(),
  })
  .strict();
const configFileSchema = z.object({
  harness: harnessSchema,
  path: z.string(),
  sha256: revision,
  error: z.string().nullable(),
});
const presenceSchema = z.object({
  harness: harnessSchema,
  enabled: z.boolean(),
  endpoint: z.string(),
  editable: z.boolean(),
});
export const rpcContract = defineRpcContract({
  hosts: {
    input: z.null(),
    output: z.array(
      z.object({ id: z.string(), name: z.string(), connected: z.boolean() }),
    ),
  },
  list: {
    input: target.strict(),
    output: z.object({
      files: z.array(configFileSchema),
      entries: z.array(
        z.object({ name: z.string(), harnesses: z.array(presenceSchema) }),
      ),
    }),
  },
  edit: {
    input: entryTarget.strict(),
    output: z.array(configFileSchema.extend({ config: z.string().nullable() })),
  },
  save: {
    input: entryTarget
      .extend({
        createOnly: z.boolean().default(false),
        changes: z.array(changeSchema).min(1).max(3),
      })
      .strict(),
    output: z.array(
      z.object({
        harness: harnessSchema,
        saved: z.boolean(),
        error: z.string().nullable(),
        backupPath: z.string().nullable(),
      }),
    ),
  },
  authStart: {
    input: entryTarget.extend({ harness: harnessSchema }).strict(),
    output: z.object({
      terminalId: z.string(),
      command: z.string(),
      instruction: z.string(),
    }),
  },
  authRead: {
    input: z
      .object({
        terminalId: z.string(),
        sinceSeq: z.number().int().nonnegative(),
      })
      .strict(),
    output: z.object({
      chunks: z.array(z.object({ dataBase64: z.string(), seq: z.number() })),
      nextSeq: z.number(),
      truncated: z.boolean(),
      status: z.string(),
      exitCode: z.number().nullable(),
      canRelay: z.boolean(),
    }),
  },
  authInput: {
    input: z
      .object({ terminalId: z.string(), data: z.string().max(16384) })
      .strict(),
    output: z.null(),
  },
  authResize: {
    input: z
      .object({
        terminalId: z.string(),
        cols: z.number().int().min(20).max(400),
        rows: z.number().int().min(5).max(200),
      })
      .strict(),
    output: z.null(),
  },
  authCallback: {
    input: z
      .object({ terminalId: z.string(), redirectUrl: z.string().max(16384) })
      .strict(),
    output: z.object({ delivered: z.boolean() }),
  },
  authClose: {
    input: z.object({ terminalId: z.string() }).strict(),
    output: z.null(),
  },
});
export type Inventory = z.infer<(typeof rpcContract)["list"]["output"]>;
export type EditorFiles = z.infer<(typeof rpcContract)["edit"]["output"]>;
export type SaveInput = z.infer<(typeof rpcContract)["save"]["input"]>;
