/**
 * Loaded before every test file (vitest setupFiles). Automated tests must stay
 * offline: any real fetch() to a non-loopback host fails the test loudly.
 * Tests inject their own mocked fetch for Google; only the in-process HTTP
 * servers used by remote.test.ts (127.0.0.1) are reachable.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`Unexpected network request in an offline test: ${url.origin}${url.pathname}`);
  }
  return realFetch(input, init);
}) as typeof fetch;
