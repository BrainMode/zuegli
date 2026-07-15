// Phase-0-Smoke-Test: verifiziert die opentransportdata.swiss-Dienste end-to-end
// und die Feldnamen, auf denen lib/sbb/format.ts aufbaut.
// Aufruf: npm run smoke   (lädt .env.local via node --env-file)
//
// Sektionen: 1 Bahnhofssuche, 2 Abfahrten, 3 Verbindung, 4 Zuglauf,
//            5 Wagenreihung, 6 Belegung (Dataset-Discovery), 7 Störungen.
// Braucht OTD_API_KEY (gratis: https://api-manager.opentransportdata.swiss/).
// Ein Fehler in einer Sektion bricht die anderen nicht ab.

const KEY = process.env.OTD_API_KEY;
if (!KEY) {
  console.error(
    'OTD_API_KEY fehlt. Gratis-Key holen: https://api-manager.opentransportdata.swiss/\n' +
      'Dann in .env.local eintragen und erneut: npm run smoke',
  );
  process.exit(1);
}

const OJP = process.env.OTD_OJP_ENDPOINT ?? 'https://api.opentransportdata.swiss/ojp20';
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

async function ojp(serviceXml) {
  const now = new Date().toISOString();
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri" version="2.0">
  <OJPRequest>
    <siri:ServiceRequest>
      <siri:ServiceRequestContext><siri:Language>de</siri:Language></siri:ServiceRequestContext>
      <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
      <siri:RequestorRef>zuegli-smoke</siri:RequestorRef>
      ${serviceXml}
    </siri:ServiceRequest>
  </OJPRequest>
</OJP>`;
  const res = await fetch(OJP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml', Authorization: `Bearer ${KEY}` },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

// Mini-Helfer: erstes/alle Vorkommen eines Elements (prefix-agnostisch, mit
// Wortgrenze — "Duration" matcht nicht "DurationText").
function el(xml, name) {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml ?? '');
  return m ? m[1].trim() : null;
}
function els(xml, name) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g');
  let m;
  while ((m = re.exec(xml ?? '')) !== null) out.push(m[1]);
  return out;
}
const textOf = (frag) => (frag == null ? null : (el(frag, 'Text') ?? frag).replace(/<[^>]+>/g, '').trim());
const now = new Date().toISOString();
const hhmm = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' })
    : '–';

let olten = null;
let firstJourneyRef = null;
let firstDayRef = null;
const trainNumbers = []; // Kandidaten für Formation (SBB-Züge bevorzugt)

await section('1) LocationInformation("Olten") …', async () => {
  const xml = await ojp(`<OJPLocationInformationRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <InitialInput><Name>Olten</Name></InitialInput>
        <Restrictions><Type>stop</Type><NumberOfResults>3</NumberOfResults></Restrictions>
      </OJPLocationInformationRequest>`);
  for (const pr of els(xml, 'PlaceResult').slice(0, 3)) {
    console.log(`   ${el(pr, 'StopPlaceRef')}  ${textOf(el(pr, 'StopPlaceName'))}`);
  }
  olten = el(els(xml, 'PlaceResult')[0] ?? '', 'StopPlaceRef');
  if (!olten) throw new Error('Kein StopPlaceRef für Olten gefunden');
});

await section('2) StopEvents(Olten, departures) …', async () => {
  if (!olten) throw new Error('übersprungen (Sektion 1 fehlgeschlagen)');
  const xml = await ojp(`<OJPStopEventRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <Location>
          <PlaceRef><siri:StopPointRef>${olten}</siri:StopPointRef><Name><Text>Olten</Text></Name></PlaceRef>
          <DepArrTime>${now}</DepArrTime>
        </Location>
        <Params>
          <NumberOfResults>8</NumberOfResults>
          <StopEventType>departure</StopEventType>
          <IncludePreviousCalls>false</IncludePreviousCalls>
          <IncludeOnwardCalls>false</IncludeOnwardCalls>
          <UseRealtimeData>full</UseRealtimeData>
        </Params>
      </OJPStopEventRequest>`);
  for (const se of els(xml, 'StopEvent').slice(0, 6)) {
    const dep = el(se, 'ServiceDeparture');
    const plan = el(dep, 'TimetabledTime');
    const est = el(dep, 'EstimatedTime');
    const quay = textOf(el(se, 'EstimatedQuay') ?? el(se, 'PlannedQuay'));
    const trainNo = el(se, 'TrainNumber');
    if (!firstJourneyRef) {
      firstJourneyRef = el(se, 'JourneyRef');
      firstDayRef = el(se, 'OperatingDayRef');
    }
    // IC/IR mit kleiner Nummer = fast sicher SBB (ICE/TGV etc. haben oft keine Formation)
    const name = textOf(el(se, 'PublishedServiceName')) ?? '';
    if (trainNo && /^(IC|IR)/.test(name)) trainNumbers.unshift(trainNo);
    else if (trainNo) trainNumbers.push(trainNo);
    console.log(
      `   ${String(textOf(el(se, 'PublishedServiceName')) ?? '?').padEnd(6)} → ${textOf(el(se, 'DestinationText'))}  plan ${hhmm(plan)}  ist ${hhmm(est ?? plan)}  Gl. ${quay ?? '–'}  Nr. ${trainNo ?? '–'}`,
    );
  }
});

await section('3) Trip(Olten → Bern) …', async () => {
  if (!olten) throw new Error('übersprungen');
  const bernXml = await ojp(`<OJPLocationInformationRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <InitialInput><Name>Bern</Name></InitialInput>
        <Restrictions><Type>stop</Type><NumberOfResults>1</NumberOfResults></Restrictions>
      </OJPLocationInformationRequest>`);
  const bern = el(els(bernXml, 'PlaceResult')[0] ?? '', 'StopPlaceRef');
  const xml = await ojp(`<OJPTripRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <Origin>
          <PlaceRef><siri:StopPointRef>${olten}</siri:StopPointRef><Name><Text>Olten</Text></Name></PlaceRef>
          <DepArrTime>${now}</DepArrTime>
        </Origin>
        <Destination>
          <PlaceRef><siri:StopPointRef>${bern}</siri:StopPointRef><Name><Text>Bern</Text></Name></PlaceRef>
        </Destination>
        <Params>
          <NumberOfResults>2</NumberOfResults>
          <IncludeIntermediateStops>false</IncludeIntermediateStops>
          <UseRealtimeData>full</UseRealtimeData>
        </Params>
      </OJPTripRequest>`);
  for (const result of els(xml, 'TripResult').slice(0, 2)) {
    const trip = el(result, 'Trip');
    const legs = els(trip, 'TimedLeg')
      .map((l) => {
        const board = el(l, 'LegBoard');
        const alight = el(l, 'LegAlight');
        return `${textOf(el(l, 'PublishedServiceName'))} ${textOf(el(board, 'StopPointName'))} ${hhmm(el(board, 'TimetabledTime'))} → ${textOf(el(alight, 'StopPointName'))} ${hhmm(el(alight, 'TimetabledTime'))}`;
      })
      .join('  |  ');
    console.log(`   [${el(trip, 'Duration')}] ${legs}`);
  }
});

await section('4) TripInfo(erster Zug aus 2) …', async () => {
  if (!firstJourneyRef || !firstDayRef) throw new Error('kein JourneyRef aus Sektion 2');
  const xml = await ojp(`<OJPTripInfoRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <JourneyRef>${firstJourneyRef}</JourneyRef>
        <OperatingDayRef>${firstDayRef}</OperatingDayRef>
        <Params>
          <UseRealtimeData>full</UseRealtimeData>
          <IncludeCalls>true</IncludeCalls>
          <IncludeService>true</IncludeService>
        </Params>
      </OJPTripInfoRequest>`);
  const calls = [...els(xml, 'PreviousCall'), ...els(xml, 'OnwardCall')];
  console.log(`   ${calls.length} Halte:`);
  for (const c of calls.slice(0, 8)) {
    console.log(
      `     ${String(textOf(el(c, 'StopPointName')) ?? '?').padEnd(28)} an ${hhmm(el(el(c, 'ServiceArrival'), 'TimetabledTime'))}  ab ${hhmm(el(el(c, 'ServiceDeparture'), 'TimetabledTime'))}  Gl. ${textOf(el(c, 'EstimatedQuay') ?? el(c, 'PlannedQuay')) ?? '–'}`,
    );
  }
});

await section('5) Formation (Wagenreihung) …', async () => {
  if (trainNumbers.length === 0) throw new Error('keine Zugnummer aus Sektion 2');
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
  const fKey = process.env.OTD_FORMATION_KEY ?? KEY;
  for (const trainNo of trainNumbers.slice(0, 3)) {
    const res = await fetch(
      `https://api.opentransportdata.swiss/formation/v2/formations_full?evu=SBBP&operationDate=${today}&trainNumber=${trainNo}`,
      { headers: { Authorization: `Bearer ${fKey}` } },
    );
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} — ${(await res.text()).slice(0, 150)} ` +
          '(Formation ist ein SEPARATES API-Produkt im API-Manager → abonnieren bzw. OTD_FORMATION_KEY setzen.)',
      );
    }
    const f = await res.json();
    // Verifiziertes Schema: formationsAtScheduledStops[] + formations[].formationVehicles[]
    const stops = f.formationsAtScheduledStops ?? [];
    const vehicles = f.formations?.[0]?.formationVehicles ?? [];
    console.log(`   Zug ${trainNo}: ${vehicles.length} Wagen, ${stops.length} Halte`);
    if (vehicles.length === 0 && stops.length === 0) continue; // kein SBBP-Zug → nächsten probieren
    const s0 = stops[0]?.scheduledStop;
    if (s0) console.log(`   1. Halt: ${s0.stopPoint?.name}  Gleis ${s0.track ?? '–'}`);
    const dining = vehicles.find((v) => Number(v.vehicleProperties?.numberRestaurantSpace) > 0);
    const first = vehicles.find((v) => Number(v.vehicleProperties?.number1class) > 0);
    const sec = (v) => v?.formationVehicleAtScheduledStops?.[0]?.sectors ?? '–';
    if (dining) console.log(`   Speisewagen: Wagen ${dining.number}, Sektor ${sec(dining)}`);
    if (first) console.log(`   1. Klasse ab Wagen ${first.number}, Sektor ${sec(first)}`);
    return;
  }
  throw new Error('Keiner der Kandidaten-Züge hat SBBP-Formationsdaten (Antwort war leer).');
});

await section('6) Belegungsprognose (Dataset-Discovery) …', async () => {
  // Der 140-MB-Download läuft im täglichen Cron (/api/cron/occupancy), nicht
  // hier — der Smoke prüft nur, dass die ZIP-URL auffindbar ist.
  const page = await fetch(
    'https://data.opentransportdata.swiss/dataset/occupancy-forecast-json-dataset',
    { headers: { 'User-Agent': 'Mozilla/5.0 zuegli-smoke' } },
  );
  if (!page.ok) throw new Error(`Dataset-Seite HTTP ${page.status}`);
  const html = await page.text();
  const m = /href="(https:\/\/data\.opentransportdata\.swiss\/[^"]*\/download\/[^"]*\.zip)"/i.exec(html);
  if (!m) throw new Error('Keine ZIP-URL gefunden — Discovery in lib/sbb/occupancy.ts anpassen!');
  console.log(`   ZIP gefunden: ${m[1].split('/').pop()}`);
  console.log('   Import lokal testen: Server starten und GET /api/cron/occupancy aufrufen.');
});

await section('7) SIRI-SX (Störungen, Voll-Feed) …', async () => {
  // ACHTUNG: Das Abo erlaubt nur 48 Abfragen/Tag — jeder Smoke-Lauf kostet eine!
  console.log('   (verbraucht 1 von 48 Tages-Abfragen des Abos)');
  const { gunzipSync } = await import('node:zlib');
  const sxKey = process.env.OTD_SIRI_SX_KEY ?? KEY;
  const res = await fetch(
    process.env.OTD_SIRI_SX_URL ?? 'https://api.opentransportdata.swiss/la/siri-sx',
    { headers: { Authorization: `Bearer ${sxKey}` } },
  );
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} — ${(await res.text()).slice(0, 150)} ` +
        '(SIRI-SX ist ein SEPARATES API-Produkt im API-Manager → abonnieren bzw. OTD_SIRI_SX_KEY setzen.)',
    );
  }
  // Redirect auf signierte URL liefert eine gzip-DATEI (~106 MB XML).
  const bytes = Buffer.from(await res.arrayBuffer());
  const sx = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString('utf-8');
  const count = (sx.match(/<PtSituationElement>/g) ?? []).length;
  console.log(`   ${count} Situationen (${Math.round(bytes.length / 1024 / 1024)} MB gzip)`);
  const first = el(sx, 'PtSituationElement');
  if (first) {
    console.log(
      `   Erste: ${textOf(el(first, 'Summary'))} (Severity: ${el(first, 'Severity') ?? '–'})`,
    );
  }
});

console.log(failures === 0 ? '\n✅ Alle Sektionen OK.' : `\n⚠️ ${failures} Sektion(en) mit Problemen (Details oben).`);
