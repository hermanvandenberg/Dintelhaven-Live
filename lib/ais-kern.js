/* Auteur: HvdB */
/* AIS-kern (1.399): het rekenwerk van Vaarwegen, gedeeld door de app
 * (src/10-vaarwegen.js, via <script src="lib/ais-kern.js">) en de server op de
 * laptop (server/ais-volger.js, via require). Zo meldt de server precies
 * hetzelfde als de app deed. Geen DOM, geen opslag: alles gaat via `staat`.
 *
 *   staat = { boten, groepen, zones, posities, zoneStand, vaartijd, sporen? }
 *   AisKern.verwerkPositie(staat, pos, { gebruiker }) → nieuwe meldingen
 *
 * De regels (zie ook src/10-vaarwegen.js):
 *  - "Bakken zijn vertrokken": een boot verlaat een zone, en voer daarin niet in
 *    de pijlrichting (dan voer hij door, naar ons toe).
 *  - "Duwboot komt eraan": een boot vaart in de zone in de pijlrichting (± PIJL_MARGE
 *    graden, ≥ MIN_SOG kn), één keer per keer dat hij erin komt; of hij voer
 *    tussen twee posities in de pijlrichting dwars door de zone.
 *  - Binnen ↔ buiten na BEVESTIG posities op rij als ze vlak na elkaar komen
 *    (GPS-ruis aan de kade), anders na één.
 *  - Vaartijd van boten in de groep met eigen:true, per dienst (07–19, 19–07).
 */
