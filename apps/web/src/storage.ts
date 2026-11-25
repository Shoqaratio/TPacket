/** Local persistence in IndexedDB: always written first, so work survives offline and crashes. */

export interface StoredProject {
  id: string;
  name: string;
  doc: unknown;
  updatedAt: number;
  cloudId?: string;
  cloudVersion?: number;
  /** Student working copy of an assignment. */
  assignmentId?: string;
}

const DB = 'netlab';
const STORE = 'projects';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const storage = {
  list: () => tx<StoredProject[]>('readonly', (s) => s.getAll()).then((xs) => xs.sort((a, b) => b.updatedAt - a.updatedAt)),
  get: (id: string) => tx<StoredProject | undefined>('readonly', (s) => s.get(id)),
  put: (p: StoredProject) => tx('readwrite', (s) => s.put(p)),
  remove: (id: string) => tx('readwrite', (s) => s.delete(id)),
};

export function newLocalId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
