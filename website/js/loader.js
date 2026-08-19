// Lazy loader for the vendored UMD bundles.
//
// WHY THIS IS A CLASSIC <script> INJECTION AND NOT dynamic import().
//
// Phase 2c originally planned per-family `import('./stellar-sdk.min.js')`. That
// works for stellar-sdk by luck and FAILS for freighter-api by construction, and
// the difference is one line of each bundle's UMD preamble:
//
//   stellar-sdk : (e = typeof globalThis !== 'undefined' ? globalThis : e || self).StellarSdk = {}
//   freighter   : r.freighterApi = e()          // r === `this`
//
// A file pulled in by import() is evaluated as an ES module, and in an ES module
// top-level `this` is **undefined**. So freighter-api throws
// "Cannot set properties of undefined (setting 'freighterApi')" before any of
// its code runs. Verified 2026-08-19 by loading both bundles in node.
//
// Injecting a classic <script> keeps `this === window`, which is what both
// bundles were built for, and still defers the ~470 KB download until the chain
// that needs it is actually selected. One mechanism for both families also means
// a future vendored bundle cannot reintroduce this asymmetry.
//
// CSP: these are same-origin paths, covered by `script-src 'self'`.
window.SAFU = window.SAFU || {};

window.SAFU.loadScript = (() => {
  const inflight = new Map();

  // `globalName` makes the load idempotent across page state: if the global is
  // already present (e.g. a bundle was added to index.html later), no second
  // network request or second evaluation happens.
  return function loadScript(src, globalName) {
    if (globalName && window[globalName]) return Promise.resolve(window[globalName]);
    if (inflight.has(src)) return inflight.get(src);

    const p = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => {
        if (globalName && !window[globalName]) {
          // The file loaded but did not register what it promised. Failing here
          // is the point: the alternative is a later TypeError from deep inside
          // an adapter, where the cause is no longer visible.
          reject(new Error(`SAFU: ${src} loaded but window.${globalName} is absent`));
          return;
        }
        resolve(globalName ? window[globalName] : true);
      };
      el.onerror = () => reject(new Error(`SAFU: failed to load ${src}`));
      document.head.appendChild(el);
    }).catch(e => {
      // Drop the cached rejection so a retry (user re-opens the modal after
      // fixing their connection) can actually retry.
      inflight.delete(src);
      throw e;
    });

    inflight.set(src, p);
    return p;
  };
})();
