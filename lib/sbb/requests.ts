// XML-Builder für die OJP-2.0-Services. OJP-Requests sind kleine, fixe
// Templates — Template-Literals mit xmlEscape() sind hier wartbarer als ein
// Adapter-SDK. WICHTIG: Die Element-REIHENFOLGE ist XSD-erzwungen; nicht
// umsortieren (z.B. Location vor Params, NumberOfResults vor StopEventType).
//
// Jede Funktion liefert nur das innere <OJPXxxRequest>-Fragment; den Envelope
// baut client.ts.

import { xmlEscape } from './client';

const stamp = () => new Date().toISOString();

/** Bahnhofs-/Ortssuche nach Name. restrictToStops=false erlaubt auch Adressen/POIs. */
export function locationInformationRequest(
  query: string,
  opts: { restrictToStops?: boolean; results?: number } = {},
): string {
  const { restrictToStops = true, results = 6 } = opts;
  return `<OJPLocationInformationRequest>
        <siri:RequestTimestamp>${stamp()}</siri:RequestTimestamp>
        <siri:MessageIdentifier>LIR-${Date.now()}</siri:MessageIdentifier>
        <InitialInput>
          <Name>${xmlEscape(query)}</Name>
        </InitialInput>
        <Restrictions>
          ${restrictToStops ? '<Type>stop</Type>' : ''}
          <NumberOfResults>${results}</NumberOfResults>
        </Restrictions>
      </OJPLocationInformationRequest>`;
}

/** Haltestellen im Umkreis (GeoRestriction-Kreis, Radius in Metern). */
export function geoLocationRequest(
  lat: number,
  lon: number,
  radiusMeters: number,
  results: number,
): string {
  return `<OJPLocationInformationRequest>
        <siri:RequestTimestamp>${stamp()}</siri:RequestTimestamp>
        <siri:MessageIdentifier>LIR-GEO-${Date.now()}</siri:MessageIdentifier>
        <InitialInput>
          <GeoRestriction>
            <Circle>
              <Center>
                <siri:Longitude>${lon}</siri:Longitude>
                <siri:Latitude>${lat}</siri:Latitude>
              </Center>
              <Radius>${radiusMeters}</Radius>
            </Circle>
          </GeoRestriction>
        </InitialInput>
        <Restrictions>
          <Type>stop</Type>
          <NumberOfResults>${results}</NumberOfResults>
          <IncludePtModes>true</IncludePtModes>
        </Restrictions>
      </OJPLocationInformationRequest>`;
}

/** Abfahrts-/Ankunftstafel eines Halts (mit Echtzeit + Gleis/Quay). */
export function stopEventRequest(
  stopRef: string,
  opts: { type: 'departure' | 'arrival'; when?: Date; results?: number },
): string {
  const when = (opts.when ?? new Date()).toISOString();
  return `<OJPStopEventRequest>
        <siri:RequestTimestamp>${stamp()}</siri:RequestTimestamp>
        <siri:MessageIdentifier>SER-${Date.now()}</siri:MessageIdentifier>
        <Location>
          <PlaceRef>
            <siri:StopPointRef>${xmlEscape(stopRef)}</siri:StopPointRef>
            <Name><Text>-</Text></Name>
          </PlaceRef>
          <DepArrTime>${when}</DepArrTime>
        </Location>
        <Params>
          <NumberOfResults>${opts.results ?? 14}</NumberOfResults>
          <StopEventType>${opts.type}</StopEventType>
          <IncludePreviousCalls>false</IncludePreviousCalls>
          <IncludeOnwardCalls>false</IncludeOnwardCalls>
          <UseRealtimeData>full</UseRealtimeData>
        </Params>
      </OJPStopEventRequest>`;
}

/** Verbindungssuche A→B. departure ODER arrival (arrival = „Ankunft bis"). */
export function tripRequest(
  fromRef: string,
  toRef: string,
  opts: { departure?: Date; arrival?: Date; results?: number } = {},
): string {
  const depTime = opts.arrival ? null : (opts.departure ?? new Date());
  return `<OJPTripRequest>
        <siri:RequestTimestamp>${stamp()}</siri:RequestTimestamp>
        <siri:MessageIdentifier>TR-${Date.now()}</siri:MessageIdentifier>
        <Origin>
          <PlaceRef>
            <siri:StopPointRef>${xmlEscape(fromRef)}</siri:StopPointRef>
            <Name><Text>-</Text></Name>
          </PlaceRef>
          ${depTime ? `<DepArrTime>${depTime.toISOString()}</DepArrTime>` : ''}
        </Origin>
        <Destination>
          <PlaceRef>
            <siri:StopPointRef>${xmlEscape(toRef)}</siri:StopPointRef>
            <Name><Text>-</Text></Name>
          </PlaceRef>
          ${opts.arrival ? `<DepArrTime>${opts.arrival.toISOString()}</DepArrTime>` : ''}
        </Destination>
        <Params>
          <NumberOfResults>${opts.results ?? 3}</NumberOfResults>
          <IncludeIntermediateStops>false</IncludeIntermediateStops>
          <UseRealtimeData>full</UseRealtimeData>
        </Params>
      </OJPTripRequest>`;
}

