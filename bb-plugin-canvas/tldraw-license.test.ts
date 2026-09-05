import { describe, expect, it } from "vitest";
import { resolveTldrawLicenseKey } from "./tldraw-license";

describe("tldraw licensing", () => {
  it("does not mount the production SDK for missing or blank keys", () => {
    expect(resolveTldrawLicenseKey(undefined)).toBeUndefined();
    expect(resolveTldrawLicenseKey(123)).toBeUndefined();
    expect(resolveTldrawLicenseKey("")).toBeUndefined();
    expect(resolveTldrawLicenseKey("   ")).toBeUndefined();
  });

  it("trims and forwards a configured public key", () => {
    expect(resolveTldrawLicenseKey("  tldraw-example  ")).toBe(
      "tldraw-example",
    );
  });
});
