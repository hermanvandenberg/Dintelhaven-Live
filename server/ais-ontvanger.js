/* Auteur: HvdB */
/* Eigen AIS-ontvanger bij de haven (1.414).
 * AISStream krijgt zijn posities van vrijwilligers; in de haven zijn er gaten.
 * Een eigen ontvanger op of bij de laptop hoort de schepen zelf. Hij geeft
 * NMEA-regels (!AIVDM...) door op een van twee manieren:
 *   - UDP naar de laptop: vul een poort in, bv. 10110 (AIS-catcher, de meeste
 *     ontvangers en programma's kunnen dat);
 *   - TCP: vul het adres van de ontvanger in, bv. 192.168.4.1:2000 (wifi-
 *     ontvangers die zelf een server zijn). Valt die weg, dan opnieuw.
 * Elke positie gaat naar `opPositie`, net als een positie van AISStream.
 */
'use strict';
const dgram = require('dgram');
const net = require('net');
const { leesNmea } = require('./ais-nmea');

const HERSTEL_MS = 15e3;

/**
 * Maakt een ontvanger die NMEA-regels leest en posities doorgeeft.
 * @param {{ log: Function, opPositie: Function, opStatus: Function }} opties - log, wat te doen met een positie, en een nieuwe status
 * @returns {{ start: Function, stop: Function, aan: Function, status: Function }} de ontvanger
 */
module.exports = function maakAisOntvanger({ log, opPositie, opStatus }){
  let instelling = '';            // '' = uit, '10110' = UDP, 'host:poort' = TCP
  let udp = null, tcp = null, herstel = null;
  const status = { staat: 'uit', tekst: '', laatste: null, regels: 0 };

  function zet(staat, tekst){
    if(status.staat === staat && status.tekst === tekst) return;
    status.staat = staat; status.tekst = tekst;
    opStatus && opStatus();
  }

  function regel(tekst){
    const pos = leesNmea(tekst);
    if(!pos) return;
    status.regels++; status.laatste = pos.t;
    if(status.staat !== 'ontvangt') zet('ontvangt', 'Ontvangt posities');
    opPositie(pos);
  }

  function sluit(){
    clearTimeout(herstel); herstel = null;
    if(udp){ try{ udp.close(); }catch(_){} udp = null; }
    if(tcp){ const s = tcp; tcp = null; s.destroy(); }
  }

  function luisterUdp(poort){
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp = s;
    s.on('message', (buf) => buf.toString('latin1').split(/\r?\n/).forEach(r => r && regel(r)));
    s.on('error', (e) => {
      if(udp !== s) return;
      zet('fout', 'Poort ' + poort + ' gaat niet open: ' + e.message);
      log('AIS-ontvanger:', e.message);
      sluit();
    });
    s.bind(poort, () => { zet('wacht', 'Luistert op UDP-poort ' + poort + ', nog niets ontvangen'); log('AIS-ontvanger: luistert op UDP-poort', poort); });
  }

  function verbindTcp(host, poort){
    const s = net.connect({ host, port: poort });
    tcp = s;
    let rest = '';
    s.setEncoding('latin1');
    s.setTimeout(10 * 60e3);
    s.on('connect', () => { zet('wacht', 'Verbonden met ' + host + ':' + poort + ', nog niets ontvangen'); log('AIS-ontvanger: verbonden met', host + ':' + poort); });
    s.on('data', (d) => {
      const delen = (rest + d).split(/\r?\n/);
      rest = delen.pop();
      if(rest.length > 2000) rest = '';
      delen.forEach(r => r && regel(r));
    });
    s.on('timeout', () => s.destroy(new Error('al 10 minuten niets')));
    s.on('error', (e) => { if(tcp === s) zet('fout', host + ':' + poort + ' niet bereikbaar (' + e.message + '). Probeert het opnieuw.'); });
    s.on('close', () => {
      if(tcp !== s) return;
      tcp = null;
      if(status.staat !== 'fout') zet('fout', 'Verbinding met ' + host + ':' + poort + ' weg. Probeert het opnieuw.');
      herstel = setTimeout(() => { herstel = null; if(instelling) verbindTcp(host, poort); }, HERSTEL_MS);
    });
  }

  /**
   * Zet de ontvanger aan (of anders) volgens de instelling uit de app.
   * @param {string} nieuw - '' (uit), een poort ('10110') of 'host:poort'
   */
  function start(nieuw){
    nieuw = String(nieuw || '').trim();
    if(nieuw === instelling && (udp || tcp || herstel)) return;
    sluit();
    instelling = nieuw;
    status.regels = 0;
    if(!nieuw){ zet('uit', ''); return; }
    const m = /^(?:([\w.-]+):)?(\d{1,5})$/.exec(nieuw);
    const poort = m ? Number(m[2]) : 0;
    if(!m || poort < 1 || poort > 65535){ zet('fout', 'Vul een poort (bv. 10110) of een adres met poort (bv. 192.168.4.1:2000) in.'); return; }
    if(m[1]) verbindTcp(m[1], poort); else luisterUdp(poort);
  }

  function stop(){ instelling = ''; sluit(); }

  return { start, stop, aan: () => !!instelling, status: () => ({ ...status }) };
};