/** Kompletter Zuglauf eines konkreten Kurses (JourneyRef + Betriebstag). */
export function tripInfoRequest(journeyRef: string, operatingDayRef: string): string {
  return `<OJPTripInfoRequest>
        <siri:RequestTimestamp>${stamp()}</siri:RequestTimestamp>
        <siri:MessageIdentifier>TIR-${Date.now()}</siri:MessageIdentifier>
        <JourneyRef>${xmlEscape(journeyRef)}</JourneyRef>
        <OperatingDayRef>${xmlEscape(operatingDayRef)}</OperatingDayRef>
        <Params>
          <UseRealtimeData>full</UseRealtimeData>
          <IncludeCalls>true</IncludeCalls>
          <IncludeService>true</IncludeService>
        </Params>
      </OJPTripInfoRequest>`;
}

// ── Preisabfrage (BETA, Integrationssystem) ─────────────────────────────────
// Läuft NICHT auf /ojp20, sondern auf https://api.opentransportdata.swiss/ojpfare/
// mit OJP-1.0-Envelope (invertierte Namespaces: Default = SIRI, ojp:-Prefix).
// Dokumentierter Ablauf: 1) Der Fare-Service berechnet den Trip SELBST (eigener
// OJPTripRequest im 1.0-Format), 2) der zurückgegebene <ojp:Trip> wird in einen
// OJPFareRequest eingebettet. So bleiben die Formate konsistent (2.0-Trips vom
// ojp20-Endpoint wären im 1.0-Schema ungültig).

/** Schritt 1: 1.0-TripRequest an den Fare-Endpoint (UIC-Nummern, z.B. 8505000). */
export function fareTripRequestEnvelope(fromUic: string, toUic: string, departure: Date): string {
  const now = stamp();
  return `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.siri.org.uk/siri" xmlns:ojp="http://www.vdv.de/ojp" version="1.0">
  <OJPRequest>
    <ServiceRequest>
      <RequestTimestamp>${now}</RequestTimestamp>
      <RequestorRef>zuegli</RequestorRef>
      <ojp:OJPTripRequest>
        <RequestTimestamp>${now}</RequestTimestamp>
        <ojp:Origin>
          <ojp:PlaceRef>
            <StopPointRef>${xmlEscape(fromUic)}</StopPointRef>
            <ojp:LocationName><ojp:Text>-</ojp:Text></ojp:LocationName>
          </ojp:PlaceRef>
          <ojp:DepArrTime>${departure.toISOString()}</ojp:DepArrTime>
        </ojp:Origin>
        <ojp:Destination>
          <ojp:PlaceRef>
            <StopPointRef>${xmlEscape(toUic)}</StopPointRef>
            <ojp:LocationName><ojp:Text>-</ojp:Text></ojp:LocationName>
          </ojp:PlaceRef>
        </ojp:Destination>
        <ojp:Params>
          <ojp:NumberOfResults>1</ojp:NumberOfResults>
          <ojp:IncludeIntermediateStops>false</ojp:IncludeIntermediateStops>
        </ojp:Params>
      </ojp:OJPTripRequest>
    </ServiceRequest>
  </OJPRequest>
</OJP>`;
}

export type FareOpts = { travelClass?: 'first' | 'second'; halbtax?: boolean };

/** Schritt 2: FareRequest mit dem (1.0-)Trip aus Schritt 1. */
export function fareRequestEnvelope(tripInnerXml: string, opts: FareOpts = {}): string {
  const now = stamp();
  const travelClass = opts.travelClass ?? 'second';
  const entitlement = opts.halbtax
    ? `
            <ojp:EntitlementProducts>
              <ojp:EntitlementProduct>
                <ojp:FareAuthorityRef>ch:1:NOVA</ojp:FareAuthorityRef>
                <ojp:EntitlementProductRef>HTA</ojp:EntitlementProductRef>
                <ojp:EntitlementProductName>Halbtax-Abonnement</ojp:EntitlementProductName>
              </ojp:EntitlementProduct>
            </ojp:EntitlementProducts>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.siri.org.uk/siri" xmlns:ojp="http://www.vdv.de/ojp" version="1.0">
  <OJPRequest>
    <ServiceRequest>
      <RequestTimestamp>${now}</RequestTimestamp>
      <RequestorRef>zuegli</RequestorRef>
      <ojp:OJPFareRequest>
        <RequestTimestamp>${now}</RequestTimestamp>
        <ojp:TripFareRequest>
          <ojp:Trip>${tripInnerXml}</ojp:Trip>
        </ojp:TripFareRequest>
        <ojp:Params>
          <ojp:FareAuthorityFilter>ch:1:NOVA</ojp:FareAuthorityFilter>
          <ojp:PassengerCategory>Adult</ojp:PassengerCategory>
          <ojp:TravelClass>${travelClass}</ojp:TravelClass>
          <ojp:Traveller>
            <ojp:Age>30</ojp:Age>
            <ojp:PassengerCategory>Adult</ojp:PassengerCategory>${entitlement}
          </ojp:Traveller>
        </ojp:Params>
      </ojp:OJPFareRequest>
    </ServiceRequest>
  </OJPRequest>
</OJP>`;
}
