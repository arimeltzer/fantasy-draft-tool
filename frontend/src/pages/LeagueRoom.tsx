import { useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useLeague } from "@/hooks/useLeague";
import { usePlayers } from "@/hooks/usePlayers";
import { useSos } from "@/hooks/useSos";
import { useBoard } from "@/hooks/useBoard";
import { useDraftStore } from "@/store/draftStore";
import { LeagueSettings } from "@/lib/api";
import AuctionRoom from "@/components/auction/AuctionRoom";
import SnakeRoom from "@/components/snake/SnakeRoom";

export default function LeagueRoom() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const leagueId = Number(id);

  const { data: league, isLoading: leagueLoading, error: leagueError } = useLeague(leagueId);
  const { data: players, isLoading: playersLoading } = usePlayers();
  const { data: sos } = useSos();

  const settings = league?.settings as LeagueSettings | undefined;
  const board = useBoard(players, settings, sos);

  const hydrate = useDraftStore((s) => s.hydrate);

  useEffect(() => {
    if (leagueId) hydrate(leagueId);
  }, [leagueId, hydrate]);

  const loading = leagueLoading || playersLoading;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <Loader2 className="h-6 w-6 animate-spin text-faint" />
      </div>
    );
  }

  if (leagueError || !league) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <div className="text-center">
          <p className="mb-4 text-muted">League not found.</p>
          <button onClick={() => nav("/")} className="mx-auto flex items-center gap-1 text-sm text-muted hover:text-ink">
            <ArrowLeft className="h-4 w-4" /> Back to leagues
          </button>
        </div>
      </div>
    );
  }

  if (!settings) {
    return null;
  }

  const sharedProps = { league, settings, board, leagueId };

  return league.format === "auction"
    ? <AuctionRoom {...sharedProps} />
    : <SnakeRoom {...sharedProps} />;
}
