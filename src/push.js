// Notifikasi browser "album sudah terbuka". Langganan disimpan di database (save_push),
// lalu Edge Function notify-album mengirimnya saat acara tertutup atau waktu cuci film lewat.
import { supabase, rpc } from "./supabase.js";
import { isIOS, isStandalone } from "./install.js";
import { t } from "./i18n.js";

let vapidKey = null;
export const setVapidKey = (k) => { vapidKey = k || null; };

export function pushSupport() {
  if (!vapidKey) return "off";                              // superadmin belum memasang kunci
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS() && !isStandalone() ? "ios-install" : "unsupported";
  }
  if (Notification.permission === "denied") return "denied";
  return "ok";
}

function keyBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Minta izin dan simpan langganan push perangkat ini
async function subscribePush() {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(t("Izin notifikasi tidak diberikan."));
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) });
  const j = sub.toJSON();
  await rpc("save_push", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent.slice(0, 300) });
}

// Minta izin, berlangganan, dan catat minat pada album acara ini
export async function enableAlbumNotify(eventId) {
  await subscribePush();
  await rpc("watch_album", { p_event: eventId, p_on: true });
}

// "Kabari saya saat dibuka" (pembuatan acara ditutup). Tetap tercatat walau push tidak
// tersedia; mengembalikan true bila notifikasi push aktif.
export async function joinCreationWaitlist() {
  let pushed = false;
  if (pushSupport() === "ok") {
    try { await subscribePush(); pushed = true; } catch { /* tanpa push */ }
  }
  await rpc("join_creation_waitlist", { p_on: true });
  return pushed;
}

export const disableAlbumNotify = (eventId) => rpc("watch_album", { p_event: eventId, p_on: false });
export const albumNotifyOn = (eventId) => rpc("my_album_watch", { p_event: eventId }).catch(() => false);

// Picu pengiriman kabar yang jatuh tempo. Dipanggil saat acara ditutup (force) dan sesekali
// saat aplikasi dibuka, sehingga tidak perlu jadwal server. Aman dipanggil berulang.
export function kickNotify(force = false) {
  if (!supabase || !vapidKey) return;
  const KEY = "notifyKick";
  try {
    const last = Number(localStorage.getItem(KEY) || 0);
    if (!force && Date.now() - last < 10 * 60 * 1000) return;
    localStorage.setItem(KEY, String(Date.now()));
  } catch { /* abaikan */ }
  supabase.functions.invoke("notify-album", { body: {} }).catch(() => {});
}
