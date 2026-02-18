import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Tracker ore per progetti (Vite + React base, zero dipendenze esterne)
 * - Mobile-first (cards) + Desktop (tabella)
 * - localStorage
 * - Export CSV (giorno)
 * - PWA: registra service worker (serve ./sw.js e manifest)
 * - Sync multi-dispositivo: opzionale via Supabase REST (tabella kv), last-write-wins
 */

const LS_KEY = "ore_progetti_vite_simple_v1";
const SYNC_KEY = "ore_progetti_sync_vite_simple_v1";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function isoDate(d: Date = new Date()) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function minutesToHhMm(totalMinutes: number) {
  const m = Math.max(0, Math.round(Number(totalMinutes || 0)));
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh}h ${pad2(mm)}m`;
}

function safeJsonParse<T>(s: string | null, fallback: T): T {
  try {
    if (!s) return fallback;
    const v = JSON.parse(s);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function csvEscape(value: unknown) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}



function cryptoRandomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `id_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function formatDateTime(ts: number | null) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

type Project = { id: string; name: string };
type Entry = { minutes: number; note: string };
type Day = { entries: Record<string, Entry> };

type AppState = {
  updatedAt: number; // ms
  projects: Project[];
  days: Record<string, Day>;
};

type SyncConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
  workspaceKey: string;
  autoPush: boolean;
  autoPull: boolean;
  autoPullIntervalSec: number;
};

type SyncStatus = {
  state: "idle" | "pushing" | "pulling" | "ok" | "error";
  message: string;
  lastPushAt: number | null;
  lastPullAt: number | null;
};

const defaultState = (): AppState => ({
  updatedAt: Date.now(),
  projects: [
    { id: cryptoRandomId(), name: "Admin / Email" },
    { id: cryptoRandomId(), name: "Progetto A" },
    { id: cryptoRandomId(), name: "Progetto B" },
  ],
  days: {},
});

const defaultSync = (): SyncConfig => ({
  supabaseUrl: "",
  supabaseAnonKey: "",
  workspaceKey: "",
  autoPush: true,
  autoPull: true,
  autoPullIntervalSec: 20,
});

