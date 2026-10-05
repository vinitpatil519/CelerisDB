import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const sdk = (file: string) => fileURLToPath(new URL(`../sdks/typescript/src/${file}`, import.meta.url));

// The console uses the TypeScript SDK straight from source.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@celeris\/client\/react$/, replacement: sdk("react.ts") },
      { find: /^@celeris\/client$/, replacement: sdk("index.ts") },
    ],
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
