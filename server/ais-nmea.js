/* Auteur: HvdB */
/* AIS-berichten van een eigen ontvanger lezen (1.414).
 * Een AIS-ontvanger (of AIS-catcher met een USB-stickje) geeft regels als
 *   !AIVDM,1,1,,A,13u?etPv2;0n:dDPwUM1U1Cb069D,0*24
 * Hier halen we daar de positie uit, in hetzelfde formaat als AisKern.leesBericht:
 *   { mmsi, lat, lon, cog, sog, t }
 * Alleen positieberichten: type 1, 2, 3 (klasse A, binnenvaart) en 18, 19
 * (klasse B). Die passen altijd in één regel. Alles anders: null.
 * Geen afhankelijkheden, geen netwerk: puur rekenwerk, zodat het te testen is.
 */
'use strict';

/**
 * Controleert de checksum achter de * van een NMEA-regel.
 * @param {string} zin - de regel vanaf het ! (zonder tagblok)
 * @returns {boolean} true als hij klopt of als er geen checksum is
 */
function checksumKlopt(zin){
  const ster = zin.lastIndexOf('*');
  if(ster < 0) return true;
  const verwacht = parseInt(zin.slice(ster + 1, ster + 3), 16);
  if(Number.isNaN(verwacht)) return false;
  let x = 0;
  for(let i = 1; i < ster; i++) x ^= zin.charCodeAt(i);
  return x === verwacht;
}

/**
 * Zet de 6-bits-tekens van het bericht om in een rij bits (0/1).
 * @param {string} inhoud - het vijfde veld van de AIVDM-regel
 * @returns {number[]} de bits
 */
function naarBits(inhoud){
  const bits = [];
  for(const teken of inhoud){
    let w = teken.charCodeAt(0) - 48;
    if(w > 40) w -= 8;
    if(w < 0 || w > 63) return [];
    for(let i = 5; i >= 0; i--) bits.push((w >> i) & 1);
  }
  return bits;
}

/**
 * Leest een getal uit de bits.
 * @param {number[]} bits - de bits van het bericht
 * @param {number} van - eerste bit
 * @param {number} lengte - aantal bits
 * @param {boolean} [teken] - true voor een getal met teken (two's complement)
 * @returns {number} het getal
 */
function getal(bits, van, lengte, teken = false){
  let w = 0;
  for(let i = 0; i < lengte; i++) w = w * 2 + (bits[van + i] || 0);
  if(teken && bits[van]) w -= Math.pow(2, lengte);
  return w;
}

/**
 * Haalt de positie uit één NMEA-regel van een AIS-ontvanger.
 * @param {string} regel - de regel zoals hij binnenkomt (mag een tagblok \...\ ervoor hebben)
 * @param {number} [t] - het moment van ontvangst in ms
 * @returns {{mmsi:string, lat:number, lon:number, cog:?number, sog:?number, t:number}|null} de positie, of null
 */
function leesNmea(regel, t){
  if(typeof regel !== 'string') return null;
  const begin = regel.indexOf('!');
  if(begin < 0) return null;
  const zin = regel.slice(begin).trim();
  if(!/^!(AI|AB|BS|SA)VD[MO],/.test(zin) || !checksumKlopt(zin)) return null;
  const v = zin.split(',');
  if(v.length < 7 || v[1] !== '1') return null;          // positieberichten zijn altijd één regel
  const bits = naarBits(v[5]);
  if(bits.length < 133) return null;
  const type = getal(bits, 0, 6);
  let sogBit, lonBit, latBit, cogBit;
  if(type >= 1 && type <= 3){ sogBit = 50; lonBit = 61; latBit = 89; cogBit = 116; }
  else if(type === 18 || type === 19){ sogBit = 46; lonBit = 57; latBit = 85; cogBit = 112; }
  else return null;
  const mmsi = String(getal(bits, 8, 30)).padStart(9, '0');
  const lon = getal(bits, lonBit, 28, true) / 600000;
  const lat = getal(bits, latBit, 27, true) / 600000;
  if(Math.abs(lon) > 180 || Math.abs(lat) > 90) return null;   // 181 / 91 = onbekend
  const sogRuw = getal(bits, sogBit, 10), cogRuw = getal(bits, cogBit, 12);
  return {
    mmsi, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6,
    sog: sogRuw === 1023 ? null : sogRuw / 10,
    cog: cogRuw >= 3600 ? null : cogRuw / 10,
    t: t || Date.now()
  };
}

module.exports = { leesNmea, checksumKlopt };
