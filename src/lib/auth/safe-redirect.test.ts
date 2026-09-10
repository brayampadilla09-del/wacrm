import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-redirect";

describe("safeNext", () => {
  it("passes through a same-origin absolute path", () => {
    expect(safeNext("/reset-password")).toBe("/reset-password");
    expect(safeNext("/settings?tab=profile")).toBe("/settings?tab=profile");
  });

  it("falls back when null", () => {
    expect(safeNext(null)).toBe("/dashboard");
    expect(safeNext(null, "/login")).toBe("/login");
  });

  it("rejects a bare hostname or scheme", () => {
    expect(safeNext("evil.example")).toBe("/dashboard");
    expect(safeNext("https://evil.example")).toBe("/dashboard");
    expect(safeNext("javascript:alert(1)")).toBe("/dashboard");
  });

  it("rejects a protocol-relative host", () => {
    expect(safeNext("//evil.example")).toBe("/dashboard");
    expect(safeNext("///evil.example")).toBe("/dashboard");
  });

  it("rejects a backslash host (browser path-normalization escape)", () => {
    expect(safeNext("/" + "\\" + "evil.example")).toBe("/dashboard");
  });
});
