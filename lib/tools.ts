import { tool } from 'ai';
import { z } from 'zod';
import {
  searchStations,
  getDepartures,
  getArrivals,
  planJourney,
  trackTrain,
  nearbyStations,
  trainFormation,
  getOccupancy,
  getDisruptions,
  getFares,
} from './sbb/actions';

// AI-SDK-v7-Tools. WICHTIG: `inputSchema` (nicht mehr `parameters` wie in v4).
// Alle execute-Funktionen delegieren an die puren Actions in lib/sbb/actions.ts,
// die dieselbe Logik dem MCP-Server bereitstellen.
export const bahnTools = {
  searchStations: tool({
    description:
      'Sucht Schweizer Bahnhöfe und Haltestellen nach Name und liefert deren IDs. Rufe dies IMMER zuerst auf, um die stationId für die anderen Tools zu bekommen.',
    inputSchema: z.object({
      query: z.string().describe('Name des Bahnhofs/Orts, z.B. "Olten" oder "Zürich HB"'),
    }),
    execute: async ({ query }) => searchStations(query),
  }),

  getDepartures: tool({
    description:
      'Abfahrtstafel eines Bahnhofs (nächste Abfahrten) mit Verspätungen, Gleisen, Ausfällen. NUR verwenden, wenn KEIN Zielbahnhof genannt ist (z.B. „was fährt als Nächstes ab Luzern?"). Wenn Start UND Ziel genannt sind — auch bei „wann fährt der Zug von X nach Y" oder „von X nach Y ab 16 Uhr" — NICHT dieses Tool nehmen, sondern planJourney (nur planJourney weiss, ob ein Zug ein bestimmtes Ziel/einen Zwischenhalt erreicht; die „Richtung" hier ist nur der Endbahnhof).',
    inputSchema: z.object({
      stationId: z.string().describe('Die id aus searchStations'),
      towards: z
        .string()
        .optional()
        .describe('Optionaler Zielort-Filter, z.B. "Thun" — zeigt nur Züge in diese Richtung'),
      line: z
        .string()
        .optional()
        .describe(
          'Optionaler Linien-/Zugnummer-Filter, z.B. "IC 1" oder "728" — liefert deterministisch nur diesen Zug. Nutze das, um einen per Nummer genannten Zug zu finden (dann tripId für trackTrain nehmen).',
        ),
      when: z
        .string()
        .optional()
        .describe('Optionaler ISO-Zeitpunkt; ohne Angabe = jetzt'),
    }),
    execute: async ({ stationId, towards, line, when }) => getDepartures(stationId, { towards, line, when }),
  }),

  getArrivals: tool({
    description:
      'Liefert die Ankunftstafel eines Bahnhofs (nächste Ankünfte) mit Verspätungen und Herkunft.',
    inputSchema: z.object({
      stationId: z.string().describe('Die id aus searchStations'),
      from: z.string().optional().describe('Optionaler Herkunfts-Filter'),
      when: z.string().optional().describe('Optionaler ISO-Zeitpunkt; ohne Angabe = jetzt'),
    }),
    execute: async ({ stationId, from, when }) => getArrivals(stationId, { towards: from, when }),
  }),

  planJourney: tool({
    description:
      'Sucht Zugverbindungen von A nach B inkl. Umstiegen, Verspätungen, Gleisen und Ausstattung (amenities). DAS Standard-Tool für JEDE Anfrage mit Start UND Ziel — auch wenn sie wie eine Abfahrtsfrage klingt („wann fährt der Zug von X nach Y", „nächster Zug von X nach Y ab 16 Uhr"). Findet auch Direktverbindungen, bei denen das Ziel nur ein Zwischenhalt ist. Zeiten: dep/arr sind GEPLANTE Zeiten (wie auf der Anzeigetafel), depReal/arrReal die Echtzeit-Prognose, delayMin die Verspätung. Liefert je Verbindung eine fareRef für getFares (Preis). Benötigt die Bahnhofs-IDs aus searchStations; departure/arrival als ISO-Zeitpunkt für konkrete Zeiten.',
    inputSchema: z.object({
      fromId: z.string().describe('id des Start-Bahnhofs'),
      toId: z.string().describe('id des Ziel-Bahnhofs'),
      departure: z.string().optional().describe('Gewünschte Abfahrtszeit als ISO-Zeitpunkt'),
      arrival: z.string().optional().describe('Gewünschte Ankunftszeit als ISO-Zeitpunkt'),
    }),
    execute: async ({ fromId, toId, departure, arrival }) =>
      planJourney(fromId, toId, { departure, arrival }),
  }),

  nearbyStations: tool({
    description:
      'Findet Bahnhöfe und Haltestellen im Umkreis eines Ortes oder einer Adresse. Für Fragen wie „Welche Bahnhöfe sind in der Nähe von <Ort/Adresse>?".',
    inputSchema: z.object({
      place: z.string().describe('Ort oder Adresse, z.B. "Bundesplatz Bern" oder "Paradeplatz Zürich"'),
    }),
    execute: async ({ place }) => nearbyStations(place),
  }),

  trackTrain: tool({
    description:
      'Verfolgt einen konkreten Zug entlang seiner Route: alle Halte mit Ist-Zeiten, Verspätung pro Halt, Gleisen und Ausfällen. Nutzt die tripId aus getDepartures oder planJourney. Ideal für "Wo bleibt mein Zug?". Liefert auch die trainNumber für trainFormation/getOccupancy.',
    inputSchema: z.object({
      tripId: z.string().describe('Die tripId eines Zuges aus getDepartures oder planJourney'),
    }),
    execute: async ({ tripId }) => trackTrain(tripId),
  }),

  trainFormation: tool({
    description:
      'Wagenreihung (Zugformation) eines Zuges: Wagenreihenfolge, 1./2. Klasse, Speisewagen, Familienzone, Rollstuhlplätze, Velohaken — und der PERRONSEKTOR jedes Wagens am gewählten Halt. Für Fragen wie „Wo hält der Speisewagen?", „In welchem Sektor halten die 1.-Klass-Wagen?", „Wo ist das Veloabteil?". Braucht die Zugnummer (trainNumber aus getDepartures/planJourney/trackTrain). WICHTIG: stop = der Bahnhof, an dem der Nutzer einsteigt (Sektoren unterscheiden sich je Halt!).',
    inputSchema: z.object({
      trainNumber: z.string().describe('Zugnummer, z.B. "712" (aus trainNumber der anderen Tools)'),
      stop: z
        .string()
        .optional()
        .describe('Halt, für den die Sektoren gelten sollen, z.B. "Zürich HB" — ohne Angabe erster Halt des Laufs'),
      date: z.string().optional().describe('Betriebstag YYYY-MM-DD; ohne Angabe = heute'),
      evu: z
        .string()
        .optional()
        .describe('Bahnunternehmen, z.B. SBBP, BLSP, THURBO, SOB — ohne Angabe wird automatisch gesucht'),
    }),
    execute: async ({ trainNumber, date, evu, stop }) => trainFormation(trainNumber, date, evu, stop),
  }),

  getOccupancy: tool({
    description:
      'Belegungsprognose: wie voll wird ein Zug voraussichtlich, je Abschnitt und Klasse (1./2. Klasse). Für Fragen wie „Wie voll wird der Zug?", „Finde ich noch einen Sitzplatz?". Nur SBB, BLS, Thurbo und SOB. Braucht die Zugnummer (trainNumber aus getDepartures/planJourney/trackTrain).',
    inputSchema: z.object({
      trainNumber: z.string().describe('Zugnummer, z.B. "711"'),
      date: z.string().optional().describe('Betriebstag YYYY-MM-DD; ohne Angabe = heute'),
    }),
    execute: async ({ trainNumber, date }) => getOccupancy(trainNumber, date),
  }),

  getDisruptions: tool({
    description:
      'Aktuelle Störungen im Schweizer ÖV (ungeplante Ereignisse ca. alle 2 Minuten aktualisiert, geplante täglich): Unterbrüche, Ausfälle, Ersatzverkehr, Grund und Dauer. Für Fragen wie „Gibt es Störungen am Gotthard?", „Warum steht mein Zug?", „Fährt die Strecke X wieder?". Optional mit filter (Bahnhof, Strecke, Linie oder Stichwort) eingrenzen.',
    inputSchema: z.object({
      filter: z
        .string()
        .optional()
        .describe('Optionales Stichwort zum Filtern, z.B. "Gotthard", "Bern", "IC 1"'),
    }),
    execute: async ({ filter }) => getDisruptions(filter),
  }),

  getFares: tool({
    description:
      'Preisauskunft für eine konkrete Verbindung aus planJourney (CHF; Beta-Dienst, Angaben unverbindlich). Für „Was kostet …?" IMMER zuerst planJourney aufrufen und dann die fareRef der gewünschten Verbindung hier einsetzen. Unterstützt 1./2. Klasse und Halbtax.',
    inputSchema: z.object({
      fareRef: z.string().describe('Die fareRef einer Verbindung aus planJourney'),
      travelClass: z
        .enum(['first', 'second'])
        .optional()
        .describe('Klasse (Default: second = 2. Klasse)'),
      halbtax: z.boolean().optional().describe('true = Preis mit Halbtax-Abo'),
    }),
    execute: async ({ fareRef, travelClass, halbtax }) => getFares(fareRef, { travelClass, halbtax }),
  }),
};

export type BahnTools = typeof bahnTools;
