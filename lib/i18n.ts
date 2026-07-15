// UI-Übersetzungen. Die Chat-Antworten selbst sind über das Modell in 100+
// Sprachen möglich (siehe System-Prompt); dieses Dictionary lokalisiert nur die
// statischen Oberflächen-Texte. Die Schweiz ist mehrsprachig — de/fr/it stehen
// deshalb an erster Stelle. Unbekannte Browsersprachen fallen auf Englisch zurück.

export type Lang = 'de' | 'fr' | 'it' | 'en' | 'es' | 'tr';

export const LANGS: { code: Lang; label: string }[] = [
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'tr', label: 'Türkçe' },
];

type Strings = {
  tagline: string;
  disclaimer: string;
  langBadge: string;
  emptyHint: string;
  examplesLabel: string;
  examples: string[];
  placeholder: string;
  send: string;
  thinking: string;
  error: string;
  footerNote: string;
  oss: string;
  by: string;
  imprint: string;
  privacy: string;
  tools: Record<string, [running: string, done: string]>;
};

const TOOLS_DE: Strings['tools'] = {
  searchStations: ['Suche Bahnhof …', 'Bahnhof gefunden'],
  getDepartures: ['Lade Abfahrtstafel …', 'Abfahrten geladen'],
  getArrivals: ['Lade Ankunftstafel …', 'Ankünfte geladen'],
  planJourney: ['Suche Verbindungen …', 'Verbindungen gefunden'],
  trackTrain: ['Verfolge Zug …', 'Zug verfolgt'],
  nearbyStations: ['Suche in der Nähe …', 'Haltestellen gefunden'],
  trainFormation: ['Lade Wagenreihung …', 'Wagenreihung geladen'],
  getOccupancy: ['Prüfe Belegung …', 'Belegung geladen'],
  getDisruptions: ['Prüfe Störungen …', 'Störungslage geladen'],
  getFares: ['Frage Preis ab …', 'Preis geladen'],
};

