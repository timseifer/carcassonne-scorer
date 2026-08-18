// Two jobs:
//  1. Re-serve every response with COOP/COEP so the page is cross-origin
//     isolated. GitHub Pages cannot set those headers itself, and without them
//     SharedArrayBuffer is unavailable and onnxruntime-web falls back to a
//     single wasm thread — which is most of the wait on the wasm path.
//  2. Keep the 27 MB runtime and the 19 MB of SAM weights in a cache so a
//     second visit does not re-download them.
const CACHE = "mt-assets-v1";
const BIG = /\.(wasm|onnx)$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  ),
);

function isolate(res) {
  if (!res || res.status === 0 || res.type === "opaque") return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Immutable weights and runtime: cache first.
  if (BIG.test(url.pathname)) {
    e.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return isolate(hit);
        const res = await fetch(req);
        if (res.status === 200) {
          try {
            await cache.put(req, res.clone());
          } catch (_) {
            /* over quota — serve it anyway */
          }
        }
        return isolate(res);
      })(),
    );
    return;
  }

  // Everything else (the app itself): network first, so a deploy takes effect
  // immediately; cache only as an offline fallback.
  e.respondWith(
    fetch(req)
      .then(isolate)
      .catch(async () => {
        const hit = await caches.match(req);
        return hit ? isolate(hit) : Response.error();
      }),
  );
});
