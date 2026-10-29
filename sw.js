/* Auteur: HvdB */
/* Service worker: de app opent op de iPad ook zonder internet (stap 4 van de
 * bouwvolgorde in docs/IDEEEN.md).
 *
 * Netwerk eerst: is er verbinding, dan krijg je altijd de nieuwste versie en
 * gaat die meteen de cache in. Geen verbinding, of reageert het netwerk niet
 * binnen WACHT_MS (wifi aan boord die half werkt), dan komt het uit de cache.
 *
 * VERSIE en BESTANDEN vult tools/publiceer.js in; in de projectmap staan hier
 * lege waarden en wordt alleen gecachet wat de pagina zelf ophaalt. Een nieuwe
 * versie krijgt een nieuwe cache, de oude wordt bij het activeren opgeruimd.
 * Geen manifest erbij: zie v1.274 (theme-color staat bij twee thema's de helft
 * van de tijd verkeerd). */
const VERSIE = "1.375";
const BESTANDEN = ["DintelLink.html","DintelhavenPlanner.html","icoon/1.png","icoon/2.png","icoon/3.png","icoon/apple-touch-icon.png","icoon/bison-logo.png","icoon/icon-192.png","icoon/icon-32.png","index.html","lib/fonts/inter-latin-ext-wght-normal.woff2","lib/fonts/inter-latin-wght-normal.woff2","lib/fonts/jetbrains-mono-latin-ext-wght-normal.woff2","lib/fonts/jetbrains-mono-latin-wght-normal.woff2","lib/opmaak.css","lib/pdf.min.js","lib/pdf.worker.min.js","lib/tokens.css","lib/xlsx.full.min.js","style.css"];
const CACHE = 'dintellink-' + VERSIE;
const WACHT_MS = 4000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BESTANDEN)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(namen => Promise.all(namen.filter(n => n.startsWith('dintellink-') && n !== CACHE).map(n => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const netwerk = fetch(req).then(res => {
      if(res.ok) cache.put(req, res.clone());
      return res;
    });
    netwerk.catch(() => {});   // wint de cache, dan mag een latere netwerkfout stil blijven
    const uitCache = () => cache.match(req, { ignoreSearch: true })
      .then(r => r || (req.mode === 'navigate' ? cache.match('index.html', { ignoreSearch: true }) : undefined));
    const traag = new Promise(r => setTimeout(r, WACHT_MS));
    try{
      const snel = await Promise.race([netwerk, traag]);
      if(snel) return snel;
      // Netwerk te traag: cache als die er is, anders toch op het netwerk wachten.
      return (await uitCache()) || await netwerk;
    }catch(err){
      const r = await uitCache();
      if(r) return r;
      throw err;
    }
  })());
});
