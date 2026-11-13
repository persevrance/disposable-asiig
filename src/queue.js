// Antrean potretan di IndexedDB: foto disimpan di HP dulu, baru dikirim.
import { createStore, get, set, del, keys } from "idb-keyval";

const store = createStore("disposable-asiig", "antrean");

export const queue = {
  put: (job) => set(job.id, job, store),
  get: (id) => get(id, store),
  delete: (id) => del(id, store),
  ids: () => keys(store),
  async forEvent(eventId) {
    const all = await Promise.all((await keys(store)).map((k) => get(k, store)));
    return all.filter((j) => j && j.eventId === eventId);
  },
};
