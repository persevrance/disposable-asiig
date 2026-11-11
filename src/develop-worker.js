// Web Worker: menjalankan pengolahan foto (efek film, kompres) di luar thread utama
// supaya layar tidak membeku saat memotret.
import { develop, offscreenEnv } from "./develop.js";

self.onmessage = async (e) => {
  const { id, bitmap, opts, stamp } = e.data;
  try {
    const out = await develop(offscreenEnv, bitmap, bitmap.width, bitmap.height, opts, stamp);
    bitmap.close?.();
    stamp?.image?.close?.();
    self.postMessage({ id, ok: true, ...out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
};
