(function(root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RegflowNumbers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function numeric(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return NaN;
    return Number(value);
  }
  function format(value, digits = 2) {
    const n = numeric(value);
    if (!Number.isFinite(n)) return '—';
    const base = Math.max(0, Math.min(12, Math.trunc(digits)));
    const magnitude = Math.abs(n);
    // Keep at least three significant digits below one; never turn a nonzero
    // result into a displayed zero. This is presentation, not measurement accuracy.
    const places = magnitude > 0 && magnitude < 1 ? Math.max(base, 2 - Math.floor(Math.log10(magnitude))) : base;
    if (places > 12) return n.toLocaleString('pt-BR', {
      notation: 'scientific', minimumSignificantDigits: 3, maximumSignificantDigits: 3
    });
    return (n === 0 ? 0 : n).toLocaleString('pt-BR', { minimumFractionDigits: places, maximumFractionDigits: places });
  }
  function input(value) {
    const n = numeric(value);
    return Number.isFinite(n) ? String(n === 0 ? 0 : n) : '';
  }
  return { format, input };
});
