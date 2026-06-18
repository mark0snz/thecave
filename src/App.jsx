import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "./supabase";
import caveLogo from "./assets/cave-logo.png";

/* ------------------------------------------------------------------ *
 * THE CAVE — Player Board (two-screen app)
 * Phone = Controller (type names) -> TV = Display (live scoreboard)
 * Sync runs through Supabase Realtime: one row per arena/slot cell in
 * the `players` table. The controller writes (debounced), every open
 * screen receives postgres_changes events and updates live.
 * ------------------------------------------------------------------ */

const ARENAS = [
  { key: "red", label: "Red", color: "#ff5a5a" },
  { key: "green", label: "Green", color: "#36d399" },
  { key: "blue", label: "Blue", color: "#4d9bff" },
];
const SLOTS = [0, 1, 2, 3];

// Where each arena sits on the TV, mirroring the real venue floor:
// Blue top-left, Red top-right, Green centred below.
const FLOOR = [
  { key: "blue", pos: "tl" },
  { key: "red", pos: "tr" },
  { key: "green", pos: "bc" },
];
// On-screen quadrant order (top-left, top-right, bottom-left, bottom-right)
// holds the player numbers in their physical spots in the arena.
const QUADS = [2, 3, 1, 4];

// Order the arenas appear on the phone controller.
const PHONE_ARENAS = ["blue", "red", "green"].map((k) =>
  ARENAS.find((a) => a.key === k)
);

// Quick lookup of an arena's { key, label, color } by its key.
const ARENA_BY_KEY = Object.fromEntries(ARENAS.map((a) => [a.key, a]));

const WRITE_DEBOUNCE_MS = 350;
const GUARD_MS = 1500; // how long after a keystroke a cell counts as "being typed"

const emptyBoard = () => ({
  arenas: { red: ["", "", "", ""], green: ["", "", "", ""], blue: ["", "", "", ""] },
  // owner of each physical pod: null = belongs to its native arena, else a team key
  owners: { red: [null, null, null, null], green: [null, null, null, null], blue: [null, null, null, null] },
});

// Fold the flat `players` rows into the board shape the UI expects.
const boardFromRows = (rows) => {
  const arenas = {
    red: ["", "", "", ""],
    green: ["", "", "", ""],
    blue: ["", "", "", ""],
  };
  const owners = {
    red: [null, null, null, null],
    green: [null, null, null, null],
    blue: [null, null, null, null],
  };
  for (const r of rows || []) {
    if (arenas[r.arena] && r.slot >= 1 && r.slot <= 4) {
      arenas[r.arena][r.slot - 1] = r.name ?? "";
      owners[r.arena][r.slot - 1] = r.owner ?? null;
    }
  }
  return { arenas, owners };
};

// Effective owner of a pod: its explicit owner, or its native arena.
const ownerOf = (board, arena, i) => board.owners[arena][i] || arena;

/* ----------------------------- shared sync hook ----------------------------- *
 * Supabase Realtime sync. Same return contract as the prototype
 * ({ board, setPlayer, clearArena, status, lastSynced }) — only the
 * transport changed (out: window.storage + polling; in: Supabase).
 * ------------------------------------------------------------------ */