(function(wortel){
  'use strict';

  const K = {
    BERICHTSOORTEN: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'],
    MIN_SOG: 1.0,
    PIJL_MARGE: 60,
    BEVESTIG: 2,
    SNEL_NA_ELKAAR_MS: 60e3,
    SPOOR: 30,
    MAX_MELDINGEN: 200,
    VAART_MIN_SOG: 0.5,
    VAART_MAX_GAT: 10 * 60e3,
    VAART_BEWAAR: 62,
    DIENST_WISSELUREN: [7, 19]
  };

  function puntInZone(lat, lon, punten){
    if(!punten || punten.length < 3) return false;
    let binnen = false;
    for(let i = 0, j = punten.length - 1; i < punten.length; j = i++){
      const [yi, xi] = punten[i], [yj, xj] = punten[j];
      if(((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) binnen = !binnen;
    }
    return binnen;
  }
  function koersTussen(a, b){
    const rad = Math.PI / 180;
    const f1 = a[0] * rad, f2 = b[0] * rad, dl = (b[1] - a[1]) * rad;
    const y = Math.sin(dl) * Math.cos(f2);
    const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  function afstandMeter(a, b){
    const rad = Math.PI / 180, R = 6371000;
    const dF = (b[0] - a[0]) * rad, dL = (b[1] - a[1]) * rad;
    const h = Math.sin(dF / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dL / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function hoekVerschil(a, b){
    const d = Math.abs(((a - b) % 360 + 360) % 360);
    return d > 180 ? 360 - d : d;
  }
  function zoneRichting(zone){ return zone && zone.pijl ? koersTussen(zone.pijl.van, zone.pijl.naar) : null; }
  function geldigeMmsi(s){ return /^\d{9}$/.test(String(s || '').trim()); }
  function lijnstukkenSnijden(a, b, c, d){
    const o = (p, q, r) => (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
  }
  /* 1.413: afstand in meters van een punt tot een zone (0 als het erin ligt).
     Vlak rekenen rond het punt is ruim nauwkeurig genoeg voor een haven. */
  function afstandTotZone(lat, lon, punten){
    if(!punten || punten.length < 3) return Infinity;
    if(puntInZone(lat, lon, punten)) return 0;
    const mx = 111320 * Math.cos(lat * Math.PI / 180), my = 110540;
    const xy = ([a, b]) => [(b - lon) * mx, (a - lat) * my];
    let min = Infinity;
    for(let i = 0, j = punten.length - 1; i < punten.length; j = i++){
      const [x1, y1] = xy(punten[j]), [x2, y2] = xy(punten[i]);
      const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / l2)) : 0;
      const px = x1 + t * dx, py = y1 + t * dy;
      min = Math.min(min, Math.hypot(px, py));
    }
    return min;
  }
  function lijnDoorZone(a, b, punten){
    if(!punten || punten.length < 3) return false;
    for(let i = 0, j = punten.length - 1; i < punten.length; j = i++){
      if(lijnstukkenSnijden(a, b, punten[j], punten[i])) return true;
    }
    return false;
  }

  // Het laatste wisselmoment (07:00 of 19:00) op of vóór `nu`, in ms.
  function dienstBegin(nu){
    for(let dag = 0; dag < 2; dag++){
      for(const uur of [...K.DIENST_WISSELUREN].reverse()){
        const t = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate() - dag, uur);
        if(t <= nu) return t.getTime();
      }
    }
  }
  // Het eerstvolgende wisselmoment ná het begin van een dienst (12 uur later, ook rond zomertijd goed).
  function dienstEinde(start){
    const d = new Date(start);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 12).getTime();
  }

  function groepVan(staat, boot){ return (staat.groepen || []).find(g => g.id === boot.groepId) || null; }
  function isEigen(staat, boot){ const g = groepVan(staat, boot); return !!(g && g.eigen); }

  /* Korte meldingtekst (1.402, op verzoek): datum, tijd, schip, wat: zone, snelheid.
     Bijv. "10-11 07:55 · Herkules · komt eraan: Dintelhaven · 6,0 kn". Ook voor
     meldingen van vóór 1.402, die worden uit hun velden opnieuw opgebouwd. */
  function meldTekst(m){
    const d = new Date(m.t), twee = (n) => String(n).padStart(2, '0');
    const wanneer = `${twee(d.getDate())}-${twee(d.getMonth() + 1)} ${twee(d.getHours())}:${twee(d.getMinutes())}`;
    const wat = m.soort === 'vertrokken' ? 'vertrokken' : 'komt eraan';
    const delen = [wanneer, m.boot, `${wat}: ${m.zone}`];
    if(m.sog != null && isFinite(m.sog)) delen.push(`${Number(m.sog).toFixed(1).replace('.', ',')} kn`);
    return delen.join(' · ');
  }

  function maakMelding(soort, boot, zone, sog, t){
    const m = { id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: t || Date.now(),
      soort, mmsi: String(boot.mmsi), boot: boot.naam, zoneId: zone.id, zone: zone.naam };
    if(sog != null && isFinite(sog)) m.sog = sog;
    m.tekst = meldTekst(m);
    return m;
  }

  function vaartijdBij(staat, mmsi, vorige, t, gebruiker){
    const dt = t - vorige.t;
    if(!(dt > 0) || dt > K.VAART_MAX_GAT) return;
    const voer = vorige.sog != null ? vorige.sog >= K.VAART_MIN_SOG : false;
    const perBoot = staat.vaartijd[mmsi] || (staat.vaartijd[mmsi] = {});
    let van = vorige.t;
    while(van < t){
      const start = dienstBegin(new Date(van));
      const eind = Math.min(t, dienstEinde(start));
      const r = perBoot[start] || (perBoot[start] = { vaar: 0, gevolgd: 0, door: '' });
      r.gevolgd += eind - van;
      if(voer) r.vaar += eind - van;
      if(gebruiker && !r.door.split(', ').includes(gebruiker)) r.door = r.door ? r.door + ', ' + gebruiker : gebruiker;
      van = eind;
    }
    Object.keys(perBoot).map(Number).sort((a, b) => b - a).slice(K.VAART_BEWAAR).forEach(k => delete perBoot[k]);
  }

  /* Eén positie verwerken. Werkt staat bij en geeft de nieuwe meldingen terug.
     COG 360 en SOG 102.3 betekenen in AIS "niet beschikbaar"; dan rekenen we de
     koers uit de vorige positie. */
  function verwerkPositie(staat, pos, opties = {}){
    const mmsi = String(pos.mmsi);
    const boot = (staat.boten || []).find(b => String(b.mmsi) === mmsi);
    if(!boot || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return [];
    if(Math.abs(pos.lat) > 90 || Math.abs(pos.lon) > 180) return [];   // 91/181 = geen positie
    const t = pos.t || Date.now();
    const vorige = staat.posities[mmsi];
    let cog = Number.isFinite(pos.cog) && pos.cog >= 0 && pos.cog < 360 ? pos.cog : null;
    const sog = Number.isFinite(pos.sog) && pos.sog < 102.2 ? pos.sog : null;
    const vorigPunt = vorige ? [vorige.lat, vorige.lon] : null;
    const stukKoers = vorigPunt && afstandMeter(vorigPunt, [pos.lat, pos.lon]) > 30 ? koersTussen(vorigPunt, [pos.lat, pos.lon]) : null;
    if(cog == null) cog = stukKoers;
    if(isEigen(staat, boot) && vorige) vaartijdBij(staat, mmsi, vorige, t, opties.gebruiker || '');
    const nodig = vorige && t - vorige.t < K.SNEL_NA_ELKAAR_MS ? K.BEVESTIG : 1;
    staat.posities[mmsi] = { lat: pos.lat, lon: pos.lon, cog, sog, t };
    if(staat.sporen){
      const spoor = staat.sporen.get(mmsi) || [];
      spoor.push([pos.lat, pos.lon, t]);
      if(spoor.length > K.SPOOR) spoor.shift();
      staat.sporen.set(mmsi, spoor);
    }

    const varend = sog == null ? cog != null : sog >= K.MIN_SOG;
    const nieuw = [];
    const standen = staat.zoneStand[mmsi] || (staat.zoneStand[mmsi] = {});
    for(const zone of staat.zones || []){
      const st = standen[zone.id] || (standen[zone.id] = { binnen: null, kandidaat: null, teller: 0, komtGemeld: false, richting: null });
      const nu = puntInZone(pos.lat, pos.lon, zone.punten);
      const pijl = zoneRichting(zone);
      const wasBinnen = st.binnen;
      // Per zone kun je kiezen voor welke groepen hij meldt (1.400); de stand wordt altijd bijgehouden.
      const meldtVoor = !Array.isArray(zone.groepen) || zone.groepen.includes(boot.groepId || '');
      const meld = (soort) => { if(meldtVoor) nieuw.push(maakMelding(soort, boot, zone, sog, t)); };

      if(st.binnen === null){
        st.binnen = nu;                       // eerste keer: alleen de stand neerzetten
      } else if(nu !== st.binnen){
        if(st.kandidaat === nu) st.teller++; else { st.kandidaat = nu; st.teller = 1; }
        if(st.teller >= nodig){
          st.binnen = nu; st.kandidaat = null; st.teller = 0;
          if(!nu){
            if(zone.meldVertrek !== false && st.richting !== 'mee') meld('vertrokken');
            st.richting = null;
          }
          st.komtGemeld = false;
        }
      } else { st.kandidaat = null; st.teller = 0; }

      // Erdoorheen gevaren zonder positie in de zone: "komt eraan" als hij in de pijlrichting voer.
      if(wasBinnen === false && !nu && vorigPunt && pijl != null && zone.meldKomt !== false && cog != null
         && hoekVerschil(cog, pijl) <= K.PIJL_MARGE && lijnDoorZone(vorigPunt, [pos.lat, pos.lon], zone.punten)){
        meld('komt');
      }
      /* 1.413: in de haven valt het signaal soms weg en springt een boot over een
         zone heen. Voer hij tussen twee posities tegen de pijl in dwars door de
         zone, dan is hij vertrokken, net als wie er met een positie in lag. */
      if(wasBinnen === false && !nu && vorigPunt && pijl != null && zone.meldVertrek !== false && stukKoers != null
         && hoekVerschil(stukKoers, pijl) >= 180 - K.PIJL_MARGE && lijnDoorZone(vorigPunt, [pos.lat, pos.lon], zone.punten)){
        meld('vertrokken');
      }
      if(st.binnen && varend && cog != null && pijl != null){
        const d = hoekVerschil(cog, pijl);
        st.richting = d <= K.PIJL_MARGE ? 'mee' : (d >= 180 - K.PIJL_MARGE ? 'tegen' : st.richting);
        if(st.richting === 'mee' && zone.meldKomt !== false && !st.komtGemeld){
          st.komtGemeld = true;
          meld('komt');
        }
      }
    }
    return nieuw;
  }

  /* AISStream-bericht → positie (of null). Klasse A en klasse B. */
  function leesBericht(bericht, t){
    if(!bericht || bericht.error) return null;
    const soort = bericht.MessageType;
    const inhoud = bericht.Message && bericht.Message[soort];
    if(!inhoud || !K.BERICHTSOORTEN.includes(soort)) return null;
    const meta = bericht.MetaData || {};
    return {
      mmsi: inhoud.UserID != null ? inhoud.UserID : meta.MMSI,
      lat: inhoud.Latitude != null ? inhoud.Latitude : meta.latitude,
      lon: inhoud.Longitude != null ? inhoud.Longitude : meta.longitude,
      cog: inhoud.Cog, sog: inhoud.Sog, t: t || Date.now()
    };
  }

  /* De abonnementsvraag aan AISStream. */
  function abonnement(sleutel, boten){
    const mmsis = (boten || []).map(b => String(b.mmsi)).filter(geldigeMmsi);
    return { APIKey: sleutel, BoundingBoxes: [[[-90, -180], [90, 180]]],
      FiltersShipMMSI: mmsis.slice(0, 50), FilterMessageTypes: K.BERICHTSOORTEN };
  }

  /* Zonestand zonder de tellers (die horen bij één verbinding), om te bewaren. */
  function kaleZoneStand(zoneStand){
    const kaal = {};
    for(const [mmsi, zones] of Object.entries(zoneStand || {})){
      kaal[mmsi] = {};
      for(const [zid, st] of Object.entries(zones)) kaal[mmsi][zid] = { binnen: st.binnen, richting: st.richting, komtGemeld: st.komtGemeld };
    }
    return kaal;
  }
  function volleZoneStand(kaal){
    const vol = {};
    for(const [mmsi, zones] of Object.entries(kaal || {})){
      vol[mmsi] = {};
      for(const [zid, st] of Object.entries(zones || {})){
        vol[mmsi][zid] = { binnen: st.binnen == null ? null : !!st.binnen, kandidaat: null, teller: 0,
          komtGemeld: !!st.komtGemeld, richting: st.richting || null };
      }
    }
    return vol;
  }

  const AisKern = { K, puntInZone, koersTussen, afstandMeter, hoekVerschil, zoneRichting, geldigeMmsi,
    lijnstukkenSnijden, lijnDoorZone, afstandTotZone, dienstBegin, dienstEinde, groepVan, isEigen, maakMelding, meldTekst, vaartijdBij,
    verwerkPositie, leesBericht, abonnement, kaleZoneStand, volleZoneStand };
  if(typeof module !== 'undefined' && module.exports) module.exports = AisKern;
  else wortel.AisKern = AisKern;
})(typeof globalThis !== 'undefined' ? globalThis : this);
