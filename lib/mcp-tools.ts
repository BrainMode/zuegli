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

type McpServer = {
  registerTool: (
    name: string,
    config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ) => void;
};

const asText = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

// Registriert die 10 ÖV-Tools am MCP-Server. Nutzt dieselben puren Actions
// wie der Chat-Agent (lib/sbb/actions.ts) — keine Logik-Duplikation.
export function registerBahnMcpTools(server: McpServer) {
  server.registerTool(
    'searchStations',
    {
      title: 'Bahnhofssuche',
      description:
        'Sucht Schweizer Bahnhöfe/Haltestellen nach Name und liefert deren IDs. Immer zuerst aufrufen, um die stationId für die anderen Tools zu erhalten.',
      inputSchema: { query: z.string().describe('Name des Bahnhofs/Orts, z.B. "Olten"') },
    },
    async ({ query }) => asText(await searchStations(query as string)),
  );

  server.registerTool(
    'getDepartures',
    {
      title: 'Abfahrtstafel',
      description:
        'Abfahrten eines Bahnhofs mit Verspätung, Gleis und Ausfällen. Optional per towards nach Zielrichtung oder per line nach Zugnummer filtern.',
      inputSchema: {
        stationId: z.string().describe('id aus searchStations'),
        towards: z.string().optional().describe('Optionaler Zielort-Filter, z.B. "Thun"'),
        line: z.string().optional().describe('Optionaler Linien-/Zugnummer-Filter, z.B. "IC 1"'),
        when: z.string().optional().describe('Optionaler ISO-Zeitpunkt'),
      },
    },
    async ({ stationId, towards, line, when }) =>
      asText(
        await getDepartures(stationId as string, {
          towards: towards as string,
          line: line as string,
          when: when as string,
        }),
      ),
  );

  server.registerTool(
    'getArrivals',
    {
      title: 'Ankunftstafel',
      description: 'Ankünfte eines Bahnhofs mit Verspätung und Herkunft.',
      inputSchema: {
        stationId: z.string().describe('id aus searchStations'),
        from: z.string().optional().describe('Optionaler Herkunfts-Filter'),
        when: z.string().optional().describe('Optionaler ISO-Zeitpunkt'),
      },
    },
    async ({ stationId, from, when }) =>
      asText(await getArrivals(stationId as string, { towards: from as string, when: when as string })),
  );

  server.registerTool(
    'planJourney',
    {
      title: 'Verbindungssuche',
      description:
        'Zugverbindungen von A nach B inkl. Umstiegen, Verspätungen und Gleisen. Liefert je Verbindung eine fareRef für getFares. Benötigt die Bahnhofs-IDs aus searchStations.',
      inputSchema: {
        fromId: z.string().describe('id des Start-Bahnhofs'),
        toId: z.string().describe('id des Ziel-Bahnhofs'),
        departure: z.string().optional().describe('Abfahrtszeit als ISO-Zeitpunkt'),
        arrival: z.string().optional().describe('Ankunftszeit als ISO-Zeitpunkt'),
      },
    },
    async ({ fromId, toId, departure, arrival }) =>
      asText(
        await planJourney(fromId as string, toId as string, {
          departure: departure as string,
          arrival: arrival as string,
        }),
      ),
  );

  server.registerTool(
    'nearbyStations',
    {
      title: 'Umkreissuche',
      description: 'Findet Bahnhöfe/Haltestellen im Umkreis eines Ortes oder einer Adresse.',
      inputSchema: { place: z.string().describe('Ort oder Adresse, z.B. "Bundesplatz Bern"') },
    },
    async ({ place }) => asText(await nearbyStations(place as string)),
  );

  server.registerTool(
    'trackTrain',
    {
      title: 'Zugverfolgung',
      description:
        'Verfolgt einen konkreten Zug entlang seiner Route: alle Halte mit Ist-Zeiten, Verspätung pro Halt, Gleisen und Ausfällen. tripId stammt aus getDepartures oder planJourney.',
      inputSchema: { tripId: z.string().describe('tripId aus getDepartures oder planJourney') },
    },
    async ({ tripId }) => asText(await trackTrain(tripId as string)),
  );

  server.registerTool(
    'trainFormation',
    {
      title: 'Wagenreihung',
      description:
        'Wagenreihung (Zugformation): Wagenreihenfolge, Klassen, Speisewagen, Rollstuhlplätze, Velohaken und der Perronsektor je Wagen am gewählten Halt (Parameter stop).',
      inputSchema: {
        trainNumber: z.string().describe('Zugnummer, z.B. "712"'),
        stop: z.string().optional().describe('Halt für die Sektorangaben, z.B. "Zürich HB"'),
        date: z.string().optional().describe('Betriebstag YYYY-MM-DD; Default heute'),
        evu: z.string().optional().describe('Bahnunternehmen (SBBP, BLSP, THURBO, SOB …)'),
      },
    },
    async ({ trainNumber, date, evu, stop }) =>
      asText(await trainFormation(trainNumber as string, date as string, evu as string, stop as string)),
  );

  server.registerTool(
    'getOccupancy',
    {
      title: 'Belegungsprognose',
      description:
        'Wie voll wird ein Zug voraussichtlich — je Abschnitt und Klasse (nur SBB, BLS, Thurbo, SOB).',
      inputSchema: {
        trainNumber: z.string().describe('Zugnummer, z.B. "711"'),
        date: z.string().optional().describe('Betriebstag YYYY-MM-DD; Default heute'),
      },
    },
    async ({ trainNumber, date }) => asText(await getOccupancy(trainNumber as string, date as string)),
  );

  server.registerTool(
    'getDisruptions',
    {
      title: 'Störungslage',
      description:
        'Aktuelle Störungen im Schweizer ÖV (landesweiter Feed, ca. alle 30 Minuten aktualisiert), optional nach Stichwort/Bahnhof/Linie gefiltert.',
      inputSchema: {
        filter: z.string().optional().describe('Optionales Stichwort, z.B. "Gotthard"'),
      },
    },
    async ({ filter }) => asText(await getDisruptions(filter as string | undefined)),
  );

  server.registerTool(
    'getFares',
    {
      title: 'Preisauskunft',
      description:
        'Preis (CHF, Beta-Dienst, unverbindlich) für eine Verbindung aus planJourney — fareRef dort entnehmen. Optional 1. Klasse und Halbtax.',
      inputSchema: {
        fareRef: z.string().describe('fareRef aus planJourney'),
        travelClass: z.enum(['first', 'second']).optional().describe('Klasse (Default second)'),
        halbtax: z.boolean().optional().describe('true = mit Halbtax'),
      },
    },
    async ({ fareRef, travelClass, halbtax }) =>
      asText(
        await getFares(fareRef as string, {
          travelClass: travelClass as 'first' | 'second' | undefined,
          halbtax: halbtax as boolean | undefined,
        }),
      ),
  );
}
