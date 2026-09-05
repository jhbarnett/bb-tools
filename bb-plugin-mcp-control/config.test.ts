import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDocument,
  parseEntry,
  updateDocument,
  translate,
  enabled,
  endpoint,
} from "./config.js";
import { authCommand, findCallback, validateCallback } from "./auth.js";

test("JSON patch preserves unrelated settings, comments, and credentials", () => {
  const text =
    '{\n  // personal settings\n  "settings": { "secret": "keep" },\n  "mcpServers": { "other": { "command": "echo" } }\n}\n';
  const added = updateDocument("pi", text, "name.with.dots", {
    url: "https://example.com/mcp",
  });
  assert.match(added, /\/\/ personal settings/);
  assert.match(added, /"settings": \{ "secret": "keep" \}/);
  assert.deepEqual(parseDocument("pi", added).mcpServers, {
    other: { command: "echo" },
    "name.with.dots": { url: "https://example.com/mcp" },
  });
  const removed = parseDocument(
    "pi",
    updateDocument("pi", added, "name.with.dots", null),
  );
  assert.deepEqual(removed.mcpServers, { other: { command: "echo" } });
});

test("TOML round-trip preserves unrelated typed values and dotted names", () => {
  const text =
    'model = "my-model"\nstarted = 2025-01-01T00:00:00Z\n[profiles.safe]\nmodel = "safe-model"\n[mcp_servers.other]\ncommand = "echo"\n[mcp_servers."a.b"]\nurl = "https://old.example/mcp"\n';
  const original = parseDocument("codex", text);
  const changed = parseDocument(
    "codex",
    updateDocument("codex", text, "a.b", {
      url: "https://new.example/mcp",
      enabled: false,
      http_headers: { Authorization: "keep" },
    }),
  );
  assert.equal(changed.model, original.model);
  assert.deepEqual(changed.profiles, original.profiles);
  assert.deepEqual(changed.started, original.started);
  assert.deepEqual((changed.mcp_servers as Record<string, unknown>).other, {
    command: "echo",
  });
  assert.deepEqual((changed.mcp_servers as Record<string, unknown>)["a.b"], {
    url: "https://new.example/mcp",
    enabled: false,
    http_headers: { Authorization: "keep" },
  });
});

test("invalid documents and transport fields fail closed without quoting secrets", () => {
  for (const harness of ["pi", "claude", "codex"] as const) {
    assert.throws(
      () => parseDocument(harness, "TOP_SECRET invalid {"),
      (e) => e instanceof Error && !e.message.includes("TOP_SECRET"),
    );
    assert.throws(() => parseEntry(harness, "[]"));
    assert.throws(() =>
      parseEntry(harness, '{"url":"https://example.com","command":"echo"}'),
    );
    assert.throws(() => parseEntry(harness, '{"url":"file:///etc/passwd"}'));
    assert.throws(() =>
      parseEntry(harness, '{"url":"https://name:secret@example.com"}'),
    );
    assert.throws(() => parseEntry(harness, '{"command":"echo","args":[4]}'));
    assert.throws(() =>
      parseEntry(harness, '{"command":"echo","env":{"TOKEN":4}}'),
    );
  }
  assert.throws(() => parseDocument("claude", '{"mcpServers": []}'));
  assert.throws(() =>
    parseEntry("codex", '{"type":"sse","url":"https://example.com"}'),
  );
  assert.throws(() =>
    parseEntry("claude", '{"type":"stdio","url":"https://example.com"}'),
  );
});

test("portable translations preserve bearer environment references; refuse unsafe assumptions", () => {
  const pi = {
    url: "https://example.com/mcp",
    auth: "bearer",
    bearerTokenEnv: "TOKEN",
    directTools: true,
  };
  assert.deepEqual(translate(pi, "pi", "codex"), {
    url: pi.url,
    bearer_token_env_var: "TOKEN",
  });
  assert.deepEqual(translate(pi, "pi", "claude"), {
    type: "http",
    url: pi.url,
    headers: { Authorization: "Bearer ${TOKEN}" },
  });
  assert.throws(() => translate({ socket: "/tmp/mcp" }, "pi", "codex"));
  assert.throws(() =>
    translate({ url: pi.url, type: "sse" }, "claude", "codex"),
  );
  assert.throws(() =>
    translate({ url: pi.url, bearerToken: "!get-secret" }, "pi", "claude"),
  );
  assert.throws(() =>
    translate(
      { url: pi.url, headers: { Authorization: "${TOKEN}" } },
      "pi",
      "codex",
    ),
  );
  assert.equal(enabled("pi", { disabled: true }), false);
  assert.equal(enabled("codex", { enabled: false }), false);
  assert.equal(enabled("claude", {}), true);
  assert.equal(
    endpoint({ url: "https://example.com/secret?token=secret" }),
    "https://example.com",
  );
  assert.equal(
    endpoint({ command: "echo SECRET", args: ["SECRET"] }),
    "Local command · stdio",
  );
});

test("native auth command cannot interpolate shell metacharacters", () => {
  assert.throws(() => authCommand("codex", "$(touch pwned)"));
  assert.throws(() => authCommand("claude", "--help"));
  assert.equal(
    authCommand("claude", "example").command,
    "claude mcp login --no-browser 'example'",
  );
  assert.equal(authCommand("pi", "example").command, "pi --no-session");
});

test("remote callback relay binds exact loopback origin, path, and state", () => {
  const callbackUrl = "http://localhost:4321/callback";
  const authorization = `https://auth.example/authorize?state=nonce&redirect_uri=${encodeURIComponent(callbackUrl)}`;
  assert.deepEqual(findCallback(`Open browser:\n${authorization}\n`), {
    callbackUrl,
    state: "nonce",
  });
  assert.equal(
    findCallback(
      "https://auth.example/?state=n&redirect_uri=https%3A%2F%2Fevil.example",
    ),
    null,
  );
  assert.equal(
    validateCallback(
      `${callbackUrl}?state=nonce&code=secret`,
      callbackUrl,
      "nonce",
    ).hostname,
    "localhost",
  );
  for (const url of [
    `${callbackUrl}?state=wrong&code=secret`,
    `${callbackUrl}?state=nonce&state=other&code=x`,
    "http://localhost:4322/callback?state=nonce&code=x",
    "http://localhost:4321/admin?state=nonce&code=x",
    "http://localhost.evil.example:4321/callback?state=nonce&code=x",
    "http://user:pass@localhost:4321/callback?state=nonce&code=x",
    "file:///etc/passwd",
    `${callbackUrl}?state=nonce`,
    `${callbackUrl}?state=nonce&code=x#fragment`,
  ])
    assert.throws(() => validateCallback(url, callbackUrl, "nonce"));
});
