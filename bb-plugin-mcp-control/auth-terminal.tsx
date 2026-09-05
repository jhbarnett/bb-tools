import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { rpcContract } from "./contract.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import "@xterm/xterm/css/xterm.css";

export function AuthTerminal({
  login,
  onClose,
}: {
  login: { terminalId: string; command: string; instruction: string };
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Starting login…");
  const [error, setError] = useState("");
  const [canRelay, setCanRelay] = useState(false);
  const [redirect, setRedirect] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let sequence = 0;
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 2000,
      fontSize: 13,
      allowProposedApi: false,
      screenReaderMode: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(
      new WebLinksAddon((_event, url) => {
        if (/^https?:\/\//i.test(url)) navigate.openUrl(url);
      }),
    );
    term.open(container.current!);
    const report = () => {
      if (!disposed)
        setError(
          "Login terminal disconnected. Close it and retry authentication.",
        );
    };
    const resize = () => {
      if (disposed || !container.current?.clientWidth) return;
      fit.fit();
      void rpc
        .call("authResize", {
          terminalId: login.terminalId,
          cols: Math.max(20, Math.min(400, term.cols)),
          rows: Math.max(5, Math.min(200, term.rows)),
        })
        .catch(report);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    // Keep pasted input and individual keypresses ordered across network latency.
    let input = Promise.resolve();
    const subscription = term.onData((data) => {
      for (let offset = 0; offset < data.length; offset += 8192) {
        const chunk = data.slice(offset, offset + 8192);
        input = input
          .then(async () => {
            if (!disposed)
              await rpc.call("authInput", {
                terminalId: login.terminalId,
                data: chunk,
              });
          })
          .catch(report);
      }
    });
    async function poll() {
      try {
        const result = await rpc.call("authRead", {
          terminalId: login.terminalId,
          sinceSeq: sequence,
        });
        if (disposed) return;
        for (const chunk of result.chunks)
          term.write(
            Uint8Array.from(atob(chunk.dataBase64), (c) => c.charCodeAt(0)),
          );
        sequence = result.nextSeq;
        setCanRelay(result.canRelay);
        setStatus(
          result.status === "exited"
            ? `Login process exited (${result.exitCode ?? "unknown"}). Read the terminal result; exit alone is not proof of authentication.`
            : "Native login terminal · expires after 15 minutes",
        );
        if (result.truncated)
          setError(
            "Some terminal output was truncated. Close and retry if the authorization URL is missing.",
          );
        if (result.status !== "exited" && result.status !== "disconnected")
          timer = setTimeout(() => void poll(), 500);
      } catch {
        report();
      }
    }
    resize();
    term.focus();
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      subscription.dispose();
      term.dispose();
      void rpc
        .call("authClose", { terminalId: login.terminalId })
        .catch(() => {});
    };
  }, [login.terminalId, rpc, navigate]);
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      aria-label="MCP authentication terminal"
    >
      <div className="flex items-center justify-between gap-3">
        <strong>Authenticate</strong>
        <Button variant="outline" onClick={onClose}>
          Close login
        </Button>
      </div>
      <code className="block text-xs">{login.command}</code>
      <p className="text-sm text-muted-foreground">{login.instruction}</p>
      <p className="text-xs text-muted-foreground">
        This is a real terminal on the selected machine. Do not share
        authorization links or codes. No credentials are sent to an agent.
      </p>
      <div
        ref={container}
        className="h-96 overflow-hidden rounded border border-border"
        aria-label="Interactive login terminal"
      />
      <p role="status" className="text-xs text-muted-foreground">
        {status}
      </p>
      {canRelay && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            setSending(true);
            setError("");
            try {
              const result = await rpc.call("authCallback", {
                terminalId: login.terminalId,
                redirectUrl: redirect,
              });
              if (!result.delivered)
                throw new Error(
                  "The native login listener rejected the callback. Check terminal output.",
                );
              setRedirect("");
              setCanRelay(false);
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Callback delivery failed.",
              );
            } finally {
              setSending(false);
            }
          }}
        >
          <Input
            className="min-w-48 flex-1"
            aria-label="Full OAuth callback URL"
            type="password"
            autoComplete="off"
            placeholder="Paste the full localhost redirect URL"
            value={redirect}
            onChange={(e) => setRedirect(e.target.value)}
          />
          <Button disabled={sending || !redirect.trim()}>
            Complete remote login
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
