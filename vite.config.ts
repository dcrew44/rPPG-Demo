/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// `base` must match the GitHub Pages project-site path
// (https://<user>.github.io/rPPG-Demo/).
export default defineConfig({
  base: "/rPPG-Demo/",
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
