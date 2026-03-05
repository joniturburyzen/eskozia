/**
 * GLB Worker — carga con caché IndexedDB
 * Primera carga: descarga + guarda en IndexedDB
 * Cargas siguientes: lee de IndexedDB (instantáneo)
 */

const DB_NAME    = 'glb-cache';
const DB_VERSION = 1;
const STORE      = 'files';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

function dbGet(db, key) {
  return new Promise(resolve => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = () => resolve(null);
  });
}

function dbPut(db, key, value) {
  return new Promise(resolve => {
    const tx  = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror    = resolve; // no bloquear si falla el cache
  });
}

self.onmessage = async function({ data }) {
  const { url, cacheKey } = data;

  try {
    const db = await openDB();

    // ── Intento 1: leer de caché local ──────────────────────
    const cached = await dbGet(db, cacheKey);
    if (cached) {
      self.postMessage({ type: 'cached', buffer: cached }, [cached]);
      return;
    }

    // ── Intento 2: descargar con progreso en streaming ───────
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const total  = parseInt(response.headers.get('content-length') || '0');
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      self.postMessage({ type: 'progress', loaded: received, total });
    }

    // Combinar chunks en un solo ArrayBuffer
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Guardar en IndexedDB (copia, para poder transferir el original)
    const toCache = merged.buffer.slice(0);
    dbPut(db, cacheKey, toCache); // async, no esperamos

    // Transferir al hilo principal (zero-copy)
    self.postMessage({ type: 'done', buffer: merged.buffer }, [merged.buffer]);

  } catch (err) {
    self.postMessage({ type: 'error', msg: err.message });
  }
};
