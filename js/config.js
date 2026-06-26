/* ============================================================
   Plumtown — front-end config
   The website and the API are served from the SAME origin (one
   Railway service), so the client automatically talks to the
   backend on whatever host it's loaded from — playplumtown.com,
   the *.up.railway.app URL, any custom domain.

   A local static preview (serve.js on localhost, or file://) has
   no API, so we fall back to offline single-player + a simulated
   community automatically. To force a specific backend instead,
   just hardcode cloudApi below, e.g.:
       window.LIFESIM_CONFIG = { cloudApi: 'https://playplumtown.com' };

   Nothing secret lives here: ALL economy rules — reward amounts,
   caps, network (mainnet), the treasury — are SERVER-SIDE. The
   client only reads them from /api/p2e/config.
   ============================================================ */
(function () {
  var loc = window.location;
  var isWeb = loc.protocol === 'http:' || loc.protocol === 'https:';
  var isLocal = loc.protocol === 'file:' ||
    /^(localhost|127\.|0\.0\.0\.0|::1|\[::1\])/.test(loc.hostname);
  // Same-origin API when deployed; empty (offline mode) for local static preview.
  window.LIFESIM_CONFIG = { cloudApi: (isWeb && !isLocal) ? loc.origin : '' };
})();
