import { useState } from "react";
import type { SessionAnalyticsState } from "../analytics";
import type { DrillSnapshot } from "../session/types";
import { formatBB, type LegalAction, type TrainerState } from "./trainerModel";
import type { UiDrillMode } from "./sessionAdapter";
import "./practice.css";

export type PracticeStreet = "all" | "preflop" | "flop" | "turn" | "river";

export function PracticeToolbar({ mode, street, onStreet, onMode, onNext, onReplay, onFilters, busy, count, visited, title, bookmarked, onBookmark }: {
  mode: UiDrillMode; street: PracticeStreet; onStreet: (street: PracticeStreet) => void;
  onMode: (mode: UiDrillMode) => void; onNext: () => void; onReplay: () => void; onFilters: () => void;
  busy: boolean; count: number; visited: number; title: string; bookmarked: boolean; onBookmark: () => void;
}) {
  return <section className="practice-toolbar" aria-label="Practice controls">
    <div className="practice-mode" role="group" aria-label="Practice mode">
      <button type="button" aria-pressed={mode === "Node drill"} onClick={() => onMode("Node drill")}>Spot circuit</button>
      <button type="button" aria-pressed={mode === "Full hand"} onClick={() => onMode("Full hand")}>Full hands</button>
    </div>
    <div className="practice-identity"><strong title={title}>{title}</strong><span>{mode === "Full hand" ? "New cards · rotating Button" : `${count.toLocaleString()} matching spots · ${visited} visited`}</span></div>
    <div className="practice-filter-controls">
      {mode !== "Full hand" ? <label className="street-select"><span className="sr-only">Practice street</span><select aria-label="Practice street" value={street} onChange={(event) => onStreet(event.target.value as PracticeStreet)}><option value="all">All streets</option><option value="preflop">Preflop</option><option value="flop">Flop</option><option value="turn">Turn</option><option value="river">River</option></select></label> : null}
      <button type="button" className="practice-quiet" onClick={onFilters}>Filters</button>
      <button type="button" className="practice-quiet replay-control" disabled={busy} onClick={onReplay} title="Replay these exact cards and actions">Replay</button>
      <button type="button" className="practice-bookmark" aria-label={bookmarked ? "Remove saved spot" : "Save this spot"} aria-pressed={bookmarked} onClick={onBookmark} disabled={mode !== "Node drill" || busy}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v17l-6-4-6 4Z" /></svg></button>
      <button type="button" className="practice-next" onClick={onNext}>{busy ? "Skip waiting" : mode === "Full hand" ? "Deal hand" : "Next spot"}<span aria-hidden="true"> →</span></button>
    </div>
  </section>;
}

type HudTab = "table" | "seat" | "session";

