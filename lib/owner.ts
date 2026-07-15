// Betreiber-Angaben (Impressum/Datenschutz) kommen aus Env-Variablen, NICHT aus
// dem Code. So bleibt das öffentliche Repo generisch: Ohne gesetzte Werte werden
// Impressum-/Datenschutz-Links ausgeblendet und die Datenschutz-Seite zeigt einen
// Platzhalter. Wer die App selbst betreibt, setzt seine eigenen Angaben per Env.

export type Owner = {
  name: string;
  address: string;
  imprintUrl: string;
  contactUrl: string;
};

/** Liefert die Betreiber-Angaben, oder null wenn nicht (vollständig) konfiguriert. */
export function getOwner(): Owner | null {
  const name = process.env.OWNER_NAME?.trim();
  const address = process.env.OWNER_ADDRESS?.trim();
  const imprintUrl = process.env.OWNER_IMPRINT_URL?.trim();
  if (!name || !address || !imprintUrl) return null;
  return {
    name,
    address,
    imprintUrl,
    contactUrl: process.env.OWNER_CONTACT_URL?.trim() || imprintUrl,
  };
}
