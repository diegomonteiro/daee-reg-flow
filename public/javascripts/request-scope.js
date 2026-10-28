(function(root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RegflowRequests = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  function createScope() {
    let controller = null;
    function cancel() { controller?.abort(); controller = null; }
    return {
      cancel,
      begin() {
        cancel();
        const current = new AbortController(); controller = current;
        return { signal: current.signal, isCurrent: () => controller === current && !current.signal.aborted };
      }
    };
  }
  return { createScope };
});
