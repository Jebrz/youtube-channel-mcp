import { defineConfig } from "vitest/config";

// Only mocked unit tests run here. Live validation against real Google APIs is a
// separate, opt-in step (`npm run live-check`) and is never part of `npm test`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/networkGuard.ts"],
    environment: "node",
  },
});
