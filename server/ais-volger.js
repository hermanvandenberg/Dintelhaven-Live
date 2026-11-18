/* Auteur: HvdB */
/* AIS-volger op de laptop (1.399): de server houdt zelf de verbinding met
 * AISStream open, ook als de app op geen enkel apparaat open staat. Hij maakt
 * de meldingen ("Bakken zijn vertrokken", "Duwboot komt eraan") en telt de
 * vaartijd van de groep Eigen Boot, met hetzelfde rekenwerk als de app
 * (lib/ais-kern.js). De apparaten krijgen de stand via de stroom (event 'ais').
 *
 * Instellingen (boten, groepen, zones, sleutel) komen uit de gesynchroniseerde
 * stand: wat je in de app op Vaarwegen invult, gebruikt de server meteen.
 * Wat de server zelf verzamelt staat in server-data/ais.json, apart van
 * stand.json: posities komen elke paar seconden binnen en horen niet in de
 * uurlijkse back-ups.
 *
 * Nodig: Node 22 of nieuwer (ingebouwde WebSocket). Is die er niet, dan meldt
 * de server dat en volgt de app zelf, zoals voorheen.
 *
 * 1.414: naast AISStream ook een eigen AIS-ontvanger (server/ais-ontvanger.js),
 * in te stellen op Vaarwegen. Beide leveren posities aan hetzelfde rekenwerk.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const AIS_URL = process.env.DINTELLINK_AIS_URL || 'wss://stream.aisstream.io/v0/stream';   // ander adres alleen voor de tests
const STIL_MS = 10 * 60e3;          // zo lang niets binnen: opnieuw verbinden
const UITZEND_MS = 3000;            // hooguit zo vaak de stand naar de apparaten
const BEWAAR_MS = 30e3;
const MELDINGEN_MEE = 50;

module.exports = function maakAisVolger({ DATA, log, leesSleutel, stuurIedereen }){
  const kern = require(path.join(__dirname, '..', 'lib', 'ais-kern.js'));
  const maakAisOntvanger = require('./ais-ontvanger');
  const BESTAND = path.join(DATA, 'ais.json');

  const staat = { boten: [], groepen: [], zones: [], posities: {}, zoneStand: {}, vaartijd: {} };
  let meldingen = [];
  let sleutel = '';
  let abonnementVoor = '';     // sleutel + MMSI's waarmee de huidige verbinding loopt
  let ws = null;
  let herstelTimer = null, wacht = 5000;
  let laatsteBericht = null, verbondenOp = null;
  let laatsteEigen = null;     // laatste positie van de eigen ontvanger (1.414)
  const status = { staat: 'uit', tekst: '', laatste: null };

  try{
    const d = JSON.parse(fs.readFileSync(BESTAND, 'utf8'));
    staat.posities = d.posities || {};
    staat.zoneStand = kern.volleZoneStand(d.zoneStand);
    staat.vaartijd = d.vaartijd || {};
    meldingen = Array.isArray(d.meldingen) ? d.meldingen : [];
  }catch(e){ if(e.code !== 'ENOENT') log('ais.json niet leesbaar, begin leeg:', e.message); }

  const json = (k, terug) => { try{ const v = leesSleutel(k); return v == null ? terug : JSON.parse(v); }catch(_){ return terug; } };

  function gebruiker(){
    const g = json('duwbakken-gebruikers', {});
    const u = (g.users || []).find(x => x.id === g.currentUserId);
    return u ? u.naam : '';
  }

  /* ---------- bewaren en uitzenden ---------- */

  let bewaarTimer = null;
  let vuil = false;                  // alleen schrijven als er echt iets nieuws is
  function bewaar(direct = false){
    vuil = true;
    const schrijf = () => {
      bewaarTimer = null;
      if(!vuil) return;
      vuil = false;
      try{
        fs.mkdirSync(DATA, { recursive: true });
        const tmp = BESTAND + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ posities: staat.posities, zoneStand: kern.kaleZoneStand(staat.zoneStand),
          vaartijd: staat.vaartijd, meldingen }));
        fs.renameSync(tmp, BESTAND);
      }catch(e){ log('ais.json opslaan mislukt:', e.message); }
    };
    if(direct){ clearTimeout(bewaarTimer); schrijf(); }
    else if(!bewaarTimer) bewaarTimer = setTimeout(schrijf, BEWAAR_MS);
  }

  const laatste = () => Math.max(laatsteBericht || 0, laatsteEigen || 0) || null;
  function momentopname(){
    return { status: { ...status, laatste: laatste() }, ontvanger: ontvanger.status(), posities: staat.posities,
      zoneStand: kern.kaleZoneStand(staat.zoneStand), vaartijd: staat.vaartijd, meldingen: meldingen.slice(0, MELDINGEN_MEE) };
  }
  let uitzendTimer = null;
  function zendUit(direct = false){
    if(direct){ clearTimeout(uitzendTimer); uitzendTimer = null; stuurIedereen('ais', momentopname()); return; }
    if(uitzendTimer) return;
    uitzendTimer = setTimeout(() => { uitzendTimer = null; stuurIedereen('ais', momentopname()); }, UITZEND_MS);
  }
  function zetStatus(s, tekst){
    if(status.staat === s && status.tekst === tekst) return;
    status.staat = s; status.tekst = tekst;
    zendUit();
  }

  /* ---------- een positie verwerken (AISStream of eigen ontvanger) ---------- */

  function verwerk(pos){
    const nieuw = kern.verwerkPositie(staat, pos, { gebruiker: gebruiker() });
    if(nieuw.length){
      meldingen.unshift(...nieuw.slice().reverse());
      if(meldingen.length > kern.K.MAX_MELDINGEN) meldingen.length = kern.K.MAX_MELDINGEN;
      nieuw.forEach(m => log('AIS-melding:', m.tekst));
      bewaar(true);
      zendUit(true);
    } else {
      bewaar();
      zendUit();
    }
  }

  /* De eigen ontvanger hoort alle schepen in de buurt: alleen onze boten tellen.
     Hetzelfde bericht via AISStream en de ontvanger tegelijk: één keer. */
  const ontvanger = maakAisOntvanger({ log, opStatus: () => zendUit(),
    opPositie: (pos) => {
      if(!staat.boten.some(b => String(b.mmsi) === pos.mmsi)) return;
      laatsteEigen = pos.t;
      const oud = staat.posities[pos.mmsi];
      if(oud && oud.lat === pos.lat && oud.lon === pos.lon && pos.t - oud.t < 2000) return;
      verwerk(pos);
    } });

  /* ---------- de verbinding ---------- */

  function stopVerbinding(){
    clearTimeout(herstelTimer); herstelTimer = null;
    if(ws){ const w = ws; ws = null; try{ w.close(); }catch(_){} }
    abonnementVoor = '';
  }

  function planHerstel(){
    if(herstelTimer || !sleutel) return;
    herstelTimer = setTimeout(() => { herstelTimer = null; verbind(); }, wacht);
    wacht = Math.min(wacht * 2, 5 * 60e3);
  }

  function verbind(){
    stopVerbinding();
    const abo = kern.abonnement(sleutel, staat.boten);
    if(!sleutel){ zetStatus('uit', ontvangerAan() ? 'Alleen de eigen ontvanger (geen AISStream-sleutel).' : 'Nog geen AISStream-sleutel ingevuld.'); return; }
    if(!abo.FiltersShipMMSI.length){ zetStatus('uit', 'Nog geen boten met een MMSI-nummer.'); return; }
    if(typeof WebSocket === 'undefined'){
      zetStatus('geen-websocket', 'De laptop heeft Node 22 of nieuwer nodig om AIS te volgen; de app volgt nu zelf.');
      return;
    }
    zetStatus('verbinden', 'Verbinden met AISStream…');
    let w;
    try{ w = new WebSocket(AIS_URL); }catch(e){ zetStatus('fout', 'Verbinden mislukt: ' + e.message); planHerstel(); return; }
    ws = w;
    abonnementVoor = sleutel + '|' + abo.FiltersShipMMSI.join(',');
    verbondenOp = Date.now();
    let ooitBericht = false;
    w.onopen = () => { w.send(JSON.stringify(abo)); zetStatus('verbonden', 'Verbonden, wacht op posities…'); log('AIS: verbonden met AISStream'); };
    w.onmessage = async (e) => {
      let tekst = e.data;
      try{
        if(typeof tekst !== 'string'){
          tekst = tekst instanceof ArrayBuffer ? Buffer.from(tekst).toString('utf8')
            : (tekst && typeof tekst.text === 'function' ? await tekst.text() : String(tekst));
        }
      }catch(_){ return; }
      let bericht;
      try{ bericht = JSON.parse(tekst); }catch(_){ return; }
      if(bericht && bericht.error){ zetStatus('fout', 'AISStream: ' + bericht.error); log('AIS:', bericht.error); return; }
      ooitBericht = true; wacht = 5000; laatsteBericht = Date.now();
      zetStatus('verbonden', 'Verbonden');
      const pos = kern.leesBericht(bericht);
      if(!pos) return;
      verwerk(pos);
    };
    w.onclose = () => {
      if(ws !== w) return;
      ws = null; abonnementVoor = '';
      if(!ooitBericht && status.staat !== 'fout') zetStatus('fout', 'Verbinding gesloten zonder posities. Klopt de sleutel? Probeert het opnieuw.');
      planHerstel();
    };
    w.onerror = () => { if(ws === w) zetStatus('fout', 'Verbindingsfout met AISStream. Probeert het opnieuw.'); };
  }

  // Wachthond: een stille verbinding (wifi even weg, laptop uit de slaap) opnieuw opzetten.
  const wachthond = setInterval(() => {
    if(!ws || !sleutel) return;
    const sinds = Math.max(laatsteBericht || 0, verbondenOp || 0);
    if(sinds && Date.now() - sinds > STIL_MS){ log('AIS: al 10 minuten niets binnen, opnieuw verbinden'); verbind(); }
  }, 60e3);
  wachthond.unref && wachthond.unref();

  /* ---------- naar buiten ---------- */

  /* De instellingen opnieuw lezen (na een wijziging van een apparaat). Alleen
     opnieuw verbinden als de sleutel of de lijst MMSI's anders is. */
  function herlaad(){
    staat.boten = json('duwbakken-ais-boten', []);
    staat.zones = json('duwbakken-ais-zones', []);
    staat.groepen = json('duwbakken-ais-groepen', []);
    const inst = json('duwbakken-ais-instellingen', {});
    sleutel = (inst.sleutel || '').trim();
    ontvanger.start(inst.ontvanger && inst.ontvanger.aan ? inst.ontvanger.adres || '10110' : '');
    const abo = kern.abonnement(sleutel, staat.boten);
    const nieuwAbo = sleutel + '|' + abo.FiltersShipMMSI.join(',');
    if(nieuwAbo !== abonnementVoor || (!ws && !herstelTimer) || !sleutel) verbind();
    else zendUit();
  }

  /* Eenmalig: een apparaat dat al vaartijd en meldingen had (van vóór de
     server), mag die hier neerzetten zolang de server er zelf nog geen heeft. */
  function vul(body){
    let anders = false;
    if(!Object.keys(staat.vaartijd).length && body && body.vaartijd && typeof body.vaartijd === 'object'){
      staat.vaartijd = body.vaartijd; anders = true;
    }
    if(!meldingen.length && body && Array.isArray(body.meldingen)){
      meldingen = body.meldingen.slice(0, kern.K.MAX_MELDINGEN); anders = true;
    }
    if(anders){ bewaar(true); zendUit(true); }
    return anders;
  }

  function ontvangerAan(){ return ontvanger.aan(); }

  function stop(){ clearInterval(wachthond); stopVerbinding(); ontvanger.stop(); if(vuil) bewaar(true); }

  /* 1.411: "AIS verversen" in de app: de verbinding opnieuw opzetten. */
  function ververs(){ log('AIS: verversen gevraagd vanuit de app'); verbind(); return true; }

  return { herlaad, momentopname, vul, ververs, stop, status: () => ({ ...status, laatste: laatste(), ontvanger: ontvanger.status() }) };
};
