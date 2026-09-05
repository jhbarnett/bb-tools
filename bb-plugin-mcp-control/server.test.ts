import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { harnesses, type Harness, parseDocument } from "./config.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const paths = {
  pi: "/remote/.pi/agent/mcp.json",
  claude: "/remote/.claude.json",
  codex: "/remote/.codex/config.toml",
};
async function fixture(initial: Partial<Record<Harness, string>> = {}) {
  const disk = new Map<string, string>(
    Object.entries(initial).map(([h, text]) => [paths[h as Harness], text]),
  );
  const writes: {
    hostId?: string;
    path: string;
    content: string;
    expectedSha256?: string | null;
    mode?: number;
  }[] = [];
  let conflictPath = "";
  const terminals = new Set<string>();
  const { bb, harness } = createFakePluginHost({
    pluginId: "mcp-control",
    experimental_callHostRpc: async ({ method, hostId }) => {
      assert.equal(hostId, "remote-host");
      assert.equal(method, "inspect");
      return {
        home: "/remote",
        platform: "linux",
        files: Object.fromEntries(
          harnesses.map((h) => [
            h,
            { path: paths[h], exists: disk.has(paths[h]) },
          ]),
        ),
      };
    },
    sdk: {
      hosts: {
        list: async () => [
          { id: "remote-host", name: "Remote", status: "connected" },
        ],
      },
      files: {
        read: async (args: { hostId?: string; path: string }) => {
          assert.equal(args.hostId, "remote-host");
          const content = disk.get(args.path);
          if (content === undefined) throw new Error("not found");
          return {
            content,
            contentEncoding: "utf8",
            sha256: digest(content),
            sizeBytes: Buffer.byteLength(content),
          };
        },
        write: async (args: (typeof writes)[number]) => {
          assert.equal(args.hostId, "remote-host");
          writes.push(args);
          const current = disk.get(args.path);
          if (
            args.path === conflictPath ||
            args.expectedSha256 !==
              (current === undefined ? null : digest(current))
          )
            return {
              outcome: "conflict",
              currentSha256: current === undefined ? null : digest(current),
            };
          disk.set(args.path, args.content);
          return {
            outcome: "written",
            sha256: digest(args.content),
            sizeBytes: Buffer.byteLength(args.content),
          };
        },
      },
      terminals: {
        create: async (args) => {
          assert.equal(args.scope.hostId, "remote-host");
          assert.equal(args.start?.mode, "command");
          assert.match(
            args.start?.mode === "command" ? args.start.command : "",
            /^codex mcp login/,
          );
          terminals.add("login-1");
          return { id: "login-1" };
        },
        close: async ({ terminalId }: { terminalId: string }) => {
          terminals.delete(terminalId);
          return {};
        },
      },
    },
  });
  await plugin(bb);
  return {
    disk,
    writes,
    harness,
    terminals,
    conflict(path: string) {
      conflictPath = path;
    },
  };
}

