#!/usr/bin/env node
/* Auteur: HvdB */
/* DintelLink-server: de laptop als basisstation.
 *
 * Wat hij doet:
 *  1. De app serveren op het eigen wifi, zodat de iPad hem opent via
 *     http://<laptop>:8080/ (de laptop zelf via http://localhost:8080/).
 *  2. De planning synchroon houden tussen alle apparaten die de app via deze
 *     server openen. De server bewaart de stand (server-data/stand.json) en is
 *     leidend: een apparaat dat voor het eerst koppelt neemt de stand van de
 *     server over. Bij gelijktijdig wijzigen wint de wijziging die de server
 *     het laatst ontvangt (per opslagsleutel).
 *  3. AIS volgen (1.399, server/ais-volger.js): de duwboten op Vaarwegen, ook
 *     als de app nergens open staat. Meldingen en vaartijd komen van hier.
 *  4. Zichzelf bijwerken: elk kwartier kijkt hij of er op GitHub (de live repo)
 *     een nieuwere versie staat, haalt die op en meldt het aan de apparaten.
 *
 * Alleen Node-built-ins (Node 18 of nieuwer), geen npm install nodig.
 *
 *   node server/dintellink-server.js              starten
 *   node server/dintellink-server.js --bijwerken  alleen bijwerken en stoppen
 *   node server/dintellink-server.js --geen-update  starten zonder bijwerken
 *
 * Instelbaar met omgevingsvariabelen: DINTELLINK_POORT (8080),
 * DINTELLINK_MAP (de app-map; standaard de map boven server/),
 * DINTELLINK_DATA (standaard <app-map>/server-data),
 * DINTELLINK_LIVE_REPO (hermanvandenberg/Dintelhaven-Live).
 *
 * Waarom geen WebSocket zoals tot v1.245: een stroom van de server naar de
 * browser (Server-Sent Events) plus gewone POST-verzoeken terug is genoeg, werkt
 * zonder extra bibliotheek, en blijft binnen connect-src 'self' van de app.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const POORT = Number(process.env.DINTELLINK_POORT) || 8080;
const MAP = path.resolve(process.env.DINTELLINK_MAP || path.join(__dirname, '..'));
const DATA = path.resolve(process.env.DINTELLINK_DATA || path.join(MAP, 'server-data'));
const LIVE_REPO = process.env.DINTELLINK_LIVE_REPO || 'hermanvandenberg/Dintelhaven-Live';
const LIVE_TAK = 'main';
// Voor de tests: andere adressen dan GitHub.
const API_BASIS = process.env.DINTELLINK_API_BASIS || 'https://api.github.com';
const RAW_BASIS = process.env.DINTELLINK_RAW_BASIS || 'https://raw.githubusercontent.com';
const UPDATE_INTERVAL_MS = Number(process.env.DINTELLINK_UPDATE_MS) || 15 * 60 * 1000;
// Met deze codes stopt de server als hij opnieuw gestart wil worden; de
// bewaker (--bewaker, zie onderaan) en "Start DintelLink-server.bat" doen dat dan.
const HERSTART_CODE = 3;        // na een update van de server zelf
const HERSTART_HAND_CODE = 4;   // "Server herstarten" in de app
const ALLEEN_BIJWERKEN = process.argv.includes('--bijwerken');
const ALS_BEWAKER = process.argv.includes('--bewaker');
// Gezet door de bewaker en de .bat: er is iemand die de server na een herstart weer opstart.
const HEEFT_BEWAKER = process.env.DINTELLINK_BEWAAKT === '1';
const LOG_BESTAND = path.join(DATA, 'server.log');
const LOG_MAX = 1024 * 1024;

const STAND_BESTAND = path.join(DATA, 'stand.json');
const BACKUP_MAP = path.join(DATA, 'back-ups');
const BACKUPS_BEWAREN = 72;   // één per uur: drie dagen terug
const MAX_BODY = 20 * 1024 * 1024;

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('nl-NL')}]`, ...a);

/* ------------------------------------------------------------------
   De stand
------------------------------------------------------------------ */

