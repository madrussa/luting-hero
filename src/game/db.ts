// The one IndexedDB connection, shared by everything that persists.
//
// Two stores live in it and both are keyed by a luting's hash: `library` is the
// notation itself — the songs you've added — and `songs` is what happened when
// you played them. They're separate because they have different lifetimes:
// deleting a luting shouldn't have to decide whether your scores go with it.
//
// One module owns the connection because two modules opening the same database
// at different versions deadlock each other: the second `open` blocks waiting
// for the first to close, and neither does.

const DB_NAME = 'luting-hero'
export const SONGS = 'songs'
export const LIBRARY = 'library'
const VERSION = 2

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION)
      req.onupgradeneeded = () => {
        // Additive only: v1 shipped with `songs` alone, and an upgrade must
        // never drop a player's scores to make room for the library.
        for (const name of [SONGS, LIBRARY]) {
          if (!req.result.objectStoreNames.contains(name)) {
            req.result.createObjectStore(name, { keyPath: 'hash' })
          }
        }
      }
      req.onsuccess = () => resolve(req.result)
      // Private browsing and locked-down profiles can refuse IndexedDB
      // outright. Every caller degrades to a no-op rather than throwing:
      // losing the history is survivable, failing to start is not.
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

export function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null)
        try {
          const t = db.transaction(store, mode)
          const req = fn(t.objectStore(store))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
        } catch {
          resolve(null)
        }
      })
  )
}
