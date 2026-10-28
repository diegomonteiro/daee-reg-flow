(function(root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RegflowWaterBalance = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const aborted = () => new DOMException('Consulta pausada.', 'AbortError');
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(aborted()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  function retryAfterMs(value, now = Date.now()) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const delay = Number(raw) * 1000;
      return Number.isSafeInteger(delay) ? delay : null;
    }
    // HTTP-date, not a signed/decimal delay or an arbitrary date-like number.
    if (!/[a-z]/i.test(raw)) return null;
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
  }
  function createTransport({ request, onCooldown = () => {}, onResume = () => {},
    now = Date.now, wait = sleep, pageIntervalMs = 400, transientRetries = 1 } = {}) {
    let nextPageAt = 0, cooldownUntil = 0, cooling = false, lastSeconds = -1, strikes = 0;
    function remainingMs() { return Math.max(0, cooldownUntil - now()); }
    async function gate(stage, signal) {
      while (true) {
        if (signal?.aborted) throw aborted();
        const remaining = remainingMs();
        if (remaining > 0) {
          const seconds = Math.ceil(remaining / 1000);
          if (seconds !== lastSeconds) { lastSeconds = seconds; onCooldown({ seconds, retryAt: cooldownUntil }); }
        } else if (cooling) {
          cooling = false; lastSeconds = -1; onResume();
        }
        const delay = Math.max(remaining, stage === 'page' ? nextPageAt - now() : 0);
        if (delay > 0) { await wait(Math.min(delay, 1000), signal); continue; }
        // Claim the slot synchronously so both workers share the same pacing.
        if (stage === 'page') nextPageAt = now() + pageIntervalMs;
        return;
      }
    }
    return {
      remainingMs,
      async send(stage, payload, signal) {
        let attempts = 0;
        while (true) {
          await gate(stage, signal);
          if (signal?.aborted) throw aborted();
          // Another response may have established a cooldown while this permit resolved.
          if (remainingMs() > 0) continue;
          try {
            const result = await request(stage, payload, signal);
            if (signal?.aborted) throw aborted();
            if (!remainingMs()) strikes = 0;
            return result;
          } catch (error) {
            if (signal?.aborted) throw aborted();
            if (error.status === 429) {
              const declared = retryAfterMs(error.retryAfter, now());
              const delay = declared ?? Math.min(300000, 60000 * 2 ** Math.min(strikes, 3));
              strikes++; cooling = true;
              cooldownUntil = Math.max(cooldownUntil, now() + Math.max(1000, delay));
              // 429 does not consume the transient-error budget or split a batch.
              continue;
            }
            if (![502, 503].includes(error.status) || attempts++ >= transientRetries) throw error;
            await wait(400, signal);
          }
        }
      }
    };
  }
  function createLoader({ request, onProgress = () => {}, onFeatures = () => {}, transportOptions = {} }) {
    let state = null, phase = 'loading';
    const transport = createTransport({ ...transportOptions, request, onCooldown: emitProgress, onResume: emitProgress });
    function emitProgress() {
      const total = state?.plan?.data.cells.length || 0, remaining = transport.remainingMs();
      onProgress({ phase: remaining > 0 ? 'cooldown' : phase, cooldownSeconds: Math.ceil(remaining / 1000),
        completed: state?.completed || 0, total,
        percent: total ? Math.min(99, Math.floor(100 * state.completed / total)) : 0, loaded: state?.features.size || 0 });
    }
    function progress(nextPhase = 'loading') { phase = nextPhase; emitProgress(); }
    function reset() { state = null; }
    async function run(geometry, selection, signal) {
      const key = JSON.stringify(geometry);
      if (!state?.plan || state.key !== key || state.plan?.data.expires_at <= Date.now()) {
        state = { key, completed: 0, features: new Map(), previews: new Map(), receipts: [], queue: [], plan: null };
        progress('preparing');
        const preparing = state;
        const started = await transport.send('start', { geometry, selection }, signal);
        if (signal?.aborted || state !== preparing) throw new DOMException('Consulta cancelada.', 'AbortError');
        if (started.result) { onProgress({ phase: 'complete', percent: 100, loaded: started.result.counts.in_polygon, completed: 0, total: 0 }); return started.result; }
        state.plan = started.plan;
        const cells = state.plan.data.cells;
        for (let index = 0; index < cells.length; index += 8) state.queue.push(cells.slice(index, index + 8));
      }
      const current = state;
      progress();
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      let failed;
      async function worker() {
        while (current.queue.length && !controller.signal.aborted) {
          const cells = current.queue.shift(), receipts = [], previews = []; let start = 0, previous;
          try {
            do {
              const page = await transport.send('page', { geometry: {type:'Feature',properties:{},geometry:geometry.geometry || geometry}, plan: current.plan, cells, start_index: start, previous }, controller.signal);
              previews.push(...(page.preview || []));
              previous = page.receipt; receipts.push(previous); start = previous.data.next_index;
            } while (!previous.data.complete);
            if (controller.signal.aborted || state !== current) throw new DOMException('Consulta cancelada.', 'AbortError');
            const collected = new Map(current.features);
            for (const receipt of receipts) for (const feature of receipt.data.features) collected.set(feature.id, feature);
            if (collected.size > 10000) throw Object.assign(new Error('Área excede 10000 outorgas; reduza a seleção.'),{status:422});
            current.features = collected; current.receipts.push(...receipts); current.completed += cells.length;
            for (const feature of previews) current.previews.set(feature.id, feature);
            onFeatures([...current.previews.values()]); progress();
          } catch (error) {
            if (!controller.signal.aborted && error.status === 502 && cells.length > 1) {
              const middle = Math.ceil(cells.length / 2); current.queue.unshift(cells.slice(0, middle), cells.slice(middle));
              progress('subdividing'); continue;
            }
            current.queue.unshift(cells); failed ||= error; controller.abort();
          }
        }
      }
      try {
        await Promise.all([worker(), worker()]);
        if (failed) throw failed;
        if (controller.signal.aborted) throw new DOMException('Consulta cancelada.', 'AbortError');
        progress('finalizing');
        const result = await transport.send('complete', { geometry, plan: current.plan, receipts: current.receipts }, signal);
        if (signal?.aborted || state !== current) throw new DOMException('Consulta cancelada.', 'AbortError');
        state = null;
        onProgress({ phase: 'complete', completed: current.completed, total: current.plan.data.cells.length, percent: 100, loaded: result.counts.in_polygon });
        return result;
      } finally { signal?.removeEventListener('abort', abort); }
    }
    return { run, reset };
  }
  return { createLoader, createTransport, retryAfterMs };
});
