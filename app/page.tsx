import { Chat } from '@/components/chat';
import { getOwner } from '@/lib/owner';

export default function Home() {
  // Impressum-URL nur an die (Client-)UI geben, wenn Betreiber konfiguriert ist —
  // sonst blendet der Footer die Rechts-Links aus.
  const owner = getOwner();
  return <Chat imprintUrl={owner?.imprintUrl ?? null} />;
}
