import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: {
    __PLUGIN_NAME__: JSON.stringify(pkg.name),
  },
  build: {
    ssr: "src/index.ts",
  },
});
