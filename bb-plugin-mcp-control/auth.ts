import type { Harness } from "./config";

export function authCommand(
  harness: Harness,
  name: string,
): { command: string; instruction: string } {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(name))
    throw new Error("Invalid server name.");
  if (harness === "pi")
    return {
      command: "pi --no-session",
      instruction: `In Pi, run /mcp-auth ${name}. pi-mcp-adapter must already be installed. For remote OAuth, its auth-start/auth-complete flow supports pasted redirect URLs.`,
    };
  if (harness === "claude")
    return {
      command: `claude mcp login --no-browser '${name}'`,
      instruction:
        "Open the authorization URL, then paste the full redirect URL into the terminal when prompted. Requires Claude Code with mcp login support.",
    };
  return {
    command: `codex mcp login '${name}'`,
    instruction:
      "Open the authorization URL. If the browser redirects to an unreachable localhost page, paste its full address into the callback field below. Credentials remain in Codex's native store.",
  };
}

/** Extract only the native CLI's OAuth request, never an arbitrary user-supplied relay target. */
export function findCallback(
  output: string,
): { callbackUrl: string; state: string } | null {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const raw of plain.match(/https?:\/\/[^\s<>"']+/g) ?? []) {
    try {
      const url = new URL(raw);
      const state = url.searchParams.get("state");
      const callbackUrl = url.searchParams.get("redirect_uri");
      if (!state || !callbackUrl) continue;
      const callback = new URL(callbackUrl);
      if (
        callback.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(callback.hostname) &&
        !callback.username &&
        !callback.password
      )
        return { callbackUrl, state };
    } catch {
      /* A terminal chunk can end mid-URL. */
    }
  }
  return null;
}

export function validateCallback(
  redirectUrl: string,
  callbackUrl: string,
  state: string,
): URL {
  let actual: URL, expected: URL;
  try {
    actual = new URL(redirectUrl);
    expected = new URL(callbackUrl);
  } catch {
    throw new Error(
      "Paste the complete callback URL from the browser address bar.",
    );
  }
  if (
    expected.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(expected.hostname) ||
    expected.username ||
    expected.password ||
    actual.username ||
    actual.password ||
    actual.origin !== expected.origin ||
    actual.pathname !== expected.pathname ||
    actual.hash ||
    actual.searchParams.getAll("state").length !== 1 ||
    actual.searchParams.get("state") !== state ||
    (!actual.searchParams.has("code") && !actual.searchParams.has("error"))
  ) {
    throw new Error(
      "Callback does not match this login's loopback address and OAuth state.",
    );
  }
  for (const [key, value] of expected.searchParams)
    if (actual.searchParams.get(key) !== value)
      throw new Error("Callback parameters do not match this login.");
  return actual;
}
