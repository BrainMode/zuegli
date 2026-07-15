// Phase-0-Smoke-Test für die Live-Karte: verifiziert SIRI-ET-Feed und
// Service-Points-CSV (Koordinatenquelle) sowie die Join-Keys.
// Aufruf: node --env-file=.env.local scripts/smoke-livemap.mjs

import { gunzipSync } from 'node:zlib';

const ET_KEY = process.env.OTD_SIRIET_KEY;
if (!ET_KEY) {
  console.error('OTD_SIRIET_KEY fehlt (.env.local).');
  process.exit(1);
}

let failures = 0;
async function section(title, fn) {
  console.log(`\n${title}`);
  try {
    await fn();
  } catch (err) {
    failures++;
    console.log(`   ❌ ${err.message}`);
  }
}

await section('1) SIRI-ET Feed …', async () => {
  const res = await fetch('https://api.opentransportdata.swiss/la/siri-et', {
    headers: { Authorization: `Bearer ${ET_KEY}`, 'User-Agent': 'zuegli-smoke' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const xml = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf-8');
  console.log(`   ${Math.round(bytes.length / 1024 / 1024)} MB transfer, ${Math.round(xml.length / 1024 / 1024)} MB XML`);
  const journeys = xml.match(/<EstimatedVehicleJourney>/g)?.length ?? 0;
  const modes = {};
  for (const m of xml.matchAll(/<VehicleMode>([a-z]+)<\/VehicleMode>/g)) modes[m[1]] = (modes[m[1]] ?? 0) + 1;
  console.log(`   ${journeys} Journeys:`, JSON.stringify(modes));
  const ref = /<DatedVehicleJourneyRef>([^<]+)</.exec(xml)?.[1];
  const stops = [...xml.matchAll(/<StopPointRef>([^<]+)</g)].slice(0, 400).map((m) => m[1]);
  const sloids = stops.filter((s) => s.startsWith('ch:1:sloid:')).length;
  const uics = stops.filter((s) => /ScheduledStopPoint:\d+/.test(s)).length;
  console.log(`   Beispiel journeyRef: ${ref}`);
  console.log(`   StopPointRef-Stichprobe (400): ${sloids} sloid, ${uics} ScheduledStopPoint, Beispiele: ${stops[0]}, ${stops[1]}`);
  if (!ref?.startsWith('ch:1:sjyid:')) throw new Error('journeyRef hat NICHT das sjyid-Format — Join mit tripIds prüfen!');
  console.log('   ✓ journeyRef ist sjyid-Format (joinbar mit tripId-Prefix)');
});

await section('2) Service-Points-CSV (ATLAS) …', async () => {
  const pages = [
    process.env.OTD_STOPS_DATASET_URL,
    'https://data.opentransportdata.swiss/dataset/service-points-actual-date',
    'https://data.opentransportdata.swiss/dataset/service-point-v2',
  ].filter(Boolean);
  let csvUrl = null;
  for (const page of pages) {
    const res = await fetch(page, { headers: { 'User-Agent': 'Mozilla/5.0 zuegli-smoke' } });
    if (!res.ok) { console.log(`   ${page} → HTTP ${res.status}`); continue; }
    const html = await res.text();
    const m = /href="(https:\/\/data\.opentransportdata\.swiss\/[^"]*\/download\/[^"]*\.csv[^"]*)"/i.exec(html)
      ?? /href="(https:\/\/[^"]*\/download\/[^"]*(?:service[_-]?point|dienststellen|haltestellen)[^"]*)"/i.exec(html);
    if (m) { csvUrl = m[1]; console.log(`   Seite: ${page}`); break; }
    console.log(`   ${page}: kein CSV-Link gefunden; Download-Links:`);
    for (const l of [...html.matchAll(/href="(https:\/\/[^"]*\/download\/[^"]*)"/g)].slice(0, 5)) console.log(`     ${l[1]}`);
  }
  if (!csvUrl) throw new Error('Keine CSV-URL gefunden');
  console.log(`   CSV: ${csvUrl.split('/').pop()}`);
  const res = await fetch(csvUrl, { headers: { 'User-Agent': 'Mozilla/5.0 zuegli-smoke' } });
  if (!res.ok) throw new Error(`CSV HTTP ${res.status}`);
  let bytes = Buffer.from(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  // ZIP? (PK)
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    console.log(`   Achtung: Download ist ein ZIP (${Math.round(bytes.length / 1024 / 1024)} MB) — stops.ts muss entpacken (fflate unzipSync).`);
    const { unzipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(bytes));
    const name = Object.keys(files).find((n) => n.endsWith('.csv')) ?? Object.keys(files)[0];
    console.log(`   Enthält: ${Object.keys(files).slice(0, 5).join(', ')}`);
    bytes = Buffer.from(files[name]);
  }
  const text = bytes.toString('utf-8');
  const lines = text.split('\n');
  console.log(`   ${Math.round(text.length / 1024 / 1024)} MB, ${lines.length} Zeilen`);
  console.log(`   Header: ${lines[0].slice(0, 300)}`);
  const delim = lines[0].includes(';') ? ';' : ',';
  const header = lines[0].replace(/^﻿/, '').split(delim).map((h) => h.trim().replace(/^"|"$/g, ''));
  const idx = (n) => header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const iSloid = idx('sloid'), iNum = idx('number'), iEast = idx('wgs84East'), iNorth = idx('wgs84North'), iName = idx('designationOfficial');
  console.log(`   Spalten-Indizes: sloid=${iSloid} number=${iNum} wgs84East=${iEast} wgs84North=${iNorth} name=${iName}`);
  const sample = lines.slice(1, 2000).map((l) => l.split(delim)).find((c) => c[iEast] && Number(c[iEast]) > 5);
  if (sample) console.log(`   Beispiel: sloid=${sample[iSloid]} number=${sample[iNum]} lon=${sample[iEast]} lat=${sample[iNorth]} name=${sample[iName]}`);
  if (iEast < 0 || iNorth < 0) throw new Error('wgs84-Spalten nicht gefunden — Header prüfen!');
});

console.log(failures === 0 ? '\n✅ Livemap-Smoke OK.' : `\n⚠️ ${failures} Sektion(en) mit Problemen.`);
