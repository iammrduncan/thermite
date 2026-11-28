import { lucideIcons } from "@iammrduncan/magnesium/vite/lucide-icons";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const control = process.env.THERMITE_CONTROL_URL ?? "http://127.0.0.1:8800";

export default defineConfig({
  plugins: [react(), tailwindcss(), lucideIcons()],
  optimizeDeps: {
    exclude: ["lucide-react"],
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": control,
      "/nats": { target: control, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
