// Saat `npm run dev`, Worker situs (API foto R2 /api/r2/* dan pembayaran /api/pay/*) tidak ikut
// berjalan, jadi permintaan /api/* diteruskan ke Worker yang sudah ter-deploy. Database Supabase-nya
// sama, dan hak akses tetap dicek Worker memakai sesi login yang sama.
// Ganti tujuan lewat VITE_API_PROXY di .env (mis. http://localhost:8787 untuk `npx wrangler dev`).
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_PROXY || "https://titippotret.my.id";
  return {
    server: {
      proxy: {
        "/api": { target, changeOrigin: true, secure: true },
      },
    },
  };
});