test("inventory is secret-free; raw entry is fetched only by explicit edit", async () => {
  const f = await fixture({
    pi: JSON.stringify({
      mcpServers: {
        docs: {
          url: "https://example.com/SECRET?token=SECRET",
          bearerToken: "SECRET",
        },
      },
      settings: { apiKey: "SECRET" },
    }),
  });
  try {
    const list = await f.harness.behavior.callRpc("list", {
      hostId: "remote-host",
    });
    assert(!JSON.stringify(list).includes("SECRET"));
    assert(JSON.stringify(list).includes("https://example.com"));
    const edit = await f.harness.behavior.callRpc("edit", {
      hostId: "remote-host",
      name: "docs",
    });
    assert(JSON.stringify(edit).includes("bearerToken"));
    assert(!JSON.stringify(edit).includes("apiKey"));
    assert.equal(f.writes.length, 0);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("save routes to selected host, backs up privately and preserves unrelated settings", async () => {
  const original = '{"theme":"dark","mcpServers":{"keep":{"command":"echo"}}}';
  const f = await fixture({ claude: original });
  try {
    const result = await f.harness.behavior.callRpc("save", {
      hostId: "remote-host",
      name: "docs",
      createOnly: true,
      changes: [
        {
          harness: "claude",
          expectedSha256: digest(original),
          config: '{"type":"http","url":"https://example.com/mcp"}',
        },
      ],
    });
    assert.match(JSON.stringify(result), /"saved":true/);
    assert.equal(f.writes.length, 2);
    assert.equal(f.writes[0].content, original);
    assert.equal(f.writes[0].mode, 0o600);
    assert.equal(f.writes[0].expectedSha256, null);
    assert.match(f.writes[0].path, /\.mcp-control-.*\.bak$/);
    assert.equal(f.writes[1].expectedSha256, digest(original));
    const saved = parseDocument("claude", f.disk.get(paths.claude)!);
    assert.equal(saved.theme, "dark");
    assert.deepEqual(saved.mcpServers, {
      keep: { command: "echo" },
      docs: { type: "http", url: "https://example.com/mcp" },
    });
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("stale revisions, malformed inputs, duplicate targets and add collisions write nothing", async () => {
  const original = '{"mcpServers":{"docs":{"command":"echo"}}}';
  const f = await fixture({ pi: original });
  const base = {
    hostId: "remote-host",
    name: "docs",
    changes: [
      {
        harness: "pi",
        expectedSha256: digest(original),
        config: '{"command":"echo","args":["new"]}',
      },
    ],
  };
  try {
    await assert.rejects(
      f.harness.behavior.callRpc("save", { ...base, createOnly: true }),
    );
    await assert.rejects(
      f.harness.behavior.callRpc("save", {
        ...base,
        changes: [{ ...base.changes[0], expectedSha256: "0".repeat(64) }],
      }),
    );
    await assert.rejects(
      f.harness.behavior.callRpc("save", {
        ...base,
        changes: [
          ...base.changes,
          { harness: "codex", expectedSha256: null, config: "invalid SECRET" },
        ],
      }),
    );
    await assert.rejects(
      f.harness.behavior.callRpc("save", {
        ...base,
        changes: [...base.changes, ...base.changes],
      }),
    );
    assert.equal(f.writes.length, 0);
    assert.equal(f.disk.get(paths.pi), original);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("mid-save CAS conflict reports partial completion and stops remaining writes", async () => {
  const f = await fixture();
  f.conflict(paths.claude);
  try {
    const result = (await f.harness.behavior.callRpc("save", {
      hostId: "remote-host",
      name: "docs",
      changes: harnesses.map((harness) => ({
        harness,
        expectedSha256: null,
        config: '{"url":"https://example.com/mcp"}',
      })),
    })) as { saved: boolean; error: string | null }[];
    assert.deepEqual(
      result.map((r) => r.saved),
      [true, false, false],
    );
    assert.equal(f.disk.has(paths.pi), true);
    assert.equal(f.disk.has(paths.codex), false);
    assert.match(result[2].error!, /Not attempted/);
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("malformed harness is isolated, and removal never replaces the whole file", async () => {
  const original =
    '{"setting":"keep","mcpServers":{"docs":{"command":"echo"},"other":{"command":"echo"}}}';
  const f = await fixture({ pi: "SECRET broken {", claude: original });
  try {
    const list = JSON.stringify(
      await f.harness.behavior.callRpc("list", { hostId: "remote-host" }),
    );
    assert.match(list, /Cannot read or parse Pi/);
    assert(!list.includes("SECRET"));
    await assert.rejects(
      f.harness.behavior.callRpc("save", {
        hostId: "remote-host",
        name: "docs",
        changes: [{ harness: "pi", expectedSha256: null, config: null }],
      }),
    );
    await f.harness.behavior.callRpc("save", {
      hostId: "remote-host",
      name: "docs",
      changes: [
        { harness: "claude", expectedSha256: digest(original), config: null },
      ],
    });
    assert.deepEqual(parseDocument("claude", f.disk.get(paths.claude)!), {
      setting: "keep",
      mcpServers: { other: { command: "echo" } },
    });
  } finally {
    await f.harness.lifecycle.dispose();
  }
});

test("auth rejects unknown terminals and closes its native terminal on disposal", async () => {
  const f = await fixture({
    codex: '[mcp_servers.docs]\nurl="https://example.com/mcp"\n',
  });
  try {
    await assert.rejects(
      f.harness.behavior.callRpc("authInput", {
        terminalId: "someone-elses-terminal",
        data: "command\n",
      }),
    );
    await assert.rejects(
      f.harness.behavior.callRpc("authStart", {
        hostId: "remote-host",
        harness: "codex",
        name: "missing",
      }),
    );
    const result = await f.harness.behavior.callRpc("authStart", {
      hostId: "remote-host",
      harness: "codex",
      name: "docs",
    });
    assert.match(JSON.stringify(result), /login-1/);
    assert.equal(f.terminals.size, 1);
    await assert.rejects(
      f.harness.behavior.callRpc("authStart", {
        hostId: "remote-host",
        harness: "codex",
        name: "docs",
      }),
    );
  } finally {
    await f.harness.lifecycle.dispose();
  }
  assert.equal(f.terminals.size, 0);
});
