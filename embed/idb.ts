import type { KVBackend } from '../core/session-store';

const STORE = 'kv';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Key-value store in IndexedDB; survives reloads and has no 5 MB limit like localStorage. */
export function createIdbBackend(dbName = 'nitpick'): KVBackend {
  let db: Promise<IDBDatabase> | undefined;
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return db;
  };

  return {
    async get(keys) {
      const store = (await open()).transaction(STORE, 'readonly').objectStore(STORE);
      const values = await Promise.all(keys.map((k) => req(store.get(k))));
      const out: Record<string, unknown> = {};
      keys.forEach((k, i) => values[i] !== undefined && (out[k] = values[i]));
      return out;
    },
    async set(items) {
      const tx = (await open()).transaction(STORE, 'readwrite');
      for (const [k, v] of Object.entries(items)) tx.objectStore(STORE).put(v, k);
      await done(tx);
    },
    async remove(keys) {
      const tx = (await open()).transaction(STORE, 'readwrite');
      for (const k of keys) tx.objectStore(STORE).delete(k);
      await done(tx);
    },
    async keys() {
      const store = (await open()).transaction(STORE, 'readonly').objectStore(STORE);
      return (await req(store.getAllKeys())).map(String);
    },
  };
}
