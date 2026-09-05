import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract";
import { validateCallback } from "./auth";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async inspect() {
      const home = homedir();
      const paths = {
        pi: join(
          resolve(
            process.env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"),
          ),
          "mcp.json",
        ),
        claude: process.env.CLAUDE_CONFIG_DIR
          ? join(resolve(process.env.CLAUDE_CONFIG_DIR), ".claude.json")
          : join(home, ".claude.json"),
        codex: join(
          resolve(process.env.CODEX_HOME || join(home, ".codex")),
          "config.toml",
        ),
      };
      const file = async (path: string) => {
        try {
          await lstat(path);
          return { path, exists: true };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { path, exists: false };
          throw new Error("Cannot inspect configuration path permissions.");
        }
      };
      return {
        home,
        platform: process.platform,
        files: {
          pi: await file(paths.pi),
          claude: await file(paths.claude),
          codex: await file(paths.codex),
        },
      };
    },
    async callback({ redirectUrl, callbackUrl, state }, context) {
      const url = validateCallback(redirectUrl, callbackUrl, state);
      try {
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(10000)]),
        });
        await response.body?.cancel();
        return { delivered: response.ok };
      } catch {
        throw new Error(
          "Could not deliver the callback to the native login process. Check that it is still running.",
        );
      }
    },
  },
});
