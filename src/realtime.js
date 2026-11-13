// Album realtime: kanal broadcast Supabase per acara. Setelah foto terkonfirmasi atau acara
// ditutup, aplikasi mengirim "ping"; album yang terbuka langsung memuat ulang. Isi foto tetap
// diambil lewat get_album (aturan akses di database), jadi ping tidak membawa data.
import { supabase } from "./supabase.js";

const channels = new Map(); // eventId -> { ch, ready, listeners:Set }

// Acara di atas 150 tamu tanpa realtime: koneksi serentak tetap di bawah batas paket Supabase
// (Free 200, Pro 500; dibagi semua acara yang berjalan). Album acara besar memakai polling
// berjeda acak (album.js). Sama dengan angka di capacity_meters (supabase/v2.sql).
export const REALTIME_MAX = 150;
const large = new Set();
export function noteEventSize(eventId, maxMembers) {
  if ((maxMembers || 0) > REALTIME_MAX) large.add(eventId); else large.delete(eventId);
}

function channel(eventId) {
  let c = channels.get(eventId);
  if (c) return c;
  c = { ready: false, listeners: new Set() };
  c.ch = supabase.channel(`album:${eventId}`, { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "ping" }, (msg) => c.listeners.forEach((fn) => fn(msg.payload || {})))
    .subscribe((state) => { c.ready = state === "SUBSCRIBED"; c.listeners.forEach((fn) => fn({ state })); });
  channels.set(eventId, c);
  return c;
}

// Dengarkan ping; fn({ kind }) untuk ping, fn({ state }) saat status sambungan berubah.
export function onAlbumPing(eventId, fn) {
  if (!supabase || large.has(eventId)) return () => {};
  const c = channel(eventId);
  c.listeners.add(fn);
  return () => {
    c.listeners.delete(fn);
    if (!c.listeners.size) { supabase.removeChannel(c.ch); channels.delete(eventId); }
  };
}
export const albumLive = (eventId) => Boolean(channels.get(eventId)?.ready);

// Kirim ping (tanpa menunggu); dipakai setelah jepretan terkirim atau acara ditutup
export function pingAlbum(eventId, kind = "photo") {
  if (!supabase || large.has(eventId)) return;
  const c = channel(eventId);
  const send = () => c.ch.send({ type: "broadcast", event: "ping", payload: { kind } }).catch(() => {});
  if (c.ready) send(); else setTimeout(send, 1500);
  // Kanal yang dibuka hanya untuk mengirim ditutup lagi setelah beberapa detik
  if (!c.listeners.size) setTimeout(() => { if (!c.listeners.size && channels.get(eventId) === c) { supabase.removeChannel(c.ch); channels.delete(eventId); } }, 8000);
}