function useBoard(active) {
  const [board, setBoard] = useState(emptyBoard);
  const [status, setStatus] = useState("connecting");
  const [lastSynced, setLastSynced] = useState(null);

  // Always-fresh board snapshot for callbacks that need to read current state.
  const boardRef = useRef(board);
  boardRef.current = board;

  // Whether the `owner` column exists yet (the reconfiguration migration).
  // Until it does, ownership is local-only (optimistic) so the UI still works.
  const ownerColumn = useRef(true);

  // Typing guard: cellKey -> { value, ts } for cells the operator is editing,
  // so a write echo can't overwrite the exact cell being typed mid-keystroke.
  const editing = useRef({});
  // Per-cell debounce timers, so quick edits across different cells don't drop writes.
  const writeTimers = useRef({});

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    async function load() {
      try {
        let { data, error } = await supabase
          .from("players")
          .select("arena,slot,name,owner");
        // The `owner` column may not exist yet (migration not run). Fall back
        // to a name-only load so the board still works; ownership stays local.
        if (error) {
          ownerColumn.current = false;
          ({ data, error } = await supabase
            .from("players")
            .select("arena,slot,name"));
        } else {
          ownerColumn.current = true;
        }
        if (cancelled) return;
        if (error) {
          setStatus("error");
          return;
        }
        setBoard(boardFromRows(data));
        setLastSynced(Date.now());
      } catch (e) {
        if (!cancelled) setStatus("error");
      }
    }
    load();

    const channel = supabase
      .channel("players")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "players" },
        ({ new: row }) => {
          if (!row) return;
          const key = row.arena + "-" + row.slot;
          const g = editing.current[key];
          if (g) {
            const fresh = Date.now() - g.ts < GUARD_MS;
            // Operator is actively typing this exact cell and the echo is
            // stale — skip applying it so it can't clobber mid-typing.
            if (fresh && g.value !== row.name) return;
            // Echo caught up, or the cell went idle — stop guarding it.
            delete editing.current[key];
          }
          setBoard((prev) => ({
            ...prev,
            arenas: {
              ...prev.arenas,
              [row.arena]: prev.arenas[row.arena].map((v, i) =>
                i === row.slot - 1 ? row.name ?? "" : v
              ),
            },
            owners: {
              ...prev.owners,
              [row.arena]: prev.owners[row.arena].map((v, i) =>
                i === row.slot - 1 ? row.owner ?? null : v
              ),
            },
          }));
          setLastSynced(Date.now());
        }
      )
      .subscribe((s) => {
        if (s === "SUBSCRIBED") setStatus("live");
        else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") setStatus("error");
        else setStatus("connecting");
      });

    return () => {
      cancelled = true;
      Object.values(writeTimers.current).forEach(clearTimeout);
      writeTimers.current = {};
      supabase.removeChannel(channel);
    };
  }, [active]);

  // Debounced per-cell write to Supabase.
  const writeCell = useCallback((arena, slot, name) => {
    const key = arena + "-" + slot;
    if (writeTimers.current[key]) clearTimeout(writeTimers.current[key]);
    writeTimers.current[key] = setTimeout(async () => {
      delete writeTimers.current[key];
      try {
        setStatus("saving");
        const { error } = await supabase
          .from("players")
          .update({ name, updated_at: new Date().toISOString() })
          .eq("arena", arena)
          .eq("slot", slot);
        if (error) {
          setStatus("error");
          return;
        }
        setStatus("live");
        setLastSynced(Date.now());
      } catch (e) {
        setStatus("error");
      }
    }, WRITE_DEBOUNCE_MS);
  }, []);

  const setPlayer = useCallback(
    (arenaKey, idx, name) => {
      const slot = idx + 1;
      // Mark this cell as actively edited so realtime echoes don't clobber typing.
      editing.current[arenaKey + "-" + slot] = { value: name, ts: Date.now() };
      setBoard((prev) => ({
        ...prev,
        arenas: {
          ...prev.arenas,
          [arenaKey]: prev.arenas[arenaKey].map((v, i) => (i === idx ? name : v)),
        },
      }));
      writeCell(arenaKey, slot, name);
    },
    [writeCell]
  );

  // Set/clear the owner of a pod (claim or release in Reconfigure mode).
  // Applies optimistically; persists only once the `owner` column exists.
  const setOwner = useCallback((arenaKey, idx, owner) => {
    const slot = idx + 1;
    setBoard((prev) => ({
      ...prev,
      owners: {
        ...prev.owners,
        [arenaKey]: prev.owners[arenaKey].map((v, i) => (i === idx ? owner : v)),
      },
    }));
    if (!ownerColumn.current) return; // local-only until migration is run
    (async () => {
      try {
        setStatus("saving");
        const { error } = await supabase
          .from("players")
          .update({ owner, updated_at: new Date().toISOString() })
          .eq("arena", arenaKey)
          .eq("slot", slot);
        if (error) {
          setStatus("error");
          return;
        }
        setStatus("live");
        setLastSynced(Date.now());
      } catch (e) {
        setStatus("error");
      }
    })();
  }, []);

  const clearArena = useCallback((team) => {
    // Every pod whose effective owner is this team (native + claimed elsewhere).
    const b = boardRef.current;
    const cells = [];
    for (const a of ["red", "green", "blue"]) {
      for (let i = 0; i < 4; i++) {
        if (ownerOf(b, a, i) === team) cells.push({ a, slot: i + 1, i });
      }
    }

    // Optimistic local clear of those names.
    setBoard((prev) => {
      const arenas = {
        red: [...prev.arenas.red],
        green: [...prev.arenas.green],
        blue: [...prev.arenas.blue],
      };
      cells.forEach(({ a, i }) => (arenas[a][i] = ""));
      return { ...prev, arenas };
    });

    const now = Date.now();
    cells.forEach(({ a, slot }) => {
      const key = a + "-" + slot;
      if (writeTimers.current[key]) {
        clearTimeout(writeTimers.current[key]);
        delete writeTimers.current[key];
      }
      editing.current[key] = { value: "", ts: now };
    });

    (async () => {
      try {
        setStatus("saving");
        const upd = { name: "", updated_at: new Date().toISOString() };
        // With ownership: clear native-unclaimed + claimed-by-this-team pods.
        // Without it (pre-migration): just this arena's four pods.
        const q = ownerColumn.current
          ? supabase.from("players").update(upd)
              .or(`and(arena.eq.${team},owner.is.null),owner.eq.${team}`)
          : supabase.from("players").update(upd).eq("arena", team);
        const { error } = await q;
        if (error) {
          setStatus("error");
          return;
        }
        setStatus("live");
        setLastSynced(Date.now());
      } catch (e) {
        setStatus("error");
      }
    })();
  }, []);

  return { board, setPlayer, setOwner, clearArena, status, lastSynced };
}

