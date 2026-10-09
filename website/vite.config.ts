import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative base: the site works from a domain root or from a sub-path such as
// https://user.github.io/CelerisDB/. Two pages: the landing page and /docs/.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5174 },
  preview: { port: 4174 },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        docs: resolve(__dirname, "docs/index.html"),
      },
    },
  },
});
