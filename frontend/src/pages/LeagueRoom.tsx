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
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
      </div>
    );
  }

  if (leagueError || !league) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-center">
          <p className="text-slate-400 mb-4">League not found.</p>
          <button onClick={() => nav("/")} className="text-sm text-slate-500 hover:text-slate-300 flex items-center gap-1">
            <ArrowLeft className="w-4 h-4" /> Back to leagues
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
