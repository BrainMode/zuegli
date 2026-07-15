// Fare-Smoke: findet die Parameter-Kombination, mit der der OJP-Fare-Beta-
// Endpoint (Integrationssystem, OJP 1.0) einen Trip liefert — und bepreist ihn.
// Aufruf: node --env-file=.env.local scripts/smoke-fare.mjs
// Verifizierter Fehlschlag vorab: UIC 8505000→8507000 bei +10 h → TRIP_NOTRIPFOUND.

const KEY = process.env.OTD_FARE_KEY ?? process.env.OTD_API_KEY;
const URL = process.env.OTD_FARE_ENDPOINT ?? 'https://api.opentransportdata.swiss/ojpfare/';
if (!KEY) {
  console.error('OTD_FARE_KEY fehlt.');
  process.exit(1);
}

const stamp = () => new Date().toISOString();

function zurichLocal(d) {
  return d.toLocaleString('sv-SE', { timeZone: 'Europe/Zurich' }).replace(' ', 'T');
}

function tripRequest({ from, to, depStr, withName }) {
  const now = stamp();
  const name = withName ? '<ojp:LocationName><ojp:Text>-</ojp:Text></ojp:LocationName>' : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.siri.org.uk/siri" xmlns:ojp="http://www.vdv.de/ojp" version="1.0">
  <OJPRequest>
    <ServiceRequest>
      <RequestTimestamp>${now}</RequestTimestamp>
      <RequestorRef>zuegli-smoke</RequestorRef>
      <ojp:OJPTripRequest>
        <RequestTimestamp>${now}</RequestTimestamp>
        <ojp:Origin>
          <ojp:PlaceRef>
            <StopPointRef>${from}</StopPointRef>
            ${name}
          </ojp:PlaceRef>
          <ojp:DepArrTime>${depStr}</ojp:DepArrTime>
        </ojp:Origin>
        <ojp:Destination>
          <ojp:PlaceRef>
            <StopPointRef>${to}</StopPointRef>
            ${name}
          </ojp:PlaceRef>
        </ojp:Destination>
        <ojp:Params>
          <ojp:NumberOfResults>1</ojp:NumberOfResults>
        </ojp:Params>
      </ojp:OJPTripRequest>
    </ServiceRequest>
  </OJPRequest>
</OJP>`;
}

async function post(body) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml', Authorization: `Bearer ${KEY}` },
    body,
  });
  return { status: res.status, text: await res.text() };
}

const dep = new Date(Date.now() + 30 * 60_000); // +30 min
const refs = [
  { label: 'UIC', from: '8505000', to: '8507000' },            // Luzern → Bern
  { label: 'sloid', from: 'ch:1:sloid:5000', to: 'ch:1:sloid:7000' },
];
const times = [
  { label: 'ISO-Z', value: dep.toISOString() },
  { label: 'Zurich-lokal', value: zurichLocal(dep) },
  { label: '+02:00', value: `${zurichLocal(dep)}+02:00` },
];

let winner = null;
console.log(`Matrix gegen ${URL} (Abfahrt +30 min):`);
outer: for (const r of refs) {
  for (const t of times) {
    for (const withName of [true, false]) {
      const label = `${r.label} × ${t.label} × ${withName ? 'mit' : 'ohne'} LocationName`;
      const { status, text } = await post(tripRequest({ from: r.from, to: r.to, depStr: t.value, withName }));
      const err = /<(?:\w+:)?ErrorText>([^<]+)</.exec(text)?.[1];
      const hasTrip = /<(\w+:)?Trip>/.test(text);
      console.log(`  ${label.padEnd(46)} HTTP ${status}  ${hasTrip ? '✅ TRIP!' : (err ?? text.slice(0, 60))}`);
      if (hasTrip) {
        winner = { ...r, time: t, withName, text };
        break outer;
      }
    }
  }
}

if (!winner) {
  console.log('\n❌ Keine Kombination lieferte einen Trip. Rohantwort der letzten Anfrage prüfen.');
  process.exit(1);
}

console.log(`\n→ Gewinner: ${winner.label}-Refs, Zeitformat ${winner.time.label}, ${winner.withName ? 'mit' : 'ohne'} LocationName`);

// FareRequest mit dem gewonnenen Trip
const tripInner = /<(\w+:)?Trip>([\s\S]*?)<\/\1?Trip>/.exec(winner.text)?.[2];
const now = stamp();
const fareBody = `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.siri.org.uk/siri" xmlns:ojp="http://www.vdv.de/ojp" version="1.0">
  <OJPRequest>
    <ServiceRequest>
      <RequestTimestamp>${now}</RequestTimestamp>
      <RequestorRef>zuegli-smoke</RequestorRef>
      <ojp:OJPFareRequest>
        <RequestTimestamp>${now}</RequestTimestamp>
        <ojp:TripFareRequest>
          <ojp:Trip>${tripInner}</ojp:Trip>
        </ojp:TripFareRequest>
        <ojp:Params>
          <ojp:FareAuthorityFilter>ch:1:NOVA</ojp:FareAuthorityFilter>
          <ojp:PassengerCategory>Adult</ojp:PassengerCategory>
          <ojp:TravelClass>second</ojp:TravelClass>
          <ojp:Traveller>
            <ojp:Age>30</ojp:Age>
            <ojp:PassengerCategory>Adult</ojp:PassengerCategory>
          </ojp:Traveller>
        </ojp:Params>
      </ojp:OJPFareRequest>
    </ServiceRequest>
  </OJPRequest>
</OJP>`;
const fare = await post(fareBody);
console.log(`\nFareRequest: HTTP ${fare.status}`);
const prices = [...fare.text.matchAll(/<(?:\w+:)?Price>([^<]+)<\/(?:\w+:)?Price>/g)].map((m) => m[1]);
const products = [...fare.text.matchAll(/<(?:\w+:)?FareProductName>([^<]+)</g)].map((m) => m[1]);
const errF = /<(?:\w+:)?ErrorText>([^<]+)</.exec(fare.text)?.[1];
if (prices.length) {
  console.log(`✅ Preise: ${prices.join(', ')} CHF (Produkte: ${products.slice(0, 4).join(' | ')})`);
} else {
  console.log(`❌ Kein Preis. ${errF ?? ''}\n${fare.text.slice(0, 600)}`);
}
