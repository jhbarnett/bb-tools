import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";

export function TldrawLicenseRequired({ rejected = false }: { rejected?: boolean }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-5 text-card-foreground shadow-sm">
        <div className="flex items-start gap-3">
          <Icon name="Lock" className="mt-0.5 size-5 shrink-0 text-primary" />
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">
              {rejected ? "tldraw rejected this license" : "tldraw license required"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {rejected
                ? "The configured key is invalid, expired, or does not cover this host. Update it under Extensions → Plugins → Canvas."
                : "tldraw requires a valid SDK license key on HTTPS and production hosts. Add a key under Extensions → Plugins → Canvas, then reopen this canvas."}{" "}
              License keys are public and restricted by domain.
            </p>
            <UrlLink
              href="https://tldraw.dev/sdk-features/license-key"
              className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Review tldraw licensing options
            </UrlLink>
          </div>
        </div>
      </div>
    </div>
  );
}
