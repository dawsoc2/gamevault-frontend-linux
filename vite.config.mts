import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    watch: {
      // Rust build artifacts under src-tauri/target churn constantly during
      // `tauri dev`, and on Windows the .dll files get locked mid-compile,
      // which makes Vite's recursive watcher throw `EBUSY`. Tauri watches and
      // rebuilds itself, so Vite never needs to see anything under src-tauri.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Acknowledges the larger vendor/analytics bundles produced by rolldown.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|react-router|react-router-dom)/,
            },
            { name: "motion", test: /node_modules[\\/]motion/ },
            { name: "heroicons", test: /node_modules[\\/]@heroicons/ },
            { name: "swetrix", test: /node_modules[\\/]swetrix/ },
          ],
        },
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(
      process.env.GV_BUILD_VERSION || pkg.version,
    ),
    __BUILD_COMMIT__: JSON.stringify(process.env.GV_BUILD_COMMIT || "unknown"),
    __BUILD_CHANNEL__: JSON.stringify(
      process.env.GV_BUILD_CHANNEL ||
        (process.env.GV_BUILD_VERSION ? "ci" : "dev"),
    ),
  },
});