export default function App() {
  const today = useMemo(() => isoDate(new Date()), []);

  const [state, setState] = useState<AppState>(() => {
    const raw = window.localStorage.getItem(LS_KEY);
    return safeJsonParse<AppState>(raw, defaultState());
  });

  const [selectedDate, setSelectedDate] = useState(today);
  const [newProjectName, setNewProjectName] = useState("");
  const [compact, setCompact] = useState(false);
  const newProjectRef = useRef<HTMLInputElement | null>(null);

  const [sync, setSync] = useState<SyncConfig>(() => {
    const raw = window.localStorage.getItem(SYNC_KEY);
    return safeJsonParse<SyncConfig>(raw, defaultSync());
  });

  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    state: "idle",
    message: "",
    lastPushAt: null,
    lastPullAt: null,
  });

  const pushDebounceRef = useRef<number | null>(null);
  const autoPullTimerRef = useRef<number | null>(null);
  const lastAppliedCloudStampRef = useRef<number>(0);

  // Persist local
  useEffect(() => {
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [state]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SYNC_KEY, JSON.stringify(sync));
    } catch {
      // ignore
    }
  }, [sync]);

  // PWA: register Service Worker
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // IMPORTANT for GitHub Pages: relative path
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* ignore */
    });
  }, []);

  function setStateStamped(updater: (prev: AppState) => AppState) {
    setState((prev) => ({ ...updater(prev), updatedAt: Date.now() }));
  }

  const dayData = useMemo(() => {
    const day = state.days?.[selectedDate] || { entries: {} };
    return { entries: day.entries || {} };
  }, [state.days, selectedDate]);

  const totals = useMemo(() => {
    let totalMinutes = 0;
    const perProject: Record<string, number> = {};
    for (const p of state.projects) {
      const m = Number(dayData.entries?.[p.id]?.minutes || 0);
      perProject[p.id] = m;
      totalMinutes += m;
    }
    return { totalMinutes, perProject };
  }, [state.projects, dayData.entries]);

  function ensureDay(date: string) {
    setStateStamped((s) => {
      if (s.days?.[date]) return s;
      return {
        ...s,
        days: {
          ...s.days,
          [date]: { entries: {} },
        },
      };
    });
  }

  useEffect(() => {
    ensureDay(selectedDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate]);

  function updateEntry(projectId: string, patch: Partial<Entry>) {
    setStateStamped((s) => {
      const prevDay = s.days?.[selectedDate] || { entries: {} };
      const prevEntry: Entry = prevDay.entries?.[projectId] || { minutes: 0, note: "" };
      const nextEntry: Entry = { ...prevEntry, ...patch };
      return {
        ...s,
        days: {
          ...s.days,
          [selectedDate]: {
            ...prevDay,
            entries: {
              ...prevDay.entries,
              [projectId]: nextEntry,
            },
          },
        },
      };
    });
  }

  function bumpMinutes(projectId: string, delta: number) {
    const current = Number(dayData.entries?.[projectId]?.minutes || 0);
    updateEntry(projectId, { minutes: Math.max(0, current + delta) });
  }

  function addProject() {
    const name = newProjectName.trim();
    if (!name) return;
    const id = cryptoRandomId();
    setStateStamped((s) => ({ ...s, projects: [{ id, name }, ...s.projects] }));
    setNewProjectName("");
    setTimeout(() => newProjectRef.current?.focus(), 0);
  }

  function removeProject(projectId: string) {
    setStateStamped((s) => {
      const nextProjects = s.projects.filter((p) => p.id !== projectId);
      const nextDays: Record<string, Day> = { ...s.days };
      for (const d of Object.keys(nextDays)) {
        const dd = nextDays[d];
        if (dd?.entries?.[projectId]) {
          const e = { ...(dd.entries || {}) };
          delete e[projectId];
          nextDays[d] = { ...dd, entries: e };
        }
      }
      return { ...s, projects: nextProjects, days: nextDays };
    });
  }

  function resetDay() {
    setStateStamped((s) => {
      const prevDay = s.days?.[selectedDate] || { entries: {} };
      const nextEntries: Record<string, Entry> = { ...prevDay.entries };
      for (const p of s.projects) {
        if (nextEntries[p.id]) nextEntries[p.id] = { ...nextEntries[p.id], minutes: 0 };
      }
      return {
        ...s,
        days: {
          ...s.days,
          [selectedDate]: { ...prevDay, entries: nextEntries },
        },
      };
    });
  }

  function exportCsv() {
    const header = ["Data", "Progetto", "Minuti", "Ore", "Note"];
    const rows: string[][] = [header];

    for (const p of state.projects) {
      const entry = dayData.entries?.[p.id] || { minutes: 0, note: "" };
      const minutes = Number(entry.minutes || 0);
      const ore = (minutes / 60).toFixed(2);
      rows.push([selectedDate, p.name, String(minutes), ore, entry.note || ""]);
    }

    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ore_progetti_${selectedDate}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ----------------------
  // Cloud Sync via Supabase REST
  // ----------------------

  function isSyncConfigured() {
    return Boolean(sync.supabaseUrl && sync.supabaseAnonKey && sync.workspaceKey);
  }

  async function supabaseUpsert(payload: AppState) {
    const { supabaseUrl, supabaseAnonKey, workspaceKey } = sync;
    const base = supabaseUrl.replace(/\/$/, "");
    const url = `${base}/rest/v1/kv`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify({
        key: workspaceKey,
        value: payload,
        updated_at: new Date(payload.updatedAt || Date.now()).toISOString(),
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Supabase upsert failed (${res.status}): ${txt || res.statusText}`);
    }
  }

  async function supabaseGet(): Promise<AppState | null> {
    const { supabaseUrl, supabaseAnonKey, workspaceKey } = sync;
    const base = supabaseUrl.replace(/\/$/, "");
    const url = `${base}/rest/v1/kv?key=eq.${encodeURIComponent(workspaceKey)}&select=value`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${supabaseAnonKey}`,
      },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Supabase get failed (${res.status}): ${txt || res.statusText}`);
    }

    const rows = (await res.json().catch(() => [])) as Array<{ value?: AppState }>;
    if (!rows?.length) return null;
    return rows[0]?.value || null;
  }

  async function pushToCloud() {
    if (!isSyncConfigured()) {
      setSyncStatus((s) => ({ ...s, state: "error", message: "Config sync incompleta." }));
      return;
    }

    setSyncStatus((s) => ({ ...s, state: "pushing", message: "Invio al cloud…" }));
    try {
      await supabaseUpsert(state);
      lastAppliedCloudStampRef.current = Number(state.updatedAt || Date.now());
      setSyncStatus((s) => ({ ...s, state: "ok", message: "Sincronizzato (push).", lastPushAt: Date.now() }));
    } catch (e: any) {
      setSyncStatus((s) => ({ ...s, state: "error", message: e?.message || "Errore durante il push." }));
    }
  }

  async function pullFromCloud() {
    if (!isSyncConfigured()) {
      setSyncStatus((s) => ({ ...s, state: "error", message: "Config sync incompleta." }));
      return;
    }

    setSyncStatus((s) => ({ ...s, state: "pulling", message: "Lettura dal cloud…" }));
    try {
      const cloud = await supabaseGet();
      if (!cloud) {
        setSyncStatus((s) => ({ ...s, state: "ok", message: "Nessun dato nel cloud per questa workspace.", lastPullAt: Date.now() }));
        return;
      }

      const cloudStamp = Number(cloud.updatedAt || 0);
      const localStamp = Number(state.updatedAt || 0);

      // last-write-wins
      if (cloudStamp > localStamp) {
        setState(cloud);
        lastAppliedCloudStampRef.current = cloudStamp;
        setSyncStatus((s) => ({
          ...s,
          state: "ok",
          message: "Sincronizzato (pull): dati aggiornati dal cloud.",
          lastPullAt: Date.now(),
        }));
      } else {
        setSyncStatus((s) => ({ ...s, state: "ok", message: "Pull ok: locale già aggiornato.", lastPullAt: Date.now() }));
      }
    } catch (e: any) {
      setSyncStatus((s) => ({ ...s, state: "error", message: e?.message || "Errore durante il pull." }));
    }
  }

  // Auto-push (debounced)
  useEffect(() => {
    if (!sync.autoPush) return;
    if (!isSyncConfigured()) return;

    if (pushDebounceRef.current) window.clearTimeout(pushDebounceRef.current);
    pushDebounceRef.current = window.setTimeout(() => {
      const stamp = Number(state.updatedAt || 0);
      if (stamp && stamp === lastAppliedCloudStampRef.current) return;
      pushToCloud();
    }, 900);

    return () => {
      if (pushDebounceRef.current) window.clearTimeout(pushDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, sync.autoPush, sync.supabaseUrl, sync.supabaseAnonKey, sync.workspaceKey]);

  // Auto-pull (poll)
  useEffect(() => {
    if (!sync.autoPull) return;
    if (!isSyncConfigured()) return;

    const intervalMs = Math.max(5, Number(sync.autoPullIntervalSec || 20)) * 1000;
    pullFromCloud();

    if (autoPullTimerRef.current) window.clearInterval(autoPullTimerRef.current);
    autoPullTimerRef.current = window.setInterval(() => {
      pullFromCloud();
    }, intervalMs);

    return () => {
      if (autoPullTimerRef.current) window.clearInterval(autoPullTimerRef.current);
      autoPullTimerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync.autoPull, sync.autoPullIntervalSec, sync.supabaseUrl, sync.supabaseAnonKey, sync.workspaceKey]);

  return (
    <div className="app">
      <style>{styles}</style>

      <header className="topbar">
        <div>
          <div className="title">Tracker ore per progetti</div>
          <div className="subtitle">Vite + React base • local + sync Supabase (opzionale) • last-write-wins</div>
        </div>

        <div className="toolbar">
          <label className="field">
            <span>Data</span>
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          </label>

          <button className="btn" onClick={() => setCompact((v) => !v)}>
            {compact ? "Mostra dettagli" : "Compatta"}
          </button>
          <button className="btn" onClick={exportCsv}>Esporta CSV</button>
          <button className="btn danger" onClick={resetDay}>Reset giorno</button>
        </div>
      </header>

      <main className="grid">
        <section className="card span2">
          <div className="cardHeader">
            <div className="cardTitle">Progetti</div>
            <div className="addRow">
              <input
                ref={newProjectRef}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                placeholder="Aggiungi progetto (es. Cliente X)"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addProject();
                }}
              />
              <button className="btn primary" onClick={addProject}>Aggiungi</button>
            </div>
          </div>

          {/* Desktop table */}
          <div className="desktopOnly">
            <div className="tableWrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Progetto</th>
                    <th className="right">Minuti</th>
                    <th>Azioni rapide</th>
                    <th>Totale</th>
                    <th className="right"> </th>
                  </tr>
                </thead>
                <tbody>
                  {state.projects.map((p) => {
                    const entry = dayData.entries?.[p.id] || { minutes: 0, note: "" };
                    const minutes = Number(entry.minutes || 0);
                    return (
                      <tr key={p.id}>
                        <td>
                          <div className="projName">{p.name}</div>
                          {!compact && (
                            <input
                              value={entry.note || ""}
                              onChange={(e) => updateEntry(p.id, { note: e.target.value })}
                              placeholder="Note (opzionale)"
                            />
                          )}
                        </td>
                        <td className="right">
                          <input
                            inputMode="numeric"
                            value={String(minutes)}
                            onChange={(e) => {
                              const v = e.target.value.replace(/[^0-9]/g, "");
                              updateEntry(p.id, { minutes: v === "" ? 0 : Number(v) });
                            }}
                            className="num"
                          />
                          {!compact && <div className="muted small">{(minutes / 60).toFixed(2)} ore</div>}
                        </td>
                        <td>
                          <div className="quick">
                            <button className="chip" onClick={() => bumpMinutes(p.id, 15)}>+15m</button>
                            <button className="chip" onClick={() => bumpMinutes(p.id, 30)}>+30m</button>
                            <button className="chip" onClick={() => bumpMinutes(p.id, 60)}>+1h</button>
                            <button className="chip" onClick={() => bumpMinutes(p.id, -15)}>-15m</button>
                          </div>
                        </td>
                        <td>
                          <span className="badge">{minutesToHhMm(minutes)}</span>
                          {!compact && entry.note ? <div className="muted small clamp2">{entry.note}</div> : null}
                        </td>
                        <td className="right">
                          <button className="btn ghost" onClick={() => removeProject(p.id)} aria-label={`Elimina ${p.name}`}>
                            Elimina
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="mobileOnly">
            <div className="cards">
              {state.projects.map((p) => {
                const entry = dayData.entries?.[p.id] || { minutes: 0, note: "" };
                const minutes = Number(entry.minutes || 0);
                return (
                  <div className="rowCard" key={p.id}>
                    <div className="rowTop">
                      <div className="projName">{p.name}</div>
                      <button className="btn ghost" onClick={() => removeProject(p.id)}>Elimina</button>
                    </div>

                    <div className="rowMid">
                      <span className="badge">{minutesToHhMm(minutes)}</span>
                      <span className="muted small">{(minutes / 60).toFixed(2)} ore</span>
                    </div>

                    <div className="rowInputs">
                      <input
                        inputMode="numeric"
                        value={String(minutes)}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^0-9]/g, "");
                          updateEntry(p.id, { minutes: v === "" ? 0 : Number(v) });
                        }}
                        className="num big"
                      />

                      {!compact && (
                        <input
                          value={entry.note || ""}
                          onChange={(e) => updateEntry(p.id, { note: e.target.value })}
                          placeholder="Note (opzionale)"
                        />
                      )}

                      <div className="quickGrid">
                        <button className="chip big" onClick={() => bumpMinutes(p.id, 15)}>+15</button>
                        <button className="chip big" onClick={() => bumpMinutes(p.id, 30)}>+30</button>
                        <button className="chip big" onClick={() => bumpMinutes(p.id, 60)}>+1h</button>
                        <button className="chip big" onClick={() => bumpMinutes(p.id, -15)}>-15</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="footerRow">
            <div className="muted">Suggerimento: usa +15m/+30m/+1h mentre lavori.</div>
            <div className="badge outline">Totale giorno: {minutesToHhMm(totals.totalMinutes)}</div>
          </div>
        </section>

        <aside className="card">
          <div className="cardHeader">
            <div className="cardTitle">Riepilogo</div>
          </div>

          <div className="kv">
            <div className="kvRow"><span className="muted">Data</span><span>{selectedDate}</span></div>
            <div className="kvRow"><span className="muted">Totale</span><span>{minutesToHhMm(totals.totalMinutes)}</span></div>
          </div>

          <hr className="sep" />

          <div className="sectionTitle">Distribuzione</div>
          <div className="dist">
            {state.projects.map((p) => {
              const m = totals.perProject[p.id] || 0;
              const pct = totals.totalMinutes > 0 ? (m / totals.totalMinutes) * 100 : 0;
              return (
                <div key={p.id} className="distRow">
                  <div className="distTop">
                    <span className="truncate">{p.name}</span>
                    <span className="mono">{minutesToHhMm(m)}</span>
                  </div>
                  <div className="bar"><div className="barFill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
                </div>
              );
            })}
          </div>

          <hr className="sep" />

          <div className="sectionTitle">Sync iPhone ↔ iMac (Supabase)</div>
          <div className="muted small">Opzionale. Se non configuri nulla, funziona solo in locale.</div>

          <div className="sync">
            <input
              value={sync.supabaseUrl}
              onChange={(e) => setSync((v) => ({ ...v, supabaseUrl: e.target.value }))}
              placeholder="Supabase URL (https://xxxx.supabase.co)"
            />
            <input
              value={sync.supabaseAnonKey}
              onChange={(e) => setSync((v) => ({ ...v, supabaseAnonKey: e.target.value }))}
              placeholder="Supabase anon key"
            />
            <input
              value={sync.workspaceKey}
              onChange={(e) => setSync((v) => ({ ...v, workspaceKey: e.target.value }))}
              placeholder="Workspace key (uguale su tutti i dispositivi)"
            />

            <div className="syncButtons">
              <button className="btn" onClick={pullFromCloud} disabled={!isSyncConfigured() || syncStatus.state === "pulling"}>
                Pull
              </button>
              <button className="btn" onClick={pushToCloud} disabled={!isSyncConfigured() || syncStatus.state === "pushing"}>
                Push
              </button>
              <button className={sync.autoPush ? "btn primary" : "btn"} onClick={() => setSync((v) => ({ ...v, autoPush: !v.autoPush }))}>
                Auto-push: {sync.autoPush ? "ON" : "OFF"}
              </button>
              <button className={sync.autoPull ? "btn primary" : "btn"} onClick={() => setSync((v) => ({ ...v, autoPull: !v.autoPull }))}>
                Auto-pull: {sync.autoPull ? "ON" : "OFF"}
              </button>
            </div>

            <label className="field">
              <span>Auto-pull (sec)</span>
              <input
                inputMode="numeric"
                value={String(sync.autoPullIntervalSec)}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9]/g, "");
                  setSync((s) => ({ ...s, autoPullIntervalSec: v === "" ? 20 : Number(v) }));
                }}
              />
            </label>

            <div className={syncStatus.state === "error" ? "status error" : "status"}>
              {syncStatus.message || (isSyncConfigured() ? "Pronto." : "Inserisci i parametri Supabase e una workspaceKey condivisa.")}
            </div>

            <div className="muted small">
              Last push: {formatDateTime(syncStatus.lastPushAt)}
              <br />
              Last pull: {formatDateTime(syncStatus.lastPullAt)}
              <br />
              UpdatedAt locale: {formatDateTime(state.updatedAt)}
            </div>

            <div className="muted small">
              Conflitti: <b>last-write-wins</b> (vince lo stato con <b>updatedAt</b> più recente).
            </div>
          </div>

          <hr className="sep" />

          <div className="muted small">
            PWA: su iPhone apri il link HTTPS in Safari → Condividi → Aggiungi alla schermata Home.
          </div>
        </aside>
      </main>
    </div>
  );
}

const styles = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }

  .app { padding: 16px; max-width: 1200px; margin: 0 auto; }
  .topbar { display: flex; gap: 12px; align-items: flex-end; justify-content: space-between; flex-wrap: wrap; margin-bottom: 12px; }
  .title { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .subtitle { font-size: 12px; color: #6b7280; margin-top: 4px; }

  .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

  .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
  @media (min-width: 980px) { .grid { grid-template-columns: 2fr 1fr; } .span2 { grid-column: 1 / 2; } }

  .card { border: 1px solid #e5e7eb; border-radius: 14px; padding: 12px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .cardHeader { display: flex; justify-content: space-between; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .cardTitle { font-weight: 700; }

  input { width: 100%; padding: 10px 10px; border: 1px solid #e5e7eb; border-radius: 10px; outline: none; }
  input:focus { border-color: #9ca3af; }

  .field { display: grid; gap: 6px; }
  .field > span { font-size: 12px; color: #6b7280; }

  .btn { padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fff; cursor: pointer; }
  .btn:hover { border-color: #d1d5db; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: #111827; color: #fff; border-color: #111827; }
  .btn.danger { background: #991b1b; color: #fff; border-color: #991b1b; }
  .btn.ghost { background: transparent; border-color: transparent; color: #374151; }

  .chip { padding: 8px 10px; border-radius: 999px; border: 1px solid #e5e7eb; background: #fff; cursor: pointer; }
  .chip:hover { border-color: #d1d5db; }
  .chip.big { padding: 12px 10px; }

  .badge { display: inline-block; padding: 6px 10px; border-radius: 999px; background: #f3f4f6; border: 1px solid #e5e7eb; font-size: 12px; }
  .badge.outline { background: #fff; }

  .muted { color: #6b7280; }
  .small { font-size: 12px; }
  .mono { font-variant-numeric: tabular-nums; }
  .right { text-align: right; }
  .truncate { display: inline-block; max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
  .clamp2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

  .addRow { display: flex; gap: 8px; align-items: center; width: 100%; max-width: 520px; }
  .addRow input { flex: 1; }

  .footerRow { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }

  .desktopOnly { display: none; }
  .mobileOnly { display: block; }
  @media (min-width: 768px) { .desktopOnly { display: block; } .mobileOnly { display: none; } }

  .tableWrap { overflow: auto; border: 1px solid #e5e7eb; border-radius: 12px; }
  .table { width: 100%; border-collapse: collapse; min-width: 840px; }
  .table th, .table td { padding: 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  .table th { text-align: left; font-size: 12px; color: #6b7280; background: #fafafa; }
  .table tr:last-child td { border-bottom: none; }

  .projName { font-weight: 600; margin-bottom: 6px; }
  .num { width: 120px; text-align: right; }
  .num.big { width: 100%; height: 48px; font-size: 16px; text-align: right; }

  .quick { display: flex; gap: 8px; flex-wrap: wrap; }
  .quickGrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }

  .cards { display: grid; gap: 10px; }
  .rowCard { border: 1px solid #e5e7eb; border-radius: 14px; padding: 12px; }
  .rowTop { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .rowMid { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 10px; }
  .rowInputs { display: grid; gap: 8px; margin-top: 10px; }

  .sep { border: none; border-top: 1px solid #e5e7eb; margin: 12px 0; }
  .sectionTitle { font-weight: 700; margin-bottom: 8px; }

  .kv { display: grid; gap: 8px; }
  .kvRow { display: flex; justify-content: space-between; gap: 8px; }

  .dist { display: grid; gap: 10px; }
  .distRow { display: grid; gap: 6px; }
  .distTop { display: flex; justify-content: space-between; gap: 10px; }
  .bar { height: 8px; background: #f3f4f6; border-radius: 999px; overflow: hidden; }
  .barFill { height: 8px; background: #111827; }

  .sync { display: grid; gap: 8px; }
  .syncButtons { display: flex; gap: 8px; flex-wrap: wrap; }
  .status { font-size: 12px; color: #6b7280; }
  .status.error { color: #991b1b; }
`;

// ----------------------
// Basic self-tests (dev only)
// ----------------------
(function runBasicTestsOnce() {
  if (typeof window === "undefined") return;
  // @ts-expect-error dev flag
  if (window.__ORE_TRACKER_TESTS_RAN__) return;
  // @ts-expect-error dev flag
  window.__ORE_TRACKER_TESTS_RAN__ = true;

  try {
    console.assert(pad2(1) === "01", "pad2 failed");
    console.assert(minutesToHhMm(0) === "0h 00m", "minutesToHhMm(0) failed");
    console.assert(minutesToHhMm(61) === "1h 01m", "minutesToHhMm(61) failed");
    console.assert(csvEscape('a"b').includes('""'), "csvEscape quote failed");
    const id = cryptoRandomId();
    console.assert(typeof id === "string" && id.length > 5, "cryptoRandomId failed");
  } catch {
    // ignore
  }
})();
