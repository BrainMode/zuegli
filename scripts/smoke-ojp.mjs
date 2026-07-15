// Phase-0-Smoke-Test: verifiziert die opentransportdata.swiss-Dienste end-to-end
// und die Feldnamen, auf denen lib/sbb/format.ts aufbaut.
// Aufruf: npm run smoke   (lädt .env.local via node --env-file)
//
// Sektionen: 1 Bahnhofssuche, 2 Abfahrten, 3 Verbindung, 4 Zuglauf,
//            5 Wagenreihung, 6 Belegung, 7 Störungen (SIRI-SX).
// Braucht OTD_API_KEY (gratis: https://api-manager.opentransportdata.swiss/).

const KEY = process.env.OTD_API_KEY;
if (!KEY) {
  console.error(
    'OTD_API_KEY fehlt. Gratis-Key holen: https://api-manager.opentransportdata.swiss/\n' +
      'Dann in .env.local eintragen und erneut: npm run smoke',
  );
  process.exit(1);
}

const OJP = process.env.OTD_OJP_ENDPOINT ?? 'https://api.opentransportdata.swiss/ojp20';

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

// Mini-Helfer: erstes Vorkommen eines Elements (prefix-agnostisch) als Text.
function el(xml, name) {
  const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1].trim() : null;
}
function els(xml, name) {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}
const textOf = (frag) => (frag == null ? null : (el(frag, 'Text') ?? frag).replace(/<[^>]+>/g, '').trim());
const now = new Date().toISOString();
const hhmm = (iso) =>
  iso
    ? new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' })
    : '–';

console.log('1) LocationInformation("Olten") …');
const lirXml = await ojp(`<OJPLocationInformationRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <InitialInput><Name>Olten</Name></InitialInput>
        <Restrictions><Type>stop</Type><NumberOfResults>3</NumberOfResults></Restrictions>
      </OJPLocationInformationRequest>`);
for (const pr of els(lirXml, 'PlaceResult').slice(0, 3)) {
  console.log(`   ${el(pr, 'StopPlaceRef')}  ${textOf(el(pr, 'StopPlaceName'))}`);
}
const olten = el(els(lirXml, 'PlaceResult')[0] ?? '', 'StopPlaceRef');
if (!olten) throw new Error('Kein StopPlaceRef für Olten gefunden');