export const STRINGS: Record<Lang, Strings> = {
  de: {
    tagline: 'Deine KI-Bahnauskunft für die Schweiz',
    disclaimer: 'Inoffiziell · keine Verbindung zu SBB CFF FFS',
    langBadge: '100+ Sprachen',
    emptyHint:
      'Frag mich in normaler Sprache nach Abfahrten, Verspätungen, Gleisen, Verbindungen, der Wagenreihung oder wie voll dein Zug wird.',
    examplesLabel: 'Probier eine Frage',
    examples: [
      'Mein Zug nach Bern hat Verspätung, ich stehe in Olten — wo bleibt er?',
      'Nächste Verbindung von Zürich HB nach Genève',
      'Wo hält der Speisewagen im IC 1 nach St. Gallen — welcher Sektor?',
      'Wie voll wird der Zug von Lausanne nach Genève um 17 Uhr?',
      'Gibt es Störungen am Gotthard?',
      'Was kostet die Verbindung von Basel nach Lugano?',
      'Welche Züge fahren in der nächsten Stunde ab Luzern?',
      'Ist mein IC von Zürich nach Bern pünktlich?',
      'Verbindung von Winterthur nach Interlaken morgen um 9 Uhr',
      'In welchem Sektor halten die Wagen der 1. Klasse im IC 8 ab Zürich HB?',
      'Kann ich mein Velo im IR nach Chur mitnehmen?',
      'Auf welchem Gleis fährt der nächste Zug nach Bern ab Olten?',
      'Wann kommt der IC aus Genève in Zürich an?',
      'Ich bin in Baden und will nach Zug — wann muss ich los?',
      'Schaffe ich meinen Anschluss in Olten, wenn mein Zug 10 Minuten Verspätung hat?',
      'Nächste Abfahrten ab Bern Richtung Thun',
      'Hat es im Zug nach Brig noch Platz — 2. Klasse?',
      'Fährt der letzte Zug von Zürich nach Winterthur heute noch?',
      'Welche Bahnhöfe sind in der Nähe vom Bundesplatz in Bern?',
      'Beste Verbindung von St. Gallen nach Lausanne mit wenig Umstiegen',
    ],
    placeholder: 'z. B. Wann fährt der nächste Zug von Olten nach Bern?',
    send: 'Suchen',
    thinking: 'Einen Moment',
    error: 'Es ist ein Fehler aufgetreten. Bitte versuch es gleich noch einmal.',
    footerNote: 'Angaben ohne Gewähr · Datenquelle: opentransportdata.swiss',
    oss: 'Open Source',
    by: 'ein Projekt von',
    imprint: 'Impressum',
    privacy: 'Datenschutz',
    tools: TOOLS_DE,
  },
  fr: {
    tagline: 'Ton assistant ferroviaire IA pour la Suisse',
    disclaimer: 'Non officiel · sans lien avec les CFF (SBB CFF FFS)',
    langBadge: '100+ langues',
    emptyHint:
      'Pose tes questions en langage naturel : départs, retards, voies, correspondances, composition des trains ou taux d’occupation.',
    examplesLabel: 'Essaie une question',
    examples: [
      'Prochain train de Genève à Lausanne',
      'Mon train pour Berne a du retard, je suis à Fribourg — où est-il ?',
      'Où s’arrête la voiture-restaurant de l’IC 1 — quel secteur ?',
      'Le train de Lausanne à Genève de 17 h sera-t-il bondé ?',
      'Y a-t-il des perturbations au Gothard ?',
      'Combien coûte le trajet de Bâle à Lugano ?',
      'Quels trains partent de Lausanne dans la prochaine heure ?',
      'Correspondance de Neuchâtel à Zermatt demain à 9 h',
      'Dans quel secteur s’arrêtent les voitures de 1re classe à Genève ?',
      'Puis-je emmener mon vélo dans l’IR pour Coire ?',
      'Sur quelle voie part le prochain train pour Berne à Olten ?',
      'Prochains départs de Genève en direction de Sion',
      'Est-ce que j’aurai ma correspondance à Olten si mon train a 10 minutes de retard ?',
    ],
    placeholder: 'ex. À quelle heure part le prochain train de Genève à Lausanne ?',
    send: 'Rechercher',
    thinking: 'Un instant',
    error: 'Une erreur est survenue. Réessaie dans un instant.',
    footerNote: 'Sans garantie · source : opentransportdata.swiss',
    oss: 'Open source',
    by: 'un projet de',
    imprint: 'Mentions légales',
    privacy: 'Confidentialité',
    tools: {
      searchStations: ['Recherche de la gare …', 'Gare trouvée'],
      getDepartures: ['Chargement des départs …', 'Départs chargés'],
      getArrivals: ['Chargement des arrivées …', 'Arrivées chargées'],
      planJourney: ['Recherche des correspondances …', 'Correspondances trouvées'],
      trackTrain: ['Suivi du train …', 'Train suivi'],
      nearbyStations: ['Recherche à proximité …', 'Arrêts trouvés'],
      trainFormation: ['Chargement de la composition …', 'Composition chargée'],
      getOccupancy: ['Vérification de l’occupation …', 'Occupation chargée'],
      getDisruptions: ['Vérification des perturbations …', 'Perturbations chargées'],
      getFares: ['Recherche du prix …', 'Prix chargé'],
    },
  },
  it: {
    tagline: 'Il tuo assistente ferroviario IA per la Svizzera',
    disclaimer: 'Non ufficiale · nessun legame con le FFS (SBB CFF FFS)',
    langBadge: '100+ lingue',
    emptyHint:
      'Chiedimi in linguaggio naturale di partenze, ritardi, binari, coincidenze, composizione dei treni o quanto sarà pieno il tuo treno.',
    examplesLabel: 'Prova una domanda',
    examples: [
      'Il mio treno per Lugano è in ritardo — dov’è adesso?',
      'Prossima coincidenza da Bellinzona a Zurigo',
      'Dove si ferma la carrozza ristorante dell’IC 2 — quale settore?',
      'Quanto sarà pieno il treno da Lugano a Bellinzona alle 17?',
      'Ci sono perturbazioni sulla linea del San Gottardo?',
      'Quanto costa il viaggio da Basilea a Lugano?',
      'Quali treni partono da Lugano nella prossima ora?',
      'Coincidenza da Locarno a Ginevra domani alle 9',
      'In quale settore si fermano le carrozze di 1ª classe a Lugano?',
      'Posso portare la bici sull’IR per Coira?',
      'Da quale binario parte il prossimo treno per Zurigo a Bellinzona?',
      'Prossime partenze da Lugano in direzione Chiasso',
      'Riesco a prendere la coincidenza a Olten se il mio treno ha 10 minuti di ritardo?',
    ],
    placeholder: 'es. Quando parte il prossimo treno da Bellinzona a Zurigo?',
    send: 'Cerca',
    thinking: 'Un momento',
    error: 'Si è verificato un errore. Riprova tra poco.',
    footerNote: 'Senza garanzia · fonte: opentransportdata.swiss',
    oss: 'Open Source',
    by: 'un progetto di',
    imprint: 'Note legali',
    privacy: 'Privacy',
    tools: {
      searchStations: ['Ricerca stazione …', 'Stazione trovata'],
      getDepartures: ['Carico partenze …', 'Partenze caricate'],
      getArrivals: ['Carico arrivi …', 'Arrivi caricati'],
      planJourney: ['Ricerca coincidenze …', 'Coincidenze trovate'],
      trackTrain: ['Traccio il treno …', 'Treno tracciato'],
      nearbyStations: ['Ricerca nelle vicinanze …', 'Fermate trovate'],
      trainFormation: ['Carico la composizione …', 'Composizione caricata'],
      getOccupancy: ['Verifico l’occupazione …', 'Occupazione caricata'],
      getDisruptions: ['Verifico le perturbazioni …', 'Perturbazioni caricate'],
      getFares: ['Cerco il prezzo …', 'Prezzo caricato'],
    },
  },
  en: {
    tagline: 'Your AI train assistant for Switzerland',
    disclaimer: 'Unofficial · not affiliated with SBB CFF FFS',
    langBadge: '100+ languages',
    emptyHint:
      'Ask me in plain language about departures, delays, platforms, connections, train composition or how full your train will be.',
    examplesLabel: 'Try a question',
    examples: [
      'My train to Bern is delayed, I’m in Olten — where is it?',
      'Next connection from Zürich HB to Geneva',
      'Where does the dining car stop on the IC 1 — which sector?',
      'How full will the 5 pm train from Lausanne to Geneva be?',
      'Are there any disruptions on the Gotthard line?',
      'How much is the trip from Basel to Lugano?',
      'Which trains leave Lucerne in the next hour?',
      'Is my IC from Zurich to Bern on time?',
      'Connection from Winterthur to Interlaken tomorrow at 9 am',
      'Which sector do the first-class coaches stop in at Zürich HB?',
      'Can I take my bike on the IR to Chur?',
      'Which platform does the next train to Bern leave from in Olten?',
      'Will I make my connection in Olten if my train is 10 minutes late?',
    ],
    placeholder: 'e.g. When does the next train from Olten to Bern leave?',
    send: 'Search',
    thinking: 'One moment',
    error: 'Something went wrong. Please try again in a moment.',
    footerNote: 'No guarantee · data source: opentransportdata.swiss',
    oss: 'Open Source',
    by: 'a project by',
    imprint: 'Imprint',
    privacy: 'Privacy',
    tools: {
      searchStations: ['Finding station …', 'Station found'],
      getDepartures: ['Loading departures …', 'Departures loaded'],
      getArrivals: ['Loading arrivals …', 'Arrivals loaded'],
      planJourney: ['Finding connections …', 'Connections found'],
      trackTrain: ['Tracking train …', 'Train tracked'],
      nearbyStations: ['Searching nearby …', 'Stops found'],
      trainFormation: ['Loading train composition …', 'Composition loaded'],
      getOccupancy: ['Checking occupancy …', 'Occupancy loaded'],
      getDisruptions: ['Checking disruptions …', 'Disruptions loaded'],
      getFares: ['Fetching fare …', 'Fare loaded'],
    },
  },
  es: {
    tagline: 'Tu asistente ferroviario con IA para Suiza',
    disclaimer: 'No oficial · sin relación con SBB CFF FFS',
    langBadge: '100+ idiomas',
    emptyHint:
      'Pregúntame en lenguaje normal por salidas, retrasos, vías, conexiones, composición del tren o lo lleno que irá tu tren.',
    examplesLabel: 'Prueba una pregunta',
    examples: [
      'Mi tren a Berna lleva retraso, estoy en Olten — ¿dónde está?',
      'Próxima conexión de Zürich HB a Ginebra',
      '¿Dónde para el vagón restaurante del IC 1 — en qué sector?',
      '¿Qué tan lleno irá el tren de Lausana a Ginebra a las 17?',
      '¿Hay perturbaciones en la línea del San Gotardo?',
      '¿Cuánto cuesta el viaje de Basilea a Lugano?',
      '¿Qué trenes salen de Lucerna en la próxima hora?',
      'Conexión de Winterthur a Interlaken mañana a las 9',
      '¿Puedo llevar mi bici en el IR a Coira?',
      '¿De qué vía sale el próximo tren a Berna en Olten?',
      'Próximas salidas desde Berna dirección Thun',
    ],
    placeholder: 'p. ej. ¿Cuándo sale el próximo tren de Olten a Berna?',
    send: 'Buscar',
    thinking: 'Un momento',
    error: 'Algo salió mal. Inténtalo de nuevo en un momento.',
    footerNote: 'Sin garantía · fuente de datos: opentransportdata.swiss',
    oss: 'Open Source',
    by: 'un proyecto de',
    imprint: 'Aviso legal',
    privacy: 'Privacidad',
    tools: {
      searchStations: ['Buscando estación …', 'Estación encontrada'],
      getDepartures: ['Cargando salidas …', 'Salidas cargadas'],
      getArrivals: ['Cargando llegadas …', 'Llegadas cargadas'],
      planJourney: ['Buscando conexiones …', 'Conexiones encontradas'],
      trackTrain: ['Siguiendo el tren …', 'Tren seguido'],
      nearbyStations: ['Buscando cerca …', 'Paradas encontradas'],
      trainFormation: ['Cargando composición …', 'Composición cargada'],
      getOccupancy: ['Comprobando ocupación …', 'Ocupación cargada'],
      getDisruptions: ['Comprobando perturbaciones …', 'Perturbaciones cargadas'],
      getFares: ['Consultando precio …', 'Precio cargado'],
    },
  },
  tr: {
    tagline: 'İsviçre için yapay zekâ tren asistanın',
    disclaimer: 'Resmi değildir · SBB CFF FFS ile bağlantısı yoktur',
    langBadge: '100+ dil',
    emptyHint:
      'Kalkışlar, gecikmeler, peronlar, bağlantılar, vagon dizilişi veya trenin ne kadar dolu olacağı hakkında normal dille sor.',
    examplesLabel: 'Bir soru dene',
    examples: [
      'Bern’e giden trenim gecikti, Olten’deyim — tren nerede?',
      'Zürich HB’den Cenevre’ye sonraki bağlantı',
      'IC 1’de yemekli vagon nerede duruyor — hangi sektör?',
      'Lozan’dan Cenevre’ye 17.00 treni ne kadar dolu olacak?',
      'Gotthard hattında aksama var mı?',
      'Basel’den Lugano’ya yolculuk ne kadar?',
      'Önümüzdeki bir saatte Luzern’den hangi trenler kalkıyor?',
      'Coire’a giden IR’de bisikletimi götürebilir miyim?',
      'Olten’de Bern’e giden sonraki tren hangi perondan kalkıyor?',
      'Bern’den Thun yönüne sonraki kalkışlar',
    ],
    placeholder: 'örn. Olten’den Bern’e sonraki tren ne zaman?',
    send: 'Ara',
    thinking: 'Bir dakika',
    error: 'Bir hata oluştu. Lütfen birazdan tekrar deneyin.',
    footerNote: 'Garanti verilmez · veri kaynağı: opentransportdata.swiss',
    oss: 'Açık kaynak',
    by: 'bir projesi:',
    imprint: 'Künye',
    privacy: 'Gizlilik',
    tools: {
      searchStations: ['İstasyon aranıyor …', 'İstasyon bulundu'],
      getDepartures: ['Kalkışlar yükleniyor …', 'Kalkışlar yüklendi'],
      getArrivals: ['Varışlar yükleniyor …', 'Varışlar yüklendi'],
      planJourney: ['Bağlantılar aranıyor …', 'Bağlantılar bulundu'],
      trackTrain: ['Tren izleniyor …', 'Tren izlendi'],
      nearbyStations: ['Yakınlarda aranıyor …', 'Duraklar bulundu'],
      trainFormation: ['Vagon dizilişi yükleniyor …', 'Diziliş yüklendi'],
      getOccupancy: ['Doluluk kontrol ediliyor …', 'Doluluk yüklendi'],
      getDisruptions: ['Aksamalar kontrol ediliyor …', 'Aksamalar yüklendi'],
      getFares: ['Fiyat sorgulanıyor …', 'Fiyat yüklendi'],
    },
  },
};

export function detectLang(): Lang {
  if (typeof navigator === 'undefined') return 'de';
  const codes = [navigator.language, ...(navigator.languages ?? [])];
  for (const c of codes) {
    const short = c.slice(0, 2).toLowerCase() as Lang;
    if (short in STRINGS) return short;
  }
  return 'en';
}
