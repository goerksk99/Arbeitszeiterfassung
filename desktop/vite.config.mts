import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const desktopRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "NEXT_PUBLIC_");
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Für das Windows-Paket ist eine HTTPS-Supabase-Projekt-URL erforderlich.");
  }
  if (!env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_")) {
    throw new Error("Für das Windows-Paket ist der öffentliche Supabase Publishable Key erforderlich.");
  }

  return {
    root: desktopRoot,
    envDir: projectRoot,
    envPrefix: "NEXT_PUBLIC_SUPABASE_",
    base: "./",
    plugins: [
      tailwindcss(),
      {
        name: "desktop-content-security-policy",
        transformIndexHtml(html) {
          return html.replaceAll("__SUPABASE_ORIGIN__", url.origin);
        },
      },
    ],
    build: { outDir: fileURLToPath(new URL("../.desktop/renderer", import.meta.url)), emptyOutDir: true },
  };
});
