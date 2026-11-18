// Service worker mínimo: deixa o REVELA instalável e aparecer no menu Compartilhar.
// Não guarda vídeos em cache — tudo vem sempre do servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || u.pathname.startsWith('/v/')) return;
  e.respondWith(fetch(e.request).catch(() => new Response('<meta charset=utf-8><body style="font:16px monospace;background:#ece2cc;padding:30px"><h1>REVELA fora do ar</h1><p>O servidor não respondeu. Verifique se ele está ligado.</p>', { headers: { 'content-type': 'text/html; charset=utf-8' } })));
});
