'use strict';

// Retain serialized buffers: the byte budget applies to actual retained payloads,
// rather than an underestimate of the heap occupied by GeoJSON coordinate arrays.
class JsonCache {
  constructor({ maxBytes = 32 * 1024 * 1024, maxEntryBytes = 8 * 1024 * 1024,
    maxEntries = 128, ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { maxBytes, maxEntryBytes, maxEntries, ttlMs, now });
    this.entries = new Map();
    this.bytes = 0;
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.data.length; this.entries.delete(key); }
  }
  prune() {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.delete(key);
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, entry);
    return JSON.parse(entry.data.toString('utf8'));
  }
  set(key, value) {
    this.prune(); this.delete(key);
    const data = Buffer.from(JSON.stringify(value));
    if (data.length > Math.min(this.maxBytes, this.maxEntryBytes)) return false;
    while (this.entries.size && (this.bytes + data.length > this.maxBytes || this.entries.size >= this.maxEntries)) {
      this.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { data, expiresAt: this.now() + this.ttlMs });
    this.bytes += data.length;
    return true;
  }
}

module.exports = { JsonCache };
