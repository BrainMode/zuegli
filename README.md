# Zügli 🚂

**Deine KI-Bahnauskunft für die Schweiz — inoffiziell, Open Source, in 100+ Sprachen.**

Eine KI-Bahnauskunft, mit der man in normaler Sprache nach Zügen, Verspätungen, Verbindungen und Bahnhöfen fragt — und nach Dingen, die es sonst in keinem Bahn-Chatbot gibt: **In welchem Perronsektor hält der Speisewagen? Wie voll wird mein Zug? Gibt es Störungen am Gotthard? Was kostet Basel–Lugano?**

Zügli ist die Schweizer Schwester-App von [Wo bleibt mein Zug?](https://github.com/BrainMode/wo-bleibt-mein-zug) (Deutschland). Der grosse Unterschied: Die Schweiz stellt ihre ÖV-Daten über die offene Plattform [opentransportdata.swiss](https://opentransportdata.swiss) offiziell und dokumentiert bereit — inklusive Daten, die es bei der DB öffentlich schlicht nicht gibt.

## Was Zügli kann

- **Abfahrten & Ankünfte** mit Echtzeit, Gleis und Gleiswechsel
- **Verbindungen A→B** mit Umstiegen, Verspätungen und Gleisen
- **„Wo bleibt mein Zug?"** — Live-Zuglauf mit Verspätung pro Halt
- **Wagenreihung mit Perronsektor** 🇨🇭 — wo hält welcher Wagen (1./2. Klasse, Speisewagen, Velohaken, Rollstuhlplätze), pro Halt mit Sektorangabe
- **Belegungsprognose** 🇨🇭 — wie voll wird der Zug, je Abschnitt und Klasse (SBB, BLS, Thurbo, SOB). Ein täglicher Cron (`/api/cron/occupancy`, siehe `vercel.json`) importiert das ~140-MB-Tages-ZIP und legt kompakte Blobs (~1 MB) in Redis — braucht deshalb Upstash.
- **Störungen** 🇨🇭 — landesweiter Echtzeit-Störungsfeed (SIRI-SX), gefiltert nach Strecke/Bahnhof
- **Preisauskunft** (Beta) — Normalpreis in CHF für eine Verbindung
- **100+ Sprachen** — fragt auf Deutsch, Französisch, Italienisch, Englisch, … und bekommt die Antwort in derselben Sprache
- **MCP-Server** — alle 10 Tools auch für Claude, IDEs & Co. unter `/api/mcp`

## Datenquellen

- **[opentransportdata.swiss](https://opentransportdata.swiss)** (Open Data Plattform Mobilität Schweiz, SKI/BAV):
  - OJP 2.0 (Fahrplan, Echtzeit, Zuglauf) · Train Formation v2 (Wagenreihung) · SIRI-SX (Störungen) · Belegungsprognose (CKAN)
  - Kostenloser API-Key, 50 Requests/Minute, 20'000/Tag — dank Caching mehr als genug
- **[Mistral](https://mistral.ai)** (EU-Modell + Moderation) für Chat und Guardrails

Anders als bei bahn.de gibt es hier kein Anti-Bot-Katz-und-Maus: alles offizielle, dokumentierte APIs.

## Selbst laufen lassen

```bash
git clone https://github.com/BrainMode/zuegli.git
cd zuegli
npm install
cp .env.example .env.local   # Keys eintragen (siehe unten)
npm run dev
```

1. **`MISTRAL_API_KEY`** (Pflicht): [console.mistral.ai](https://console.mistral.ai/api-keys) — Mistral Small, EU-Datenhaltung, kostet Rappen.
2. **`OTD_API_KEY`** (für alle Bahn-Tools): kostenlos im [API-Manager von opentransportdata.swiss](https://api-manager.opentransportdata.swiss/) registrieren und das Produkt **OJP 2.0** abonnieren. Wagenreihung (**Train Formation v2**) und Störungen (**SIRI-SX**) sind eigene API-Produkte — je nach Abo eigene Keys in `OTD_FORMATION_KEY`/`OTD_SIRI_SX_KEY` (Fallback ist `OTD_API_KEY`).
3. Optional Upstash Redis (Rate-Limiting + geteilter Cache) und Betreiber-Angaben (`OWNER_*`) — siehe `.env.example`.

Ohne Keys startet die App trotzdem: Die Tools melden dann ehrlich „nicht konfiguriert".

**Smoke-Test** (verifiziert alle Dienste end-to-end gegen die echte API):

```bash
npm run smoke
```

## MCP-Server

Alle 10 Tools stehen als MCP-Server bereit (Streamable HTTP):

```json
{
  "mcpServers": {
    "zuegli": {
      "url": "https://zuegli.ch/api/mcp"
    }
  }
}
```

Lokal testen: `npx @modelcontextprotocol/inspector http://localhost:3000/api/mcp`

## Technik

Next.js (App Router), Vercel AI SDK mit `@ai-sdk/mistral`, `fast-xml-parser` für OJP 2.0 (XML), `mcp-handler`, Tailwind, optional Upstash Redis. Guardrails über die Mistral Moderation API plus einen strikten System-Prompt; die Ausgabe wird zusätzlich geprüft. `npm run test:guardrails` fährt gegen einen laufenden Server ein paar Angriffs- und Normalfälle.

Architektur: Die reinen Datenfunktionen in `lib/sbb/actions.ts` werden doppelt verpackt — als AI-SDK-Tools (`lib/tools.ts`) für den Chat und als MCP-Tools (`lib/mcp-tools.ts`) für den Server. Keine Logik-Duplikation.

## Lizenz & Attribution

- Code: MIT (siehe LICENSE)
- Fahrplan- und Echtzeitdaten: **Datenquelle [opentransportdata.swiss](https://opentransportdata.swiss)** — die Nutzungsbedingungen verlangen diese Attribution; bei kommerzieller Nutzung greift zudem eine Reziprozitätsklausel (angereicherte Daten müssen zurückgeteilt werden). [Nutzungsbedingungen](https://opentransportdata.swiss/de/nutzungsbedingungen/)

## Disclaimer

Dies ist kein offizielles Angebot der Schweizerischen Bundesbahnen SBB CFF FFS, es besteht keine Verbindung und es wird keine Marke der SBB verwendet (kein SBB-Rot, kein Logo, kein Schweizer Kreuz). Angaben ohne Gewähr — nicht für sicherheitskritische Entscheidungen nutzen. Prognosen (Belegung) sind Prognosen.
