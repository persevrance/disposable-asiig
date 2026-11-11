// Zoom foto di dalam sebuah "stage": cubit dua jari, ketuk/klik dua kali, roda mouse,
// geser saat diperbesar, dan geser kiri/kanan untuk pindah foto saat ukuran normal.
// Stage harus ber-CSS touch-action: none supaya browser (terutama Safari iOS) tidak
// memperbesar seluruh halaman, dan position: relative supaya posisi foto bisa diukur.
//
// attachZoom(stage, img, { onSwipe(dir) }) -> { reset(), measure(), scale(), destroy() }

const MAX_ZOOM = 4;
const TAP_MS = 320;

export function attachZoom(stage, img, { onSwipe } = {}) {
  let s = 1, L = 0, T = 0;                 // skala + posisi kiri-atas foto di dalam stage
  let base = { x: 0, y: 0, w: 0, h: 0 };   // posisi dan ukuran foto tanpa zoom

  function measure() {
    base = { x: img.offsetLeft, y: img.offsetTop, w: img.offsetWidth, h: img.offsetHeight };
  }
  // Foto tidak boleh tergeser sampai ada celah kosong; jika lebih kecil dari stage, ditengahkan
  function clampPos() {
    const W = stage.clientWidth, H = stage.clientHeight, w = base.w * s, h = base.h * s;
    L = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, L));
    T = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, T));
  }
  function apply(anim = false) {
    clampPos();
    img.classList.toggle("anim", anim);
    img.style.transform = s === 1 ? "" : `translate(${L - base.x}px, ${T - base.y}px) scale(${s})`;
    stage.classList.toggle("zoomed", s > 1);
  }
  // Ubah skala dengan titik (px, py) di stage tetap di bawah jari / kursor
  function zoomAt(ns, px, py, anim = false) {
    if (!base.w) measure();
    if (s === 1) { L = base.x; T = base.y; }
    const ux = (px - L) / s, uy = (py - T) / s;
    s = Math.min(MAX_ZOOM, Math.max(1, ns));
    L = px - s * ux; T = py - s * uy;
    apply(anim);
  }
  function reset() { s = 1; apply(); }

  const pts = new Map();                   // pointer (jari / mouse) yang sedang menekan
  let start = null, lastTap = 0, lastTapAt = null, moved = false;
  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  function snapshot() {
    const p = [...pts.values()];
    if (p.length >= 2) {
      const [a, b] = p;
      start = {
        pinch: true, d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s,
        L: s === 1 ? base.x : L, T: s === 1 ? base.y : T,
      };
    } else if (p.length === 1) {
      start = { pinch: false, x: p[0].x, y: p[0].y, L, T };
    } else start = null;
  }

  function onDown(e) {
    if (e.button > 0) return;              // hanya klik kiri / sentuhan
    e.preventDefault();                    // cegah seret gambar dan seleksi teks
    try { stage.setPointerCapture(e.pointerId); } catch { /* abaikan */ }
    if (!base.w) measure();
    pts.set(e.pointerId, local(e));
    if (pts.size === 1) moved = false;
    snapshot();
  }
  function onMove(e) {
    if (!pts.has(e.pointerId) || !start) return;
    pts.set(e.pointerId, local(e));
    const p = [...pts.values()];
    if (start.pinch && p.length >= 2) {
      // Cubit: skala mengikuti jarak dua jari, titik tengahnya ikut menggeser foto
      const [a, b] = p;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ux = (start.mx - start.L) / start.s, uy = (start.my - start.T) / start.s;
      s = Math.min(MAX_ZOOM, Math.max(1, start.s * (d / start.d)));
      L = mx - s * ux; T = my - s * uy;
      moved = true;
      apply();
    } else if (!start.pinch && p.length === 1) {
      const dx = p[0].x - start.x, dy = p[0].y - start.y;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
      if (s > 1) { L = start.L + dx; T = start.T + dy; apply(); }
    }
  }
  function onUp(e) {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    const single = start && !start.pinch && pts.size === 1;
    const sx = start?.x, sy = start?.y;
    pts.delete(e.pointerId);
    if (single && e.type === "pointerup") {
      const dx = p.x - sx, dy = p.y - sy;
      // Geser kiri/kanan saat ukuran normal: pindah foto
      if (s === 1 && onSwipe && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        start = null;
        onSwipe(dx < 0 ? 1 : -1);
        return;
      }
      // Ketuk dua kali di tempat yang berdekatan: perbesar 2,5× di titik itu, atau kembali normal
      if (!moved) {
        const now = Date.now();
        const near = lastTapAt && Math.hypot(p.x - lastTapAt.x, p.y - lastTapAt.y) < 40;
        if (now - lastTap < TAP_MS && near) {
          lastTap = 0;
          if (s > 1) { s = 1; apply(true); } else zoomAt(2.5, p.x, p.y, true);
        } else { lastTap = now; lastTapAt = p; }
      }
    }
    snapshot(); // jari yang tersisa melanjutkan geser dari posisi sekarang
  }
  // Laptop: roda mouse, atau cubit touchpad (wheel + ctrlKey), di posisi kursor
  function onWheel(e) {
    e.preventDefault();
    const p = local(e);
    zoomAt(s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  }
  // Safari: cegah gestur zoom halaman bawaan
  const stopGesture = (e) => e.preventDefault();
  const onResize = () => { measure(); apply(); };

  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove);
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("gesturestart", stopGesture);
  stage.addEventListener("gesturechange", stopGesture);
  stage.addEventListener("dragstart", stopGesture);
  window.addEventListener("resize", onResize);

  return {
    reset,
    measure() { measure(); s = 1; apply(); },
    scale: () => s,
    destroy() { window.removeEventListener("resize", onResize); },
  };
}
