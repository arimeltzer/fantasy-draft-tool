import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

interface Stage {
  label: string;
  when: string;
  what: string;
}

const STAGES: Stage[] = [
  {
    label: "Base model",
    when: "Every player.",
    what: "Blends the last two seasons' scoring pace (weighted toward the more recent one, with a bigger tilt when the trend is consistent), then adjusts for age and durability — a history of missed games discounts the projection. Players with no prior-season stats (rookies, or anyone who missed last season entirely) skip the pace blend and are projected from market rank (ADP/ECR) instead, scaled to a typical rookie ceiling at the position.",
  },
  {
    label: "Opportunity model (TE)",
    when: "Tight ends only, when they have prior-season target data.",
    what: "Replaces the pace blend above. Points are volume × efficiency, and only one of those repeats year to year — touchdown rate is close to random, but target share is not. This stage projects next season's targets the same trend-weighted way the base model projects points, then applies a league-wide, empirically shrunk points-per-target rate on top. Backtested 2017–2025 against the live pipeline; only TE cleared the bar (QB/WR's apparent gains turned out to be signal the expert blend below was already extracting; RB never had any).",
  },
  {
    label: "Team change",
    when: "RB and WR who switched teams this offseason (their team this year differs from the team they finished last season on).",
    what: "Discounts the projection 25% — a new situation (offensive scheme, target competition, blocking, quarterback) is a real reset that last year's pace doesn't capture. Backtested 2017–2025, measured two ways like the opportunity model above: against the pure model (QB/RB/WR all cleared the bar) and re-baselined against the live board — QB's gain nearly vanished there (already captured by QB's own injury discount and expert-blend weight), but RB and WR held up. Coaching changes, QB changes and team pace were also tested as separate signals and none of them cleared the bar, so only this one shipped. A player with no recorded team from last season (a rookie) is untouched.",
  },
  {
    label: "Injury discount",
    when: "QB and RB with a currently reported injury status (out / doubtful / questionable).",
    what: "Converts the CURRENT reported status into expected games missed and discounts the projection proportionally. This is separate from the durability adjustment in the base model, which reacts to LAST season's games played — this reacts to what's reported for the upcoming one. Backtested 2017–2025; WR/TE did not show a clean signal here (the base model's durability adjustment was already capturing it) so they're left untouched.",
  },
  {
    label: "Expert blend",
    when: "Every non-rookie player FantasyPros has a projection for.",
    what: "Blends our model's number with FantasyPros' consensus expert projection, in points (not just rank order — that's what the market anchor below does). The weight on our own model varies by position (backtested 2019–2025): experts are trusted most at WR and least at RB/TE. Rookies skip this stage — their projection already leans on the same expert/market data at a higher priority.",
  },
  {
    label: "Schedule strength",
    when: "Every player, once opponent-strength data is loaded for the league.",
    what: "Multiplies the projection by a per-position, per-team strength-of-schedule factor — a receiver facing weak pass defenses all season is worth a bit more than the raw number, and vice versa.",
  },
  {
    label: "Market anchor",
    when: "Players the market actually ranks (have an ADP or ECR).",
    what: "Pulls the projection toward ADP/ECR consensus ORDER by transferring rank onto our own points ladder — a correction for players the market ranks, not a re-projection. Backtested 2017–2025: the market beats this model outright on the players it covers, at every position, so anchoring the covered half of the board measurably improves the full board. Players the market doesn't rank (deep bench/waiver-tier guys, ~45% of a typical board) are left on the model's own number.",
  },
];

export default function Methodology() {
  const nav = useNavigate();
  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="max-w-2xl mx-auto">
        <button
          onClick={() => (window.history.length > 1 ? nav(-1) : nav("/"))}
          className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-600 mb-6"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>

        <h1 className="text-lg font-semibold tracking-tight">How projections are built</h1>
        <p className="text-sm text-gray-500 mt-1 mb-8">
          Hovering the projected-points number ("Proj") on any player row shows the exact waterfall
          below for that player — only the stages that actually changed their number, in the order
          they ran. This page explains what each stage does and when it fires. Every stage is
          backtested against real outcomes before shipping; none are applied unless they measurably
          improved the board.
        </p>

        <div className="space-y-5">
          {STAGES.map((s, i) => (
            <div key={s.label} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-mono text-gray-400">{i + 1}</span>
                <h2 className="font-medium text-sm">{s.label}</h2>
              </div>
              <p className="text-xs text-gray-500 font-mono mt-1">{s.when}</p>
              <p className="text-sm text-gray-600 mt-2 leading-relaxed">{s.what}</p>
            </div>
          ))}
        </div>

        <h2 className="text-sm font-semibold tracking-tight mt-10">Other columns</h2>
        <div className="space-y-3 mt-3">
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <h3 className="font-medium text-sm">VBD</h3>
            <p className="text-sm text-gray-600 mt-1 leading-relaxed">
              Value Based Drafting: projected points above a replacement-level player at the same
              position — a bench/waiver-wire fill-in. Computed LAST, after every stage above has
              finished adjusting the projection, from wherever that leaves each position's
              replacement level. The bigger the number, the more a player wins you over the
              alternative of just leaving that roster spot to the waiver wire.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <h3 className="font-medium text-sm">$Par / $Live (auction)</h3>
            <p className="text-sm text-gray-600 mt-1 leading-relaxed">
              $Par is the player's fair auction price before the draft starts — the league's total
              budget split among draftable players in proportion to VBD. $Live reprices that par
              value for how the room is actually spending: if teams have overpaid so far, the
              remaining players are worth more (inflation), and vice versa.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <h3 className="font-medium text-sm">Tier</h3>
            <p className="text-sm text-gray-600 mt-1 leading-relaxed">
              Players in the same tier at a position are roughly interchangeable in value; a new
              tier number means a real drop-off, a useful cue for when it's worth reaching versus
              waiting.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <h3 className="font-medium text-sm">'25 pace</h3>
            <p className="text-sm text-gray-600 mt-1 leading-relaxed">
              Last season's scoring pace projected over a full season — a reality check next to the
              projection, not an input to it. "no '25" means the player has no usable prior-season
              stats (rookie, or missed the season), which is also why their base model projection
              leans on market rank instead of a pace blend.
            </p>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <h3 className="font-medium text-sm">mkt +/-</h3>
            <p className="text-sm text-gray-600 mt-1 leading-relaxed">
              How many spots this tool ranks the player above (+) or below (−) expert consensus.
              Positive means the market likes them more than we do (they'll cost extra); negative
              is a potential bargain the market is sleeping on.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