/* ----------------------------- status chip ----------------------------- */
function StatusChip({ status }) {
  const map = {
    live: { t: "Live", c: "#36d399" },
    saving: { t: "Saving…", c: "#4d9bff" },
    connecting: { t: "Connecting…", c: "#8b949e" },
    error: { t: "Sync error", c: "#ff5a5a" },
    local: { t: "Local only", c: "#e3b341" },
  };
  const s = map[status] || map.connecting;
  return (
    <span className="chip" style={{ ["--dot"]: s.c }}>
      <span className="dot" />
      {s.t}
    </span>
  );
}

/* ----------------------------- role picker ----------------------------- */
function RolePicker({ onPick }) {
  return (
    <div className="screen center">
      <div className="brand">
        <img className="brandLogo" src={caveLogo} alt="The Cave" />
        <p className="sub">Set up this device</p>
      </div>
      <div className="pickRow">
        <button className="pickCard" onClick={() => onPick("controller")}>
          <span className="pickEmoji">📱</span>
          <span className="pickTitle">This is the phone</span>
          <span className="pickDesc">Type player names</span>
        </button>
        <button className="pickCard" onClick={() => onPick("display")}>
          <span className="pickEmoji">🖥️</span>
          <span className="pickTitle">This is the TV</span>
          <span className="pickDesc">Show the board</span>
        </button>
      </div>
      <p className="hint">
        Open this on both screens. Names typed on the phone appear on the TV automatically.
      </p>
    </div>
  );
}

