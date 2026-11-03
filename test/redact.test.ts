import { afterEach, describe, expect, it, vi } from "vitest";
import { log, redact, redactString } from "../src/redact.js";
import { errorToToolPayload, ApiError } from "../src/errors.js";

describe("redaction", () => {
  it("redacts Google tokens, client secrets and API keys in strings", () => {
    const s =
      "Authorization: Bearer ya29.a0AfH6SMBx-secret refresh=1//0gABCDEFGHIJKLMNOPQRSTUVWXYZ secret=GOCSPX-abc123_DEF key AIzaSyA1234567890abcdefghijklmnopqrstu";
    const out = redactString(s);
    expect(out).not.toContain("a0AfH6SMBx");
    expect(out).not.toContain("0gABCDEFGHIJ");
    expect(out).not.toContain("abc123_DEF");
    expect(out).not.toContain("SyA1234567890");
  });

  it("redacts form-encoded and JSON secret fields", () => {
    expect(redactString("code=4/abc&code_verifier=xyz&client_id=ok")).toBe("code=[REDACTED]&code_verifier=[REDACTED]&client_id=ok");
    expect(redactString('{"refresh_token":"r","access_token":"a","x":"y"}')).toBe('{"refresh_token":"[REDACTED]","access_token":"[REDACTED]","x":"y"}');
  });

  it("redacts sensitive keys in nested objects without mutating input", () => {
    const input = { a: 1, nested: { refresh_token: "1//zzzzzzzzzzzzzzzzzzzzzzzz", ok: "ya29.leak" }, list: [{ client_secret: "s" }] };
    const out = redact(input);
    expect(out).toEqual({ a: 1, nested: { refresh_token: "[REDACTED]", ok: "ya29.[REDACTED]" }, list: [{ client_secret: "[REDACTED]" }] });
    expect(input.nested.refresh_token).toBe("1//zzzzzzzzzzzzzzzzzzzzzzzz");
  });

  it("error payloads shown to the model never include tokens", () => {
    const p = errorToToolPayload(new ApiError("failed with Bearer ya29.secretvalue", 500));
    expect(JSON.stringify(p)).not.toContain("secretvalue");
    expect(JSON.stringify(errorToToolPayload(new Error("x ya29.zzz")))).not.toContain("zzz");
  });
});

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks());
  it("writes to stderr (never stdout) and redacts", () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    log.warn("token ya29.SECRET", { access_token: "abc" });
    expect(out).not.toHaveBeenCalled();
    const line = String(err.mock.calls[0]?.[0]);
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain("abc");
  });
});
