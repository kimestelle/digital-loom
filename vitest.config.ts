import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Browser journeys belong to Playwright; importing them in Vitest makes
    // Playwright intentionally reject test.describe at collection time.
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});
