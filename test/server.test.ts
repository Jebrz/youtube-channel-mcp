import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server.js";
import { channelResponse, googleError, json, makeDeps, mockFetch } from "./helpers.js";

beforeEach(() => void vi.spyOn(process.stderr, "write").mockImplementation(() => true));
afterEach(() => vi.restoreAllMocks());

async function connect(fetchImpl: ReturnType<typeof mockFetch>) {
  const server = createServer(makeDeps(fetchImpl));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe("MCP server (in-memory transport, mocked Google APIs)", () => {
  it("exposes exactly the six read-only tools", async () => {
    const client = await connect(mockFetch());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_channel_analytics", "get_channel_overview", "get_dashboard", "get_video_analytics", "get_video_details", "list_videos"].sort(),
    );
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
    }
  });

  it("returns tool results as JSON text", async () => {
    const client = await connect(mockFetch((u) => (u.pathname.endsWith("/channels") ? json(200, channelResponse()) : undefined)));
    const res = await client.callTool({ name: "get_channel_overview", arguments: {} });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text);
    expect(body.channel.title).toBe("Test Channel");
  });

  it("returns structured, secret-free errors with isError", async () => {
    const client = await connect(mockFetch(() => googleError(403, "quotaExceeded", "quota exhausted for Bearer ya29.leak")));
    const res = await client.callTool({ name: "list_videos", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(JSON.parse(text).error.code).toBe("QUOTA_EXCEEDED");
    expect(text).not.toContain("ya29.leak");
  });

  it("validates tool input schemas", async () => {
    const client = await connect(mockFetch());
    const res = await client.callTool({ name: "get_channel_analytics", arguments: { report: "not_a_report" } });
    expect(res.isError).toBe(true);
  });
});
