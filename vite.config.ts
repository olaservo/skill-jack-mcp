import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

const INPUT = process.env.INPUT || "mcp-app.html";

const isDevelopment = process.env.NODE_ENV === "development";

export default defineConfig({
  root: "src/ui",
  plugins: [viteSingleFile()],
  build: {
    sourcemap: isDevelopment ? "inline" : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,
    rollupOptions: {
      input: path.resolve(__dirname, "src/ui", INPUT),
    },
    outDir: path.resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
  },
});
