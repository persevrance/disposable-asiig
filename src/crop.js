// Crop manual untuk sampul undangan (dan gambar lain). Pointer events menangani
// mouse dan sentuh. Mengembalikan Promise<Blob|null>: Blob JPEG yang sudah dipotong,
// atau null bila dibatalkan / gagal dibaca.
import { modal } from "./ui.js";

// Rasio pita sampul pada kartu undangan (420 × 120); crop selalu memakai rasio ini
const CARD = 7 / 2;
const MIN = 44;        // ukuran minimal kotak crop (px di layar)
const MAX_SIDE = 1600; // sisi terpanjang hasil, sama dengan sampul yang diunggah
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function openCrop(file) {
  return new Promise((resolve) => {
    const objUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = build;
    img.onerror = () => { URL.revokeObjectURL(objUrl); resolve(null); };
    img.src = objUrl;

    function build() {
      let done = false;
      const finish = (val) => { if (done) return; done = true; resolve(val); };

      const ratio = CARD;
      let box = { x: 0, y: 0, w: 0, h: 0 };
      let scale = 1, offX = 0, offY = 0, drag = null;

      const { box: root, close } = modal(`
        <div class="crop">
          <h3>Crop sampul</h3>
          <div class="crop-stage">
            <img class="crop-img" alt="" draggable="false" />
            <div class="crop-box" aria-label="Area crop"><i data-h="nw"></i><i data-h="ne"></i><i data-h="sw"></i><i data-h="se"></i></div>
          </div>
          <div class="crop-actions">
            <button type="button" class="btn ghost" data-act="cancel">Batal</button>
            <button type="button" class="btn primary" data-act="ok">Gunakan</button>
          </div>
        </div>`, {
        wide: true,
        onClose: () => { window.removeEventListener("resize", measure); URL.revokeObjectURL(objUrl); finish(null); },
      });

      const stageEl = root.querySelector(".crop-stage");
      const imgEl = root.querySelector(".crop-img");
      const boxEl = root.querySelector(".crop-box");
      imgEl.src = objUrl;

      function measure() {
        const stageW = stageEl.clientWidth;
        const stageH = Math.min(window.innerHeight * 0.55, Math.max(240, Math.round(stageW * 0.6)));
        stageEl.style.height = stageH + "px";
        scale = Math.min(stageW / img.naturalWidth, stageH / img.naturalHeight);
        const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
        offX = (stageW - dw) / 2;
        offY = (stageH - dh) / 2;
        imgEl.style.width = dw + "px";
        imgEl.style.height = dh + "px";
        imgEl.style.left = offX + "px";
        imgEl.style.top = offY + "px";
        if (box.w) resetBox();
      }

      function apply() {
        boxEl.style.left = box.x + "px";
        boxEl.style.top = box.y + "px";
        boxEl.style.width = box.w + "px";
        boxEl.style.height = box.h + "px";
      }

      function resetBox() {
        let w = img.naturalWidth * scale * 0.9, h = img.naturalHeight * scale * 0.9;
        if (ratio > 0) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
        box = {
          x: offX + (img.naturalWidth * scale - w) / 2,
          y: offY + (img.naturalHeight * scale - h) / 2,
          w, h,
        };
        apply();
      }

      // ---- interaksi geser & ubah ukuran ----
      const pos = (e) => { const r = stageEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

      function moveTo(px, py) {
        box.x = clamp(px - box.w / 2, offX, offX + img.naturalWidth * scale - box.w);
        box.y = clamp(py - box.h / 2, offY, offY + img.naturalHeight * scale - box.h);
        apply();
      }

      function resizeTo(fx, fy, px, py) {
        let x = Math.min(fx, px), y = Math.min(fy, py);
        let w = Math.max(fx, px) - x, h = Math.max(fy, py) - y;
        w = Math.max(MIN, w); h = Math.max(MIN, h);
        if (ratio > 0) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
        if (px < fx) x = fx - w;
        if (py < fy) y = fy - h;
        w = Math.min(w, img.naturalWidth * scale);
        h = Math.min(h, img.naturalHeight * scale);
        if (ratio > 0) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
        x = clamp(x, offX, offX + img.naturalWidth * scale - w);
        y = clamp(y, offY, offY + img.naturalHeight * scale - h);
        box = { x, y, w, h };
        apply();
      }

      stageEl.addEventListener("pointerdown", (e) => {
        const p = pos(e);
        const h = e.target.closest("[data-h]");
        if (h) {
          drag = {
            kind: "resize",
            fx: h.dataset.h.includes("e") ? box.x : box.x + box.w,
            fy: h.dataset.h.includes("s") ? box.y : box.y + box.h,
          };
        } else if (e.target.closest(".crop-box")) {
          drag = { kind: "move", dx: box.x - p.x, dy: box.y - p.y };
        } else {
          return;
        }
        e.preventDefault();
        stageEl.setPointerCapture(e.pointerId);
      });
      stageEl.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const p = pos(e);
        if (drag.kind === "move") moveTo(p.x + drag.dx, p.y + drag.dy);
        else resizeTo(drag.fx, drag.fy, p.x, p.y);
      });
      const endDrag = () => { drag = null; };
      stageEl.addEventListener("pointerup", endDrag);
      stageEl.addEventListener("pointercancel", endDrag);

      // ---- aksi ----
      root.querySelector('[data-act="cancel"]').onclick = close;
      root.querySelector('[data-act="ok"]').onclick = () => {
        const sx = (box.x - offX) / scale, sy = (box.y - offY) / scale;
        const sw = box.w / scale, sh = box.h / scale;
        const outScale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(sw * outScale));
        c.height = Math.max(1, Math.round(sh * outScale));
        const ctx = c.getContext("2d");
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        c.toBlob((b) => { finish(b); close(); }, "image/jpeg", 0.9);
      };

      measure();
      window.addEventListener("resize", measure);
    }
  });
}