function nieuweCode(){
  // Geen 0/O en 1/I/L: die zijn op een iPad-toetsenbord makkelijk te verwarren.
  const tekens = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for(const b of crypto.randomBytes(6)) c += tekens[b % tekens.length];
  return c;
}

function leesStand(){
  try{
    const s = JSON.parse(fs.readFileSync(STAND_BESTAND, 'utf8'));
    if(s && typeof s.sleutels === 'object') return s;
  }catch(e){
    if(e.code !== 'ENOENT') log('stand.json niet leesbaar, begin leeg:', e.message);
  }
  return { serverId: crypto.randomUUID(), koppelcode: nieuweCode(), gestart: false, rev: 0, sleutels: {} };
}

let stand = leesStand();
let schrijfTimer = null;
let laatsteBackupUur = '';

function bewaarStand(direct = false){
  clearTimeout(schrijfTimer);
  const schrijf = () => {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = STAND_BESTAND + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stand));
    fs.renameSync(tmp, STAND_BESTAND);   // nooit een half geschreven bestand
    maakUurBackup();
  };
  if(direct) schrijf();
  else schrijfTimer = setTimeout(() => { try{ schrijf(); }catch(e){ log('stand opslaan mislukt:', e.message); } }, 1000);
}

function maakUurBackup(){
  if(!stand.gestart) return;
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const uur = `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}`;
  if(uur === laatsteBackupUur) return;
  laatsteBackupUur = uur;
  fs.mkdirSync(BACKUP_MAP, { recursive: true });
  /* Zelfde vorm als "Back-up opslaan" in de app, zodat je hem daar met
     "Back-up terugzetten" weer kunt inlezen. */
  fs.writeFileSync(path.join(BACKUP_MAP, `DintelLink-backup-${uur}.json`),
    JSON.stringify({ app: 'DintelLink', gemaakt: d.toISOString(), sleutels: stand.sleutels }));
  const oud = fs.readdirSync(BACKUP_MAP).filter(n => n.endsWith('.json')).sort();
  for(const n of oud.slice(0, Math.max(0, oud.length - BACKUPS_BEWAREN))) fs.rmSync(path.join(BACKUP_MAP, n), { force: true });
}

/* ------------------------------------------------------------------
   Wie mag erbij
------------------------------------------------------------------ */

