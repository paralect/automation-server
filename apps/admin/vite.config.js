import { defineConfig, loadEnv } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(({ mode }) => {
    // Server functions read process.env; Vite only exposes VITE_* to import.meta.env.
    for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) {
        process.env[key] ??= value;
    }
    return {
        resolve: { tsconfigPaths: true },
        plugins: [tailwindcss(), tanstackStart(), viteReact()],
    };
});