console.log('\n2) StopEvents(Olten, departures) …');
const serXml = await ojp(`<OJPStopEventRequest>
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
let firstJourneyRef = null;
let firstDayRef = null;
let firstTrainNumber = null;
for (const se of els(serXml, 'StopEvent').slice(0, 6)) {
  const line = textOf(el(se, 'PublishedServiceName'));
  const dest = textOf(el(se, 'DestinationText'));
  const dep = el(se, 'ServiceDeparture');
  const plan = el(dep ?? '', 'TimetabledTime');
  const est = el(dep ?? '', 'EstimatedTime');
  const quay = textOf(el(se, 'EstimatedQuay') ?? el(se, 'PlannedQuay'));
  const trainNo = el(se, 'TrainNumber');
  if (!firstJourneyRef) {
    firstJourneyRef = el(se, 'JourneyRef');
    firstDayRef = el(se, 'OperatingDayRef');
    firstTrainNumber = trainNo;
  }
  console.log(
    `   ${String(line ?? '?').padEnd(6)} → ${dest}  plan ${hhmm(plan)}  ist ${hhmm(est ?? plan)}  Gl. ${quay ?? '–'}  Nr. ${trainNo ?? '–'}`,
  );
}

console.log('\n3) Trip(Olten → Bern) …');
const bernXml = await ojp(`<OJPLocationInformationRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <InitialInput><Name>Bern</Name></InitialInput>
        <Restrictions><Type>stop</Type><NumberOfResults>1</NumberOfResults></Restrictions>
      </OJPLocationInformationRequest>`);
const bern = el(els(bernXml, 'PlaceResult')[0] ?? '', 'StopPlaceRef');
const trXml = await ojp(`<OJPTripRequest>
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
for (const trip of els(trXml, 'Trip').slice(0, 2)) {
  const legs = els(trip, 'TimedLeg')
    .map((l) => {
      const line = textOf(el(l, 'PublishedServiceName'));
      const board = el(l, 'LegBoard');
      const alight = el(l, 'LegAlight');
      return `${line} ${textOf(el(board ?? '', 'StopPointName'))} ${hhmm(el(board ?? '', 'TimetabledTime'))} → ${textOf(el(alight ?? '', 'StopPointName'))} ${hhmm(el(alight ?? '', 'TimetabledTime'))}`;
    })
    .join('  |  ');
  console.log(`   [${el(trip, 'Duration')}] ${legs}`);
}

console.log('\n4) TripInfo(erster Zug aus 2) …');
if (firstJourneyRef && firstDayRef) {
  const tiXml = await ojp(`<OJPTripInfoRequest>
        <siri:RequestTimestamp>${now}</siri:RequestTimestamp>
        <JourneyRef>${firstJourneyRef}</JourneyRef>
        <OperatingDayRef>${firstDayRef}</OperatingDayRef>
        <Params>
          <UseRealtimeData>full</UseRealtimeData>
          <IncludeCalls>true</IncludeCalls>
          <IncludeService>true</IncludeService>
        </Params>
      </OJPTripInfoRequest>`);
  const calls = [...els(tiXml, 'PreviousCall'), ...els(tiXml, 'OnwardCall')];
  console.log(`   ${calls.length} Halte:`);
  for (const c of calls.slice(0, 8)) {
    console.log(
      `     ${String(textOf(el(c, 'StopPointName')) ?? '?').padEnd(28)} an ${hhmm(el(el(c, 'ServiceArrival') ?? '', 'TimetabledTime'))}  ab ${hhmm(el(el(c, 'ServiceDeparture') ?? '', 'TimetabledTime'))}  Gl. ${textOf(el(c, 'EstimatedQuay') ?? el(c, 'PlannedQuay')) ?? '–'}`,
    );
  }
} else {
  console.log('   Kein JourneyRef aus Sektion 2 — übersprungen.');
}

console.log('\n5) Formation (Wagenreihung) …');
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
const fKey = process.env.OTD_FORMATION_KEY ?? KEY;
if (firstTrainNumber) {
  const fRes = await fetch(
    `https://api.opentransportdata.swiss/formation/v2/formations_full?evu=SBBP&operationDate=${today}&trainNumber=${firstTrainNumber}`,
    { headers: { Authorization: `Bearer ${fKey}` } },
  );
  if (fRes.ok) {
    const f = await fRes.json();
    const stops = f.scheduledStops ?? [];
    const vehicles = f.formationVehicles ?? f.vehicles ?? [];
    console.log(`   Zug ${firstTrainNumber}: ${vehicles.length} Wagen, ${stops.length} Halte`);
    if (stops[0]) console.log(`   1. Halt: ${stops[0].stopPoint?.name}  Gleis ${stops[0].track?.text ?? '–'}  Sektoren: ${stops[0].formationShortString ?? '–'}`);
    if (vehicles[0]) console.log(`   1. Wagen (Felder): ${Object.keys(vehicles[0].vehicleProperties ?? vehicles[0]).join(', ')}`);
  } else {
    console.log(`   HTTP ${fRes.status} — ${(await fRes.text()).slice(0, 200)}`);
    console.log('   (Formation evtl. separates API-Produkt → OTD_FORMATION_KEY setzen, oder Zug ist kein SBBP-Zug.)');
  }
} else {
  console.log('   Keine Zugnummer aus Sektion 2 — übersprungen.');
}

console.log('\n6) Belegungsprognose (CKAN) …');
const pkg = await (
  await fetch('https://data.opentransportdata.swiss/api/3/action/package_show?id=occupancy-forecast-json-dataset')
).json();
const resources = pkg?.result?.resources ?? [];
console.log(`   ${resources.length} Ressourcen; Beispiele: ${resources.slice(0, 3).map((r) => r.name).join(', ')}`);
const sbbToday = resources.find((r) => /(^|[^0-9])11[_-]/.test(String(r.name)) && String(r.name).includes(today));
if (sbbToday) {
  const occ = await (await fetch(sbbToday.url)).json();
  console.log(`   SBB heute: ${occ.trains?.length ?? 0} Züge; Felder train[0]: ${Object.keys(occ.trains?.[0] ?? {}).join(', ')}`);
} else {
  console.log(`   Keine SBB-Datei (11_${today}) gefunden — Namensmuster prüfen!`);
}

console.log('\n7) SIRI-SX (Störungen, unplanned) …');
const sxKey = process.env.OTD_SIRI_SX_KEY ?? KEY;
const sxRes = await fetch(
  process.env.OTD_SIRI_SX_URL ?? 'https://api.opentransportdata.swiss/la/siri-sx-unplanned',
  { headers: { Authorization: `Bearer ${sxKey}` } },
);
if (sxRes.ok) {
  const sx = await sxRes.text();
  const situations = els(sx, 'PtSituationElement');
  console.log(`   ${situations.length} Situationen`);
  if (situations[0]) {
    console.log(`   Erste: ${textOf(el(situations[0], 'Summary'))} (Severity: ${el(situations[0], 'Severity') ?? '–'})`);
  }
} else {
  console.log(`   HTTP ${sxRes.status} — ${(await sxRes.text()).slice(0, 200)}`);
  console.log('   (SIRI-SX evtl. separates API-Produkt → OTD_SIRI_SX_KEY setzen.)');
}

console.log('\n✅ Smoke-Test durchgelaufen.');
