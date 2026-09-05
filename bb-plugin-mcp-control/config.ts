import {
  parse as parseToml,
  stringify as stringifyToml,
  type TomlTable,
} from "smol-toml";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export const harnesses = ["pi", "claude", "codex"] as const;
export type Harness = (typeof harnesses)[number];
export const labels: Record<Harness, string> = {
  pi: "Pi",
  claude: "Claude Code",
  codex: "Codex",
};
export type Config = Record<string, unknown>;
export const own = (value: object, key: string) => Object.hasOwn(value, key);

export function object(value: unknown): value is Config {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseDocument(harness: Harness, text: string): Config {
  let value: unknown;
  try {
    if (harness === "codex") value = parseToml(text);
    else {
      const errors: ParseError[] = [];
      value = parse(text, errors, {
        allowTrailingComma: false,
        disallowComments: harness === "claude",
      });
      if (errors.length) throw new Error();
    }
  } catch {
    // Parser errors can quote credentials. Never return source snippets over RPC.
    throw new Error(
      `Invalid ${harness === "codex" ? "TOML" : "JSON"} in ${labels[harness]} configuration; repair it before saving.`,
    );
  }
  if (!object(value))
    throw new Error(`${labels[harness]} configuration must be an object.`);
  const key = harness === "codex" ? "mcp_servers" : "mcpServers";
  if (own(value, key) && !object(value[key]))
    throw new Error(`${key} must be an object.`);
  return value;
}

export function servers(document: Config, harness: Harness): Config {
  return (
    (document[harness === "codex" ? "mcp_servers" : "mcpServers"] as
      | Config
      | undefined) ?? {}
  );
}

export function validateConfig(harness: Harness, value: unknown): Config {
  if (!object(value))
    throw new Error(
      `${labels[harness]}: server configuration must be an object.`,
    );
  const c = value;
  const transports = [c.command, c.url, c.socket].filter(
    (v) => v !== undefined,
  );
  if (
    transports.length !== 1 ||
    typeof transports[0] !== "string" ||
    !transports[0].trim()
  ) {
    throw new Error(
      `${labels[harness]}: provide exactly one non-empty command or URL (Pi also supports socket).`,
    );
  }
  if (c.socket !== undefined && harness !== "pi")
    throw new Error("Unix sockets are supported only by Pi.");
  if (typeof c.url === "string") {
    try {
      // Native environment interpolation remains native; validate its URL shape without resolving secrets.
      const url = new URL(
        c.url.replace(
          /\$\{[^}]+\}|\$env:[A-Za-z_][A-Za-z0-9_]*/g,
          "placeholder",
        ),
      );
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error();
    } catch {
      throw new Error(
        `${labels[harness]}: use an HTTP(S) URL without embedded credentials.`,
      );
    }
  }
  if (
    c.args !== undefined &&
    (!Array.isArray(c.args) || c.args.some((v) => typeof v !== "string"))
  )
    throw new Error("args must be an array of strings.");
  for (const key of ["env", "headers", "http_headers", "env_http_headers"]) {
    if (
      c[key] !== undefined &&
      (!object(c[key]) ||
        Object.values(c[key]).some((v) => typeof v !== "string"))
    )
      throw new Error(`${key} must map names to strings.`);
  }
  for (const key of ["disabled", "enabled"])
    if (c[key] !== undefined && typeof c[key] !== "boolean")
      throw new Error(`${key} must be a boolean.`);
  if (harness === "codex" && c.type !== undefined)
    throw new Error(
      "Codex uses command or url, not a type field. Legacy SSE is not supported.",
    );
  if (
    harness === "claude" &&
    c.type !== undefined &&
    !["stdio", "http", "sse"].includes(String(c.type))
  )
    throw new Error("Claude type must be stdio, http, or sse.");
  if (
    harness === "claude" &&
    ((c.command && c.type && c.type !== "stdio") ||
      (c.url && c.type === "stdio"))
  )
    throw new Error("Claude transport type does not match command/url.");
  return c;
}

