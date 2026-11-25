import { defineConfig } from "vite";

// Relative base so the same build works on a web host, inside the iOS/Mac app
// (capacitor://localhost) and inside the Android app (https://localhost).
export default defineConfig({
  base: "./",
  build: { outDir: "dist", target: "es2020", sourcemap: false },
  server: { host: true, port: 5173 },
});
