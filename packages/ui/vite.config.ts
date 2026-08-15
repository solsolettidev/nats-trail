import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Keep only the woff2 source in the bundled icon fonts.
 *
 * The icon package declares five formats per weight for the sake of very old
 * browsers, and the bundler faithfully emits all of them — the SVG fonts alone
 * are 10 MB. woff2 has been supported everywhere for a decade, and this product
 * is served from a container someone has to ship into their own network.
 */
function woff2Only(): Plugin {
  return {
    name: "phosphor-woff2-only",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@phosphor-icons") || !id.endsWith(".css")) return null;
      const trimmed = code.replace(
        /src:\s*([^;]*?);/gs,
        (match, sources: string) => {
          const woff2 = sources
            .split(",")
            .map((entry) => entry.trim())
            .find((entry) => entry.includes("woff2"));
          return woff2 ? `src: ${woff2};` : match;
        },
      );
      return { code: trimmed, map: null };
    },
  };
}

export default defineConfig({
  plugins: [woff2Only(), react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4000", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:4000", ws: true },
    },
  },
});