export function parseEntry(harness: Harness, text: string): Config {
  let c: unknown;
  try {
    c = JSON.parse(text);
  } catch {
    throw new Error(`${labels[harness]}: invalid server JSON.`);
  }
  return validateConfig(harness, c);
}

export function updateDocument(
  harness: Harness,
  text: string,
  name: string,
  config: Config | null,
): string {
  const document = parseDocument(harness, text);
  const key = harness === "codex" ? "mcp_servers" : "mcpServers";
  if (harness === "codex") {
    const entries = { ...servers(document, harness) };
    if (config === null) delete entries[name];
    else
      Object.defineProperty(entries, name, {
        value: config,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    document[key] = entries;
    try {
      return stringifyToml(document as TomlTable);
    } catch {
      throw new Error(
        "Codex configuration cannot be serialized as TOML; no files were changed.",
      );
    }
  }
  return applyEdits(
    text,
    modify(text, [key, name], config === null ? undefined : config, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
}

/** Only portable fields are copied; an existing harness's JSON is never translated. */
export function translate(config: Config, from: Harness, to: Harness): Config {
  if (from === to) return { ...config };
  if (config.socket)
    throw new Error(
      "Pi socket configurations cannot be copied to another harness.",
    );
  if (config.type === "sse" && to === "codex")
    throw new Error(
      "Codex does not support legacy SSE; use a Streamable HTTP endpoint.",
    );
  // Native secret expansion differs: never copy executable/interpolated secrets as literal credentials.
  const secretFields = [
    config.env,
    config.headers,
    config.http_headers,
    config.bearerToken,
  ];
  if (
    secretFields.some((value) =>
      /\$\{|\$env:|"![^!]/.test(JSON.stringify(value) ?? ""),
    ) ||
    config.env_http_headers ||
    config.env_vars ||
    config.oauth ||
    config.http_headers_helper
  ) {
    throw new Error(
      "This entry has harness-specific authentication or environment expansion. Configure the newly selected harness manually; no credentials were translated.",
    );
  }
  const result: Config = {};
  for (const key of ["command", "args", "env", "url"])
    if (own(config, key)) result[key] = config[key];
  if (to === "claude")
    result.type = config.command
      ? "stdio"
      : config.type === "sse"
        ? "sse"
        : "http";
  const headers = config[from === "codex" ? "http_headers" : "headers"];
  if (headers)
    result[to === "codex" ? "http_headers" : "headers"] = {
      ...(headers as Config),
    };
  const tokenEnv =
    config[from === "codex" ? "bearer_token_env_var" : "bearerTokenEnv"];
  if (typeof tokenEnv === "string") {
    if (to === "claude")
      result.headers = {
        ...(result.headers as Config),
        Authorization: `Bearer \${${tokenEnv}}`,
      };
    else
      result[to === "codex" ? "bearer_token_env_var" : "bearerTokenEnv"] =
        tokenEnv;
  }
  if (from === "pi" && typeof config.bearerToken === "string") {
    result[to === "codex" ? "http_headers" : "headers"] = {
      ...(result[to === "codex" ? "http_headers" : "headers"] as Config),
      Authorization: `Bearer ${config.bearerToken}`,
    };
  }
  if (to === "pi" && config.url) result.auth = tokenEnv ? "bearer" : "oauth";
  return validateConfig(to, result);
}

export function enabled(harness: Harness, config: Config): boolean {
  return harness === "pi"
    ? config.disabled !== true
    : harness === "codex"
      ? config.enabled !== false
      : true;
}

export function endpoint(config: Config): string {
  if (typeof config.url === "string") {
    try {
      return new URL(config.url).origin;
    } catch {
      return "HTTP endpoint (environment reference)";
    }
  }
  // Commands/arguments/URL paths may contain credentials; inventory deliberately hides them.
  return config.socket
    ? "Unix socket"
    : config.command
      ? "Local command · stdio"
      : "Override / unsupported entry";
}