function isLokaal(req){
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/* De laptop zelf (localhost) is het basisstation en mag altijd. Een ander
   apparaat moet één keer de koppelcode invullen die in het servervenster staat;
   anders kan iedereen op hetzelfde wifi de planning lezen en wijzigen. */
function magErbij(req, url){
  if(isLokaal(req)) return true;
  const code = (req.headers['x-koppelcode'] || url.searchParams.get('code') || '').toString().trim().toUpperCase();
  if(!code) return false;
  const a = Buffer.from(code), b = Buffer.from(stand.koppelcode);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------
   Live stroom naar de apparaten (Server-Sent Events)
------------------------------------------------------------------ */

const stromen = new Set();

function stuur(res, type, data){
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
function stuurIedereen(type, data){
  for(const s of stromen) stuur(s.res, type, data);
}

/* AIS (1.399): de volger leest zijn instellingen uit de stand. Pas aanmaken als
   er echt een server draait (niet bij --bijwerken of als bewaker). */
const AIS_SLEUTELS = new Set(['duwbakken-ais-boten', 'duwbakken-ais-zones', 'duwbakken-ais-groepen',
  'duwbakken-ais-instellingen', 'duwbakken-gebruikers']);
let aisVolger = null;
function aisMisschienHerladen(sleutels){
  if(aisVolger && sleutels.some(k => AIS_SLEUTELS.has(k))) aisVolger.herlaad();
}
function aantalApparaten(){
  return new Set([...stromen].map(s => s.apparaat)).size;
}

function standVoorApparaat(){
  return { serverId: stand.serverId, gestart: stand.gestart, rev: stand.rev, sleutels: stand.sleutels, versie: leesVersie() };
}

/* ------------------------------------------------------------------
   Statische bestanden
------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};
const APP_PAGINAS = new Set(['index.html', 'DintelLink.html']);
// Deze mappen horen bij de server en gaan nooit naar een browser.
const VERBORGEN = new Set(['server', 'server-data', 'node_modules', 'tests', 'tools', 'docs']);

function leesVersie(){
  try{ return JSON.parse(fs.readFileSync(path.join(MAP, 'versie.json'), 'utf8')).versie || '?'; }
  catch(_){ return '?'; }
}

function serveerBestand(req, res, url){
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if(rel === '' || rel.endsWith('/')) rel += 'index.html';
  const delen = rel.split('/');
  if(delen.some(d => d === '..' || d.startsWith('.')) || VERBORGEN.has(delen[0])){
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Niet gevonden');
  }
  const doel = path.join(MAP, rel);
  if(!doel.startsWith(MAP + path.sep)){ res.writeHead(403); return res.end(); }
  fs.readFile(doel, (err, data) => {
    if(err){
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Niet gevonden');
    }
    const ext = path.extname(doel).toLowerCase();
    if(APP_PAGINAS.has(rel) && ext === '.html'){
      /* Het teken voor src/11-sync.js dat de app via deze server draait.
         Op GitHub Pages en in de tests ontbreekt het, en blijft de sync uit. */
      data = Buffer.from(data.toString('utf8').replace(/<head>/i, '<head>\n<meta name="dintellink-server" content="1">'));
    }
    // De app moet na een update meteen de nieuwe versie laden: niets cachen.
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

/* ------------------------------------------------------------------
   Verzoeken
------------------------------------------------------------------ */

function json(res, status, data){
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function leesBody(req){
  return new Promise((klaar, fout) => {
    const stukken = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if(n > MAX_BODY){ fout(new Error('te groot')); req.destroy(); return; }
      stukken.push(c);
    });
    req.on('end', () => {
      try{ klaar(JSON.parse(Buffer.concat(stukken).toString('utf8') || '{}')); }
      catch(e){ fout(e); }
    });
    req.on('error', fout);
  });
}

const geldigeSleutel = k => typeof k === 'string' && k.startsWith('duwbakken-') && k.length < 200;

function lanAdressen(){
  const uit = [];
  for(const lijst of Object.values(os.networkInterfaces())){
    for(const a of lijst || []){
      if(a.family === 'IPv4' && !a.internal) uit.push(a.address);
    }
  }
  return uit;
}
function adressenVoorIpad(){
  return [...lanAdressen().map(ip => `http://${ip}:${POORT}/`), `http://${os.hostname().toLowerCase()}.local:${POORT}/`];
}

async function api(req, res, url){
  const p = url.pathname;
  if(!magErbij(req, url)) return json(res, 401, { fout: 'koppelcode nodig' });
  const basis = isLokaal(req);

  if(p === '/sync/status' && req.method === 'GET'){
    return json(res, 200, {
      basis, serverId: stand.serverId, gestart: stand.gestart, rev: stand.rev,
      ais: aisVolger ? aisVolger.status() : null,
      versie: leesVersie(), apparaten: aantalApparaten(), update: updateStatus,
      // Alleen de laptop zelf krijgt de code, de adressen en de knoppen te zien.
      ...(basis ? { koppelcode: stand.koppelcode, adressen: adressenVoorIpad(),
        kanHerstarten: HEEFT_BEWAKER, autostart: autostartStatus() } : {})
    });
  }

  if(p === '/sync/stroom' && req.method === 'GET'){
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    const s = { res, apparaat: (url.searchParams.get('apparaat') || '?').slice(0, 64) };
    stromen.add(s);
    stuur(res, 'stand', standVoorApparaat());
    if(aisVolger) stuur(res, 'ais', aisVolger.momentopname());
    stuurIedereen('apparaten', { aantal: aantalApparaten() });
    const hartslag = setInterval(() => res.write(': hartslag\n\n'), 25000);
    req.on('close', () => {
      clearInterval(hartslag);
      stromen.delete(s);
      stuurIedereen('apparaten', { aantal: aantalApparaten() });
    });
    return;
  }

  if(p === '/sync/begin' && req.method === 'POST'){
    /* De eerste vulling komt van de laptop (het basisstation). Daarna is de
       server leidend en neemt elk apparaat zijn stand over. */
    if(!basis) return json(res, 403, { fout: 'alleen de laptop zelf vult de server' });
    const body = await leesBody(req);
    if(stand.gestart && !body.overschrijf) return json(res, 409, { fout: 'al gestart', rev: stand.rev });
    const sleutels = {};
    for(const [k, v] of Object.entries(body.sleutels || {})) if(geldigeSleutel(k) && typeof v === 'string') sleutels[k] = v;
    stand.sleutels = sleutels;
    stand.gestart = true;
    stand.rev++;
    bewaarStand(true);
    log(`gestart met de stand van de laptop (${Object.keys(sleutels).length} sleutels)`);
    stuurIedereen('stand', standVoorApparaat());
    aisMisschienHerladen(Object.keys(sleutels));
    return json(res, 200, { rev: stand.rev, serverId: stand.serverId });
  }

  if(p === '/sync/wijzig' && req.method === 'POST'){
    const body = await leesBody(req);
    if(!stand.gestart) return json(res, 409, { fout: 'nog niet gestart: open eerst de app op de laptop' });
    if(body.serverId !== stand.serverId) return json(res, 409, { fout: 'andere server', serverId: stand.serverId });
    const wijzigingen = [];
    for(const w of Array.isArray(body.wijzigingen) ? body.wijzigingen : []){
      if(!w || !geldigeSleutel(w.k)) continue;
      if(w.v === null){ if(w.k in stand.sleutels){ delete stand.sleutels[w.k]; wijzigingen.push({ k: w.k, v: null }); } }
      else if(typeof w.v === 'string' && stand.sleutels[w.k] !== w.v){ stand.sleutels[w.k] = w.v; wijzigingen.push({ k: w.k, v: w.v }); }
    }
    if(wijzigingen.length){
      stand.rev++;
      bewaarStand();
      stuurIedereen('wijziging', { van: String(body.apparaat || ''), rev: stand.rev, wijzigingen });
      aisMisschienHerladen(wijzigingen.map(w => w.k));
    }
    return json(res, 200, { rev: stand.rev });
  }

  if(p === '/sync/ais-vul' && req.method === 'POST'){
    if(!aisVolger) return json(res, 409, { fout: 'AIS staat niet aan' });
    return json(res, 200, { gevuld: aisVolger.vul(await leesBody(req)) });
  }

  if(p === '/sync/ais-ververs' && req.method === 'POST'){
    if(!aisVolger) return json(res, 409, { fout: 'AIS staat niet aan' });
    return json(res, 200, { ververst: aisVolger.ververs() });
  }

  if(p === '/sync/nieuwe-code' && req.method === 'POST'){
    if(!basis) return json(res, 403, { fout: 'alleen op de laptop' });
    stand.koppelcode = nieuweCode();
    bewaarStand(true);
    toonWelkom();
    return json(res, 200, { koppelcode: stand.koppelcode });
  }

  if(p === '/sync/bijwerken' && req.method === 'POST'){
    if(!basis) return json(res, 403, { fout: 'alleen op de laptop' });
    const uit = await werkBij();
    return json(res, 200, uit);
  }

  if((p === '/sync/stop' || p === '/sync/herstart') && req.method === 'POST'){
    if(!basis) return json(res, 403, { fout: 'alleen op de laptop' });
    const herstart = p === '/sync/herstart';
    if(herstart && !HEEFT_BEWAKER) return json(res, 409, { fout: 'herstarten kan alleen als de server via het DintelLink-icoon gestart is' });
    log(herstart ? 'herstart gevraagd vanuit de app' : 'uitgezet vanuit de app');
    json(res, 200, { ok: true });
    stuurIedereen('server', { uit: !herstart, herstart });
    setTimeout(() => stopNetjes(herstart ? HERSTART_HAND_CODE : 0), 300);
    return;
  }

  if(p === '/sync/autostart' && req.method === 'POST'){
    if(!basis) return json(res, 403, { fout: 'alleen op de laptop' });
    const body = await leesBody(req);
    try{ zetAutostart(!!body.aan); }
    catch(e){ return json(res, 500, { fout: e.message }); }
    return json(res, 200, { autostart: autostartStatus() });
  }

  json(res, 404, { fout: 'onbekend' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if(url.pathname.startsWith('/sync/')){
    api(req, res, url).catch(e => {
      log('fout bij', url.pathname, e.message);
      if(!res.headersSent) json(res, 400, { fout: e.message });
      else res.end();
    });
    return;
  }
  if(req.method !== 'GET' && req.method !== 'HEAD'){ res.writeHead(405); return res.end(); }
  serveerBestand(req, res, url);
});

/* ------------------------------------------------------------------
   Automatisch starten met Windows
------------------------------------------------------------------ */

/* Een klein .vbs-bestand in de map Opstarten van Windows: dat start bij het
   aanmelden de server onzichtbaar (DintelLink.vbs /achtergrond). Geen .lnk,
   want die kan Node niet zonder hulpprogramma maken. */
function opstartMap(){
  if(process.platform !== 'win32' || !process.env.APPDATA) return null;
  return path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}
const OPSTART_NAAM = 'DintelLink-server.vbs';
function autostartStatus(){
  const map = opstartMap();
  if(!map) return null;   // niet op Windows: geen knop
  return fs.existsSync(path.join(map, OPSTART_NAAM));
}
function zetAutostart(aan){
  const map = opstartMap();
  if(!map) throw new Error('alleen op Windows');
  const doel = path.join(map, OPSTART_NAAM);
  if(!aan){ fs.rmSync(doel, { force: true }); return; }
  const starter = path.join(MAP, 'server', 'DintelLink.vbs');
  fs.mkdirSync(map, { recursive: true });
  fs.writeFileSync(doel, `' DintelLink-server bij het aanmelden starten (aan/uit in DintelLink)\r\n` +
    `CreateObject("WScript.Shell").Run "wscript.exe ""${starter}"" /achtergrond", 0, False\r\n`);
}

/* ------------------------------------------------------------------
   Bijwerken vanaf GitHub
------------------------------------------------------------------ */

let updateStatus = { bezig: false, laatsteControle: null, laatsteFout: null, beschikbaar: null };

async function haal(url, als = 'json'){
  const r = await fetch(url, { headers: { 'User-Agent': 'DintelLink-server', 'Cache-Control': 'no-cache' } });
  if(!r.ok) throw new Error(`${url} gaf ${r.status}`);
  return als === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
}

/* Haalt de live repo op (alleen als versie.json daar anders is dan hier) en
   zet hem over de app-map heen. server-data/ wordt nooit aangeraakt. Geeft
   { bijgewerkt, versie, herstart } terug. */
async function werkBij({ stil = false } = {}){
  if(updateStatus.bezig) return { bijgewerkt: false, bezig: true };
  updateStatus.bezig = true;
  try{
    const daar = await haal(`${RAW_BASIS}/${LIVE_REPO}/${LIVE_TAK}/versie.json?t=${Date.now()}`);
    let hier = {};
    try{ hier = JSON.parse(fs.readFileSync(path.join(MAP, 'versie.json'), 'utf8')); }catch(_){}
    updateStatus.laatsteControle = new Date().toISOString();
    updateStatus.laatsteFout = null;
    if(daar.versie === hier.versie && daar.gepubliceerd === hier.gepubliceerd){
      if(!stil) log(`al bij: v${hier.versie}`);
      return { bijgewerkt: false, versie: hier.versie };
    }
    log(`nieuwe versie gevonden: v${daar.versie} (hier v${hier.versie || '?'}) — ophalen…`);
    const boom = await haal(`${API_BASIS}/repos/${LIVE_REPO}/git/trees/${LIVE_TAK}?recursive=1`);
    if(boom.truncated) throw new Error('lijst van bestanden onvolledig');
    /* Bestanden die met een punt beginnen (.nojekyll, voor GitHub Pages) heeft de
       laptop niet nodig. Lege bestanden halen we niet op: daarop gaf
       raw.githubusercontent.com op de laptop een 501 en brak het hele bijwerken af. */
    const blobs = boom.tree.filter(t => t.type === 'blob'
      && !t.path.split('/').some(d => d === '..' || d.startsWith('.')) && !t.path.startsWith('server-data/'));
    const leeg = new Set(blobs.filter(t => t.size === 0).map(t => t.path));
    const bestanden = blobs.map(t => t.path);
    if(!bestanden.includes('versie.json') || !bestanden.includes('DintelLink.html')) throw new Error('live repo ziet er niet uit als DintelLink');

    // Eerst alles in een tijdelijke map: valt het netwerk halverwege weg, dan
    // blijft de werkende versie gewoon staan.
    const tmp = path.join(DATA, 'update-tmp');
    fs.rmSync(tmp, { recursive: true, force: true });
    for(const rel of bestanden){
      const url = `${RAW_BASIS}/${LIVE_REPO}/${LIVE_TAK}/${rel.split('/').map(encodeURIComponent).join('/')}`;
      // Eén keer opnieuw proberen: een hapering halverwege moet niet de hele update kosten.
      const data = leeg.has(rel) ? Buffer.alloc(0)
        : await haal(url, 'buffer').catch(() => new Promise(r => setTimeout(r, 2000)).then(() => haal(url, 'buffer')));
      const doel = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(doel), { recursive: true });
      fs.writeFileSync(doel, data);
    }
    /* Herstarten als er iets aan de server zelf veranderde: zijn eigen bestand,
       een ander .js in server/ (ais-volger.js) of het gedeelde lib/ais-kern.js. */
    const serverAnders = bestanden.filter(r => (r.startsWith('server/') && r.endsWith('.js')) || r === 'lib/ais-kern.js')
      .some(rel => {
        const oud = path.join(MAP, rel);
        return !fs.existsSync(oud) || !fs.readFileSync(path.join(tmp, rel)).equals(fs.readFileSync(oud));
      });
    // versie.json als laatste: lukt het kopiëren niet helemaal, dan probeert de
    // volgende controle het opnieuw.
    for(const rel of bestanden.filter(r => r !== 'versie.json').concat('versie.json')){
      const doel = path.join(MAP, rel);
      fs.mkdirSync(path.dirname(doel), { recursive: true });
      fs.copyFileSync(path.join(tmp, rel), doel);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    log(`bijgewerkt naar v${daar.versie} (${bestanden.length} bestanden)`);
    stuurIedereen('versie', { versie: daar.versie });
    if(serverAnders && !ALLEEN_BIJWERKEN && HEEFT_BEWAKER){
      log('de server zelf is ook vernieuwd — hij start zo opnieuw op.');
      setTimeout(() => stopNetjes(HERSTART_CODE), 1500);
    } else if(serverAnders){
      log('de server zelf is ook vernieuwd: wordt actief na de volgende herstart.');
    }
    return { bijgewerkt: true, versie: daar.versie, herstart: serverAnders };
  }catch(e){
    updateStatus.laatsteFout = e.message;
    log('bijwerken lukte niet:', e.message);
    return { bijgewerkt: false, fout: e.message };
  }finally{
    updateStatus.bezig = false;
  }
}

/* ------------------------------------------------------------------
   Starten
------------------------------------------------------------------ */

function toonWelkom(){
  console.log('');
  console.log('  DintelLink-server  v' + leesVersie());
  console.log('  ------------------------------------------------------------');
  console.log(`  Op deze laptop:   http://localhost:${POORT}/`);
  console.log('  Op de iPad:       ' + adressenVoorIpad().join('\n                    '));
  console.log(`  Koppelcode iPad:  ${stand.koppelcode}`);
  console.log('  ------------------------------------------------------------');
  if(!HEEFT_BEWAKER) console.log('  Laat dit venster open. Sluiten = de server stopt.');
  console.log('');
}

function stopNetjes(code){
  try{ if(aisVolger) aisVolger.stop(); }catch(_){}
  try{ if(schrijfTimer){ clearTimeout(schrijfTimer); bewaarStand(true); } }
  finally{ process.exit(code); }
}

/* Bewaker: draait de server als kindproces, onzichtbaar (DintelLink.vbs start
   hem zonder venster), schrijft wat de server meldt naar server-data/server.log
   en start hem opnieuw na een update of "Server herstarten". Stopt de server
   op een andere manier ("Server uitzetten"), dan stopt de bewaker ook. */
function bewaak(){
  const { spawn } = require('child_process');
  fs.mkdirSync(DATA, { recursive: true });
  const schrijfLog = tekst => {
    try{
      if(fs.existsSync(LOG_BESTAND) && fs.statSync(LOG_BESTAND).size > LOG_MAX){
        fs.renameSync(LOG_BESTAND, LOG_BESTAND + '.1');
      }
      fs.appendFileSync(LOG_BESTAND, tekst);
    }catch(_){}
  };
  const args = process.argv.slice(2).filter(a => a !== '--bewaker');
  let pogingen = 0;
  const start = () => {
    const kind = spawn(process.execPath, [__filename, ...args], {
      env: { ...process.env, DINTELLINK_BEWAAKT: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    kind.stdout.on('data', d => schrijfLog(d.toString()));
    kind.stderr.on('data', d => schrijfLog(d.toString()));
    const begon = Date.now();
    kind.on('exit', code => {
      schrijfLog(`[bewaker] server gestopt met code ${code}\n`);
      if(code === HERSTART_CODE || code === HERSTART_HAND_CODE) return start();
      // Onverwacht omgevallen: opnieuw proberen, maar niet eindeloos snel achter elkaar.
      if(code !== 0 && code !== 1 && Date.now() - begon > 60000 && pogingen++ < 20) return setTimeout(start, 5000);
      process.exit(code || 0);
    });
  };
  start();
}

if(ALS_BEWAKER){
  bewaak();
} else if(ALLEEN_BIJWERKEN){
  werkBij().then(u => process.exit(u.fout ? 1 : 0));
} else {
  if(!fs.existsSync(STAND_BESTAND)) bewaarStand(true);   // serverId en koppelcode vastleggen
  server.on('error', e => {
    if(e.code === 'EADDRINUSE') log(`poort ${POORT} is al in gebruik — draait de server al?`);
    else log('serverfout:', e.message);
    process.exit(1);
  });
  server.listen(POORT, '0.0.0.0', () => {
    toonWelkom();
    try{
      aisVolger = require('./ais-volger')({ DATA, log, leesSleutel: k => stand.sleutels[k], stuurIedereen });
      aisVolger.herlaad();
    }catch(e){ log('AIS-volger start niet:', e.message); }
    if(!process.argv.includes('--geen-update')){
      setTimeout(() => werkBij({ stil: true }), 3000);
      setInterval(() => werkBij({ stil: true }), UPDATE_INTERVAL_MS);
    }
  });
  process.on('SIGINT', () => stopNetjes(0));
  process.on('SIGTERM', () => stopNetjes(0));
}

module.exports = { werkBij };
