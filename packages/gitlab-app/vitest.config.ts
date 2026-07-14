import { defineConfig } from "vitest/config";

// gitlab-app is provider-neutral fetch code — its tests mock gitlab.com/api/v4
// with MSW and run under plain Node + Vitest (no Workers pool). Mirrors
// github-app's test posture.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