/* ----------------------------- controller (phone) ----------------------------- */
function Controller({ onSwitch }) {
  const { board, setPlayer, setOwner, clearArena, status } = useBoard(true);
  const [arena, setArena] = useState("blue");
  const [confirmClear, setConfirmClear] = useState(false);
  const [reconfig, setReconfig] = useState(false);
  const inputs = useRef([]);

  const current = ARENAS.find((a) => a.key === arena);

  // Effective owner of a physical pod (explicit owner, else its native arena).
  const ownerKeyAt = (arenaKey, i) => board.owners[arenaKey][i] || arenaKey;

  // Pods this team has claimed in OTHER arenas (overflow players live here).
  const claimedPods = [];
  for (const a of ["red", "green", "blue"]) {
    if (a === arena) continue;
    board.owners[a].forEach((own, i) => {
      if (own === arena) claimedPods.push({ a, i });
    });
  }

  const handleEnter = (playerNum) => {
    const pos = QUADS.indexOf(playerNum);
    const nextNum = QUADS[pos + 1];
    if (nextNum != null) inputs.current[nextNum - 1]?.focus();
    else inputs.current[playerNum - 1]?.blur();
  };

  /* ---- Reconfigure mode: tap pods in any arena to assign them to `arena` ---- */
  if (reconfig) {
    return (
      <div className="screen ctrl">
        <header className="ctrlHead">
          <div className="ctrlBrand">
            <img className="brandLogoSm" src={caveLogo} alt="The Cave" />
            <span className="role">Reconfigure</span>
          </div>
          <div className="ctrlHeadRight">
            <StatusChip status={status} />
            <button className="backBtn" onClick={() => setReconfig(false)}>
              Done
            </button>
          </div>
        </header>

        <p className="reconfigHint">
          Tap any pod to add it to the{" "}
          <b style={{ color: current.color }}>{current.label}</b> team. Tap again to
          release it back to its own arena.
        </p>

        <div className="reconfig">
          {PHONE_ARENAS.map((a) => (
            <div className="reconfigArena" key={a.key} style={{ ["--accent"]: a.color }}>
              <span className="miniHead">
                <span className="miniDot" />
                {a.label} Arena
              </span>
              <div className="reconfigQuads">
                {QUADS.map((p) => {
                  const i = p - 1;
                  const own = ownerKeyAt(a.key, i);
                  const ownColor = ARENA_BY_KEY[own].color;
                  const mine = own === arena;
                  const name = board.arenas[a.key][i];
                  return (
                    <button
                      key={p}
                      className={"reconfigPod" + (mine ? " mine" : "")}
                      style={{ ["--accent"]: a.color, ["--owner"]: ownColor }}
                      onClick={() =>
                        setOwner(a.key, i, mine || arena === a.key ? null : arena)
                      }
                    >
                      <span className="reconfigNum">{p}</span>
                      <span className="reconfigNm">{name || "—"}</span>
                      {own !== a.key ? (
                        <span className="reconfigTag" style={{ color: ownColor }}>
                          {ARENA_BY_KEY[own].label}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="screen ctrl">
      <header className="ctrlHead">
        <div className="ctrlBrand">
          <img className="brandLogoSm" src={caveLogo} alt="The Cave" />
          <span className="role">Controller</span>
        </div>
        <div className="ctrlHeadRight">
          <StatusChip status={status} />
          <button
            className="iconBtn"
            onClick={onSwitch}
            title="Exit"
            aria-label="Exit to device setup"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="tabs">
        {PHONE_ARENAS.map((a) => {
          const filled = board.arenas[a.key].filter(Boolean).length;
          return (
            <button
              key={a.key}
              className={"tab" + (a.key === arena ? " on" : "")}
              style={{ ["--accent"]: a.color }}
              onClick={() => {
                setArena(a.key);
                setConfirmClear(false);
              }}
            >
              <span className="tabTop">
                <span className="tabDot" />
                <span className="tabName">{a.label}</span>
              </span>
              <span className="tabCount">{filled}/4</span>
            </button>
          );
        })}
      </div>

      <div className="fields" style={{ ["--accent"]: current.color }}>
        {QUADS.map((p) => {
          const i = p - 1;
          const ownKey = board.owners[arena][i];
          const loanedTo = ownKey && ownKey !== arena ? ownKey : null;
          const loanColor = loanedTo ? ARENA_BY_KEY[loanedTo].color : null;
          return (
            <label
              className={"field" + (loanedTo ? " loaned" : "")}
              key={p}
              style={loanedTo ? { ["--owner"]: loanColor } : undefined}
            >
              <div className="podInner">
                <span className="fieldNum">{p}</span>
                <input
                  ref={(el) => (inputs.current[i] = el)}
                  className="input"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="words"
                  spellCheck={false}
                  placeholder="Enter name"
                  value={board.arenas[arena][i]}
                  onChange={(e) => setPlayer(arena, i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleEnter(p);
                    }
                  }}
                />
              </div>
              {board.arenas[arena][i] ? (
                <button
                  className="clearOne"
                  aria-label={"Clear player " + p}
                  onClick={() => setPlayer(arena, i, "")}
                >
                  ×
                </button>
              ) : null}
            </label>
          );
        })}

        {/* Overflow pods this team has claimed in other arenas */}
        {claimedPods.map(({ a, i }) => (
          <label
            className="field claimed"
            key={a + "-" + i}
            style={{ ["--accent"]: ARENA_BY_KEY[a].color, ["--owner"]: current.color }}
          >
            <div className="podInner">
              <span className="fieldNum">{i + 1}</span>
              <input
                className="input"
                type="text"
                inputMode="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="words"
                spellCheck={false}
                placeholder="Enter name"
                value={board.arenas[a][i]}
                onChange={(e) => setPlayer(a, i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
            {board.arenas[a][i] ? (
              <button
                className="clearOne"
                aria-label="Clear player"
                onClick={() => setPlayer(a, i, "")}
              >
                ×
              </button>
            ) : null}
          </label>
        ))}
      </div>

      <div className="ctrlFoot">
        <button className="ghost" onClick={() => setReconfig(true)}>
          Reconfigure arena
        </button>
        {confirmClear ? (
          <div className="clearConfirm" style={{ ["--accent"]: current.color }}>
            <span className="clearConfirmText">Clear all {current.label} names?</span>
            <div className="clearConfirmBtns">
              <button
                className="confirmBtn keep"
                onClick={() => setConfirmClear(false)}
              >
                Keep
              </button>
              <button
                className="confirmBtn clear"
                onClick={() => {
                  clearArena(arena);
                  setConfirmClear(false);
                }}
              >
                Clear
              </button>
            </div>
          </div>
        ) : (
          <button className="ghost" onClick={() => setConfirmClear(true)}>
            Clear {current.label} arena
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- display (TV) ----------------------------- */
function Display({ onSwitch }) {
  const { board, status } = useBoard(true);
  const prev = useRef(null);
  const [flash, setFlash] = useState({});

  useEffect(() => {
    if (prev.current) {
      const changes = {};
      ARENAS.forEach((a) =>
        SLOTS.forEach((i) => {
          const k = a.key + "-" + i;
          const now = board.arenas[a.key][i];
          if (now && now !== prev.current.arenas[a.key][i]) changes[k] = true;
        })
      );
      if (Object.keys(changes).length) {
        setFlash((f) => ({ ...f, ...changes }));
        Object.keys(changes).forEach((k) =>
          setTimeout(
            () =>
              setFlash((f) => {
                const n = { ...f };
                delete n[k];
                return n;
              }),
            1500
          )
        );
      }
    }
    prev.current = board;
  }, [board]);

  const goFull = () => {
    const el = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.();
  };

  return (
    <div className="screen disp">
      <header className="dispHead">
        <div className="dispBrand">
          <img className="brandLogoDisp" src={caveLogo} alt="The Cave" />
        </div>
        <div className="dispActions">
          <StatusChip status={status} />
          <button className="iconBtn" onClick={goFull} title="Fullscreen">
            ⛶
          </button>
          <button className="iconBtn" onClick={onSwitch} title="Exit">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="floor">
        {FLOOR.map(({ key, pos }) => {
          const a = ARENAS.find((x) => x.key === key);
          return (
            <div key={key} className={"arena " + pos} style={{ ["--accent"]: a.color }}>
              <div className="arenaHeader">
                <span className="arenaName">{a.label} Arena</span>
              </div>
              <div className="arenaBody">
                <div className="vline" />
                <div className="hline" />
                {QUADS.map((p) => {
                  const idx = p - 1;
                  const name = board.arenas[key][idx];
                  const lit = flash[key + "-" + idx];
                  const own = board.owners[key][idx];
                  const claimed = own && own !== key;
                  return (
                    <div
                      key={p}
                      className={"quad" + (lit ? " flash" : "") + (claimed ? " claimed" : "")}
                      style={claimed ? { ["--owner"]: ARENA_BY_KEY[own].color } : undefined}
                    >
                      <span className="quadNum">{p}</span>
                      <span className={"quadName" + (name ? " has" : "")}>
                        {name || <span className="open">Open</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ----------------------------- app shell ----------------------------- */
export default function App() {
  const [role, setRole] = useState(null);

  return (
    <div className="cave">
      <style>{CSS}</style>
      {role === "controller" && <Controller onSwitch={() => setRole(null)} />}
      {role === "display" && <Display onSwitch={() => setRole(null)} />}
      {!role && <RolePicker onPick={setRole} />}
    </div>
  );
}

/* ----------------------------- styles ----------------------------- */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap');

.cave * { box-sizing: border-box; }
.cave {
  --bg: #0b0e14;
  --panel: #141a23;
  --line: #232c39;
  --text: #e9eef5;
  --muted: #7d8896;
  font-family: 'Inter', system-ui, sans-serif;
  color: var(--text);
  min-height: 100vh;
  background:
    radial-gradient(1200px 600px at 50% -10%, #16202e 0%, transparent 60%),
    var(--bg);
}
.screen { min-height: 100vh; padding: clamp(16px, 3vw, 40px); }
.center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 32px; text-align: center; }

/* brand */
.kicker, .kickerSm { font-family:'Space Grotesk'; letter-spacing:.32em; text-transform:uppercase; color:var(--muted); font-size:.7rem; font-weight:600; }
.wordmark { font-family:'Space Grotesk'; font-weight:700; letter-spacing:.14em; margin:.2em 0 0; font-size: clamp(2.4rem, 8vw, 4.5rem); }
.wordmark.big { font-size: clamp(1.6rem, 3vw, 2.4rem); margin:0; }
.wordmarkSm { font-family:'Space Grotesk'; font-weight:700; letter-spacing:.12em; font-size:1.05rem; }
.sub { color:var(--muted); margin:.4em 0 0; }
.brand { display:flex; flex-direction:column; align-items:center; }

/* logo image (replaces the "THE CAVE" text wordmark) */
.brandLogo { width:min(360px, 64vw); height:auto; margin:.15em 0 .05em; display:block; }
.brandLogoSm { height:30px; width:auto; display:block; }
.brandLogoDisp { height:clamp(40px, 5vw, 58px); width:auto; display:block; }

/* status chip */
.chip { display:inline-flex; align-items:center; gap:.5em; font-size:.8rem; color:var(--muted); padding:.35em .7em; border:1px solid var(--line); border-radius:999px; background:rgba(255,255,255,.02); }
.chip .dot { width:.55em; height:.55em; border-radius:50%; background:var(--dot); box-shadow:0 0 10px var(--dot); }

/* role picker */
.pickRow { display:flex; gap:18px; flex-wrap:wrap; justify-content:center; }
.pickCard { display:flex; flex-direction:column; align-items:center; gap:6px; width:200px; padding:28px 20px; background:var(--panel); border:1px solid var(--line); border-radius:18px; color:var(--text); cursor:pointer; transition:transform .15s ease, border-color .15s ease; }
.pickCard:hover { transform:translateY(-3px); border-color:#3a4859; }
.pickEmoji { font-size:2.2rem; }
.pickTitle { font-weight:600; font-size:1.05rem; }
.pickDesc { color:var(--muted); font-size:.85rem; }
.hint { color:var(--muted); max-width:380px; font-size:.9rem; line-height:1.5; }

/* controller */
.ctrl { max-width:520px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
.ctrlHead { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.ctrlBrand { display:flex; flex-direction:column; }
.ctrlHeadRight { display:flex; align-items:center; gap:8px; }
.backBtn { display:inline-flex; align-items:center; gap:3px; padding:8px 12px; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--muted); font-size:.85rem; font-weight:500; cursor:pointer; transition:color .15s ease, border-color .15s ease; }
.backBtn:hover { color:var(--text); border-color:#3a4859; }
.role { color:var(--muted); font-size:.78rem; letter-spacing:.04em; }
.tabs { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
.tab { display:flex; flex-direction:column; align-items:flex-start; gap:4px; padding:12px 12px; border-radius:12px; border:1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); background:color-mix(in srgb, var(--accent) 9%, var(--panel)); color:var(--text); cursor:pointer; transition:border-color .15s ease, background .15s ease, box-shadow .15s ease; }
.tabTop { display:flex; align-items:center; gap:7px; }
.tabDot { width:10px; height:10px; border-radius:50%; background:var(--accent); box-shadow:0 0 8px var(--accent); flex:none; }
.tab .tabName { font-weight:700; color:var(--accent); }
.tab .tabCount { font-size:.78rem; color:var(--muted); padding-left:17px; }
.tab.on { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 24%, var(--panel)); box-shadow:0 0 0 1px var(--accent), 0 8px 22px -10px var(--accent); }

.fields { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.field { position:relative; aspect-ratio:1.2 / 1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:12px; background:color-mix(in srgb, var(--accent) 8%, var(--panel)); border:1px solid color-mix(in srgb, var(--accent) 32%, var(--line)); border-radius:14px; transition:border-color .15s ease, background .15s ease, box-shadow .15s ease; }
.field:focus-within { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 15%, var(--panel)); box-shadow:0 0 0 1px var(--accent), 0 10px 26px -14px var(--accent); }
.fieldNum { font-family:'Space Grotesk'; font-weight:700; line-height:1; color:var(--accent); font-size:clamp(1.3rem,6vw,1.9rem); }
.input { width:100%; text-align:center; padding:8px 6px; font-size:1.05rem; font-family:'Inter'; color:var(--text); background:transparent; border:none; border-bottom:1px solid color-mix(in srgb, var(--accent) 35%, var(--line)); border-radius:0; outline:none; caret-color:var(--accent); transition:border-color .15s ease; }
.input::placeholder { color:color-mix(in srgb, var(--accent) 32%, #566173); }
.input:focus { border-bottom-color:var(--accent); }
.clearOne { position:absolute; top:6px; right:6px; width:26px; height:26px; border-radius:8px; border:none; background:transparent; color:var(--muted); font-size:1.2rem; line-height:1; cursor:pointer; }
.clearOne:hover { color:var(--text); background:rgba(255,255,255,.06); }

/* badge on loaned-away / claimed pods; .field tints itself via its --accent */
/* borrowed pods: parent-arena tint on the outer card, the owning team's
   bordered pod nested inside (gap = the field's own padding) */
.podInner { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; flex:1; width:100%; }
.field.claimed .podInner, .field.loaned .podInner { border:2px solid var(--owner); border-radius:12px; padding:10px 8px; }

/* reconfigure mode */
.reconfigHint { color:var(--muted); font-size:.9rem; line-height:1.5; margin:-4px 0 2px; }
.reconfigHint b { font-weight:700; }
.reconfig { display:flex; flex-direction:column; gap:14px; }
.reconfigArena { display:flex; flex-direction:column; gap:8px; }
.reconfigQuads { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.reconfigPod { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; min-height:74px; padding:10px; border-radius:12px; cursor:pointer; color:var(--text); background:var(--panel); border:1px solid color-mix(in srgb, var(--owner) 30%, var(--line)); box-shadow:inset 0 0 0 2px color-mix(in srgb, var(--owner) 38%, transparent); transition:box-shadow .15s ease, background .15s ease; }
.reconfigPod.mine { background:color-mix(in srgb, var(--owner) 16%, var(--panel)); box-shadow:inset 0 0 0 2px var(--owner), 0 8px 22px -12px var(--owner); }
.reconfigNum { font-family:'Space Grotesk'; font-weight:700; font-size:1.1rem; line-height:1; color:var(--owner); }
.reconfigNm { font-size:.85rem; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
.reconfigPod.mine .reconfigNm { color:var(--text); }
.reconfigTag { position:absolute; top:5px; right:7px; font-size:.6rem; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }

.ctrlFoot { display:flex; flex-direction:column; gap:10px; }
.ghost { padding:12px; border-radius:12px; border:1px solid var(--line); background:transparent; color:var(--muted); cursor:pointer; font-size:.9rem; }
.ghost:hover { color:var(--text); border-color:#3a4859; }
.ghost.small { font-size:.82rem; padding:8px 12px; }
.danger { padding:12px; border-radius:12px; border:1px solid #ff5a5a; background:rgba(255,90,90,.12); color:#ff7a7a; cursor:pointer; font-weight:600; }
.danger.small { padding:8px 14px; font-size:.82rem; }

/* clear-arena confirmation: Keep (cancel) + Clear (confirm), themed to the
   active arena's accent so a mistap is reversible and visually consistent */
.clearConfirm { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 8px 8px 14px; border:1px solid color-mix(in srgb, var(--accent) 45%, var(--line)); border-radius:12px; background:color-mix(in srgb, var(--accent) 10%, var(--panel)); }
.clearConfirmText { font-size:.92rem; font-weight:600; color:var(--accent); }
.clearConfirmBtns { display:flex; gap:8px; flex:none; }
.confirmBtn { min-width:64px; height:44px; padding:0 16px; border-radius:10px; font-size:.92rem; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; transition:color .15s ease, border-color .15s ease, background .15s ease; }
.confirmBtn.keep { border:1px solid var(--line); background:var(--panel); color:var(--muted); }
.confirmBtn.keep:hover { color:var(--text); border-color:#3a4859; }
.confirmBtn.clear { border:1px solid var(--accent); background:color-mix(in srgb, var(--accent) 22%, var(--panel)); color:var(--accent); }
.confirmBtn.clear:hover { background:color-mix(in srgb, var(--accent) 34%, var(--panel)); }

/* arena header (used by the Reconfigure screen) */
.miniHead { display:flex; align-items:center; gap:7px; font-size:.78rem; font-weight:700; color:var(--accent); letter-spacing:.05em; text-transform:uppercase; }
.miniDot { width:9px; height:9px; border-radius:50%; background:var(--accent); box-shadow:0 0 8px var(--accent); flex:none; }

/* display / TV — floorplan */
.disp { max-width:1500px; margin:0 auto; display:flex; flex-direction:column; gap:clamp(16px,2.5vw,28px); }
.dispHead { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; }
.dispBrand { display:flex; flex-direction:column; gap:2px; }
.dispActions { display:flex; align-items:center; gap:10px; }
.iconBtn { width:40px; height:40px; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--muted); font-size:1.1rem; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.iconBtn:hover { color:var(--text); border-color:#3a4859; }

.floor {
  display:grid;
  grid-template-columns:1fr 1fr;
  grid-template-rows:auto auto;
  gap:clamp(16px,3vw,44px);
  justify-items:center;
  align-items:start;
  width:100%;
}
.arena {
  width:min(42vw,470px);
  max-width:100%;
  border-radius:16px;
  overflow:hidden;
  background:var(--panel);
  border:1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
  box-shadow:0 22px 60px -28px color-mix(in srgb, var(--accent) 70%, transparent);
}
.arena.tl { grid-column:1; grid-row:1; }
.arena.tr { grid-column:2; grid-row:1; }
.arena.bc { grid-column:1 / span 2; grid-row:2; }

.arenaHeader {
  background:var(--accent);
  padding:clamp(8px,1vw,14px) 18px;
  display:flex; align-items:center; justify-content:center;
  box-shadow:0 6px 26px -6px var(--accent);
}
.arenaName {
  font-family:'Space Grotesk'; font-weight:700; text-transform:uppercase;
  letter-spacing:.16em; color:#0b0e14;
  font-size:clamp(.8rem,1.25vw,1.1rem);
}
.arenaBody {
  position:relative;
  aspect-ratio:1.25 / 1;
  display:grid;
  grid-template-columns:1fr 1fr;
  grid-template-rows:1fr 1fr;
}
.vline, .hline {
  position:absolute;
  background:color-mix(in srgb, var(--accent) 50%, var(--line));
  box-shadow:0 0 14px -2px var(--accent);
  pointer-events:none;
}
.vline { top:12%; bottom:12%; left:50%; width:2px; transform:translateX(-1px); }
.hline { left:10%; right:10%; top:50%; height:2px; transform:translateY(-1px); }

.quad {
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:.3em; padding:clamp(8px,1.5vw,22px); text-align:center;
  border-radius:12px; min-width:0;
  transition:background .6s ease, box-shadow .6s ease;
}
.quadNum {
  font-family:'Space Grotesk'; font-weight:700; line-height:1;
  font-size:clamp(1.1rem,2vw,2rem);
  color:var(--accent);
}
.quadName {
  font-size:clamp(1.05rem,2.4vw,2.3rem); font-weight:600; line-height:1.1;
  color:var(--text); word-break:break-word; max-width:100%;
}
.quadName .open { color:#46505f; font-size:.58em; font-weight:500; letter-spacing:.05em; }
.quad.flash {
  background:color-mix(in srgb, var(--accent) 20%, transparent);
  box-shadow:inset 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
}
/* a pod claimed by another team: outline only, in the owning team's color */
.quad.claimed {
  box-shadow:inset 0 0 0 3px var(--owner);
  border-radius:14px;
}
.quad.claimed.flash {
  background:color-mix(in srgb, var(--owner) 18%, transparent);
}

/* Stack arenas into a single column on narrow screens AND in portrait
   orientation (e.g. a TV rotated to portrait, or a portrait device),
   so Red and Blue flow vertically instead of crowding side by side. */
@media (max-width: 720px), (orientation: portrait) {
  .floor { grid-template-columns:1fr; grid-template-rows:auto; }
  /* Reset BOTH column and row so all three arenas flow into one column
     (Blue, Red, Green top-to-bottom) instead of Blue/Red sharing row 1. */
  .arena, .arena.tl, .arena.tr, .arena.bc { grid-column:1; grid-row:auto; width:min(92vw,470px); }
}
@media (prefers-reduced-motion: reduce) {
  * { transition:none !important; animation:none !important; }
}
`;
