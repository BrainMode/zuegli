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

/**
 * Preisabfrage (BETA!) — läuft NICHT auf /ojp20, sondern auf einem separaten
 * Fare-Endpoint mit OJP-1.0-Envelope (invertierte Namespaces: Default = SIRI).
 * tripInnerXml ist der INHALT eines <Trip>…</Trip> aus einer TripDelivery;
 * die Namespaces werden am Wrapper neu deklariert, damit das 2.0-Fragment im
 * 1.0-Envelope gültig bleibt.
 */
export function fareRequestEnvelope(tripInnerXml: string): string {
  const now = stamp();
  return `<?xml version="1.0" encoding="UTF-8"?>
<OJP xmlns="http://www.siri.org.uk/siri" xmlns:ojp="http://www.vdv.de/ojp" version="1.0">
  <OJPRequest>
    <ServiceRequest>
      <RequestTimestamp>${now}</RequestTimestamp>
      <RequestorRef>zuegli</RequestorRef>
      <ojp:OJPFareRequest>
        <RequestTimestamp>${now}</RequestTimestamp>
        <ojp:TripFareRequest>
          <ojp:Trip xmlns="http://www.vdv.de/ojp" xmlns:siri="http://www.siri.org.uk/siri">${tripInnerXml}</ojp:Trip>
        </ojp:TripFareRequest>
        <ojp:Params>
          <ojp:FareAuthorityFilter>ch:1:NOVA</ojp:FareAuthorityFilter>
          <ojp:PassengerCategory>Adult</ojp:PassengerCategory>
          <ojp:TravelClass>second</ojp:TravelClass>
        </ojp:Params>
      </ojp:OJPFareRequest>
    </ServiceRequest>
  </OJPRequest>
</OJP>`;
}