export function StudyHud({ state, snapshot, analytics, selectedSeat, onSeat, preview, onPreview, busy, solverLabel, onSolver, onReview, onSaved, savedCount, rangeAssumption }: {
  state: TrainerState; snapshot: DrillSnapshot | null; analytics: SessionAnalyticsState;
  selectedSeat: number | null; onSeat: (index: number | null) => void; preview: LegalAction | null;
  onPreview: (action: LegalAction | null) => void; busy: boolean; solverLabel: string;
  onSolver: () => void; onReview: () => void; onSaved: () => void; savedCount: number; rangeAssumption?: string;
}) {
  const [tab, setTab] = useState<HudTab>("table");
  const [mobileOpen, setMobileOpen] = useState(false);
  const actualTab = selectedSeat === null ? tab : "seat";
  const seat = selectedSeat === null ? null : state.seats[selectedSeat];
  const records = analytics.records;
  const evRecords = records.filter((record) => record.evLossBB !== undefined);
  const totalLoss = evRecords.reduce((sum, record) => sum + (record.evLossBB ?? 0), 0);
  const changeTab = (next: HudTab) => { onSeat(null); setTab(next); };
  const decisionMath = snapshot?.reveal?.decisionMath ?? snapshot?.decisionMath;
  const callPct = decisionMath?.potOdds?.requiredEquity === undefined ? state.callOdds?.requiredEquityPct : decisionMath.potOdds.requiredEquity * 100;
  const open = mobileOpen || selectedSeat !== null;
  return <aside className={`study-hud ${open ? "hud-open" : ""}`} aria-label="Interactive study HUD">
    <button type="button" className="hud-mobile-launcher" aria-expanded={open} onClick={() => { if (open) onSeat(null); setMobileOpen(!open); }}><strong>{open ? "Close HUD" : "Open HUD"}</strong><span>{state.activePlayerCount} in pot · SPR {state.exactCurrentSpr.toFixed(2)}{callPct === undefined ? "" : ` · ${callPct.toFixed(1)}% to call`}</span></button>
    <div className="hud-content">
      <div className="hud-tabs" role="group" aria-label="HUD panel"><button type="button" aria-pressed={actualTab === "table"} onClick={() => changeTab("table")}>Table</button><button type="button" aria-pressed={actualTab === "seat"} onClick={() => { setTab("seat"); onSeat(state.seats.findIndex((candidate) => candidate.isHero)); }}>Seat</button><button type="button" aria-pressed={actualTab === "session"} onClick={() => changeTab("session")}>Session</button></div>
      {actualTab === "table" ? <>
        <div className="hud-heading"><h2>At this decision</h2><span>Exact math</span></div>
        <dl className="hud-facts"><div><dt>Pot / to call</dt><dd>{formatBB(state.potBB)} / {formatBB(state.amountToCallBB)}</dd></div><div><dt>Current SPR</dt><dd>{state.exactCurrentSpr.toFixed(2)}</dd></div><div><dt>Flop-start SPR</dt><dd>{state.exactFlopStartSpr?.toFixed(2) ?? "Not reached"}</dd></div><div><dt>Raw equity to call</dt><dd>{callPct === undefined ? "No call facing you" : `${callPct.toFixed(2)}%`}</dd></div><div><dt>Players / dealt</dt><dd>{state.activePlayerCount} / {state.playerCount}</dd></div></dl>
        <div className="hud-sizing"><label htmlFor="hud-sizing-action">Preview an action</label><select id="hud-sizing-action" value={preview?.id ?? ""} onChange={(event) => onPreview(state.legalActions.find((action) => action.id === event.target.value) ?? null)} disabled={busy || snapshot?.phase !== "AWAITING_HERO"}><option value="">Choose a legal size…</option>{state.legalActions.filter((action) => !["fold", "check"].includes(action.family)).map((action) => <option key={action.id} value={action.id}>{action.label}</option>)}</select>{preview ? <dl className="hud-projection"><div><dt>Additional risk</dt><dd>{formatBB(preview.amountAddedBB)}</dd></div><div><dt>Total wager</dt><dd>{formatBB(preview.totalSizeBB)}</dd></div><div><dt>Pot if one calls</dt><dd>{state.activePlayerCount === 2 && preview.potIfCalledBB !== undefined ? formatBB(preview.potIfCalledBB) : "Choose opponent in math"}</dd></div><div><dt>Hero behind</dt><dd>{formatBB(preview.heroBehindBB)}</dd></div><div><dt>Projected SPR</dt><dd>{state.activePlayerCount === 2 ? preview.projectedSpr?.toFixed(2) ?? "—" : "Opponent-dependent"}</dd></div></dl> : <p>Inspect the stack commitment before choosing. This does not submit an answer.</p>}</div>
        <div className="hud-line"><h3>Latest action</h3><p>{state.actionHistory.at(-1) ?? "Blinds posted. Action is on you."}</p></div>
      </> : actualTab === "seat" ? <>
        <div className="hud-heading"><h2>{seat?.position ?? state.heroPosition}{seat?.isHero ? " · Your seat" : " · Seat inspection"}</h2></div>
        <div className="hud-seat-picker" role="group" aria-label="Inspect seat">{state.seats.map((candidate, index) => <button type="button" key={candidate.position} aria-pressed={selectedSeat === index} onClick={() => onSeat(index)}>{candidate.position}</button>)}</div>
        <dl className="hud-facts"><div><dt>Stack behind</dt><dd>{formatBB(seat?.stackBB ?? state.heroStackBB)}</dd></div><div><dt>Status</dt><dd>{seat?.status ?? "To act"}</dd></div><div><dt>Button</dt><dd>{seat?.isButton ? "Yes" : "No"}</dd></div></dl>
        <p className="hud-hint">{seat?.isHero ? "Your two cards are visible at the table." : "Opponent cards stay concealed until an appropriate showdown."} Tap another seat to inspect its public actions.</p>
        <ol className="hud-seat-history">{state.actionHistory.filter((line) => line.startsWith(`${seat?.position ?? state.heroPosition} `)).slice(-8).map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ol>
      </> : <>
        <div className="hud-heading"><h2>Your session</h2><span>Saved locally</span></div>
        <dl className="hud-facts"><div><dt>Hands started</dt><dd>{analytics.handsStarted}</dd></div><div><dt>Decisions</dt><dd>{records.length}</dd></div><div><dt>With comparable EV</dt><dd>{evRecords.length}</dd></div><div><dt>Measured EV loss</dt><dd>{evRecords.length ? `${totalLoss.toFixed(2)} BB` : "Unavailable"}</dd></div></dl>
        <div className="hud-recent"><h3>Recent decisions</h3>{records.length === 0 ? <p>Your decisions appear here after you answer.</p> : records.slice(-5).reverse().map((record) => <div key={record.id}><span>{record.heroPosition} · {record.street}</span><strong>{record.grade}</strong></div>)}</div>
        <button type="button" className="hud-link" onClick={onSaved} disabled={savedCount === 0}>Practice saved spots ({savedCount})</button>
      </>}
      {rangeAssumption ? <details className="hud-assumption"><summary>Range assumptions</summary><p>{rangeAssumption}</p></details> : null}
      <div className="hud-provider"><button type="button" onClick={onSolver}><span className={`solver-dot ${busy ? "solver-working" : ""}`} aria-hidden="true" /><strong>{busy ? "Preparing decision…" : solverLabel}</strong><span>Manage</span></button><p>{busy ? "Your answer stays hidden while the provider prepares this node." : "Source frequencies and EV appear after your answer."}</p></div>
      {snapshot?.reveal ? <button type="button" className="hud-review" onClick={onReview}>Review last decision</button> : null}
    </div>
  </aside>;
}
