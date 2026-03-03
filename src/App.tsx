import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Tracker ore per progetti (Vite + React)
 *
 * Modalità cronometro (per collaboratore):
 * - Premi un progetto => avvia il timer di quel progetto (Lavoro)
 * - Premi un altro progetto => ferma e salva il precedente, poi avvia il nuovo
 * - Premi STOP => ferma e salva il progetto attivo
 *
 * Trasferta (NUOVO):
 * - NON c'è più timer trasferta
 * - "Trasferta" è un memo/flag per progetto (toggle) visibile nei resoconti + export
 *
 * Persistenza + Sync:
 * - localStorage
 * - Sync multi-dispositivo opzionale via Supabase REST (tabella kv), last-write-wins (per-workspace)
 */

const LS_KEY = "ore_progetti_vite_multi_v5_no_travel_timer";
const SYNC_KEY = "ore_progetti_sync_vite_simple_v2";

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function isoDate(d: Date = new Date()) {
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return `${y}-${m}-${day}`;
}

function startOfWeekISO(dateISO: string) {
  // Monday as first day
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  const dow = dt.getDay(); // 0..6 (Sun..Sat)
  const diff = dow === 0 ? -6 : 1 - dow; // move to Monday
  dt.setDate(dt.getDate() + diff);
  return isoDate(dt);
}

function startOfMonthISO(dateISO: string) {
  const [y, m] = dateISO.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, 1);
  return isoDate(dt);
}

function startOfYearISO(dateISO: string) {
  const [y] = dateISO.split("-").map(Number);
  return `${y}-01-01`;
}

function endOfYearISO(dateISO: string) {
  const [y] = dateISO.split("-").map(Number);
  return `${y}-12-31`;
}

function addDaysISO(dateISO: string, deltaDays: number) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + deltaDays);
  return isoDate(dt);
}

function msToHhMm(totalMs: number) {
  const ms = Math.max(0, Math.round(Number(totalMs || 0)));
  const totalMinutes = Math.floor(ms / 60000);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${hh}h ${pad2(mm)}m`;
}

function msToMinutesInt(totalMs: number) {
  const ms = Math.max(0, Math.round(Number(totalMs || 0)));
  return Math.floor(ms / 60000);
}

function minutesIntToMs(minutes: number) {
  const m = Math.max(0, Math.floor(Number(minutes || 0)));
  return m * 60000;
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
  if (/["\n\r,]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
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

function clampNonNeg(n: number) {
  return Math.max(0, Number.isFinite(n) ? n : 0);
}

function elapsedMs(startedAt: number | null, now: number) {
  if (!startedAt) return 0;
  return clampNonNeg(now - startedAt);
}

function applyElapsed(entryMs: number, startedAt: number | null, now: number) {
  return clampNonNeg(entryMs) + elapsedMs(startedAt, now);
}

function digitsOnly(input: string) {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c >= 48 && c <= 57) out += input[i];
  }
  return out;
}

function trimTrailingSlash(url: string) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Base URL robusto:
 * - In Vite: import.meta.env.BASE_URL (es. "/tracker-ore/")
 * - In altri ambienti/sandbox: fallback a "/" oppure a pathname della pagina.
 */
function normalizeBaseUrl(base: string) {
  let b = String(base || "/");
  if (!b.startsWith("/")) b = `/${b}`;
  if (!b.endsWith("/")) b = `${b}/`;
  return b;
}

function getRuntimeBaseUrl() {
  const viteBase = (import.meta as any)?.env?.BASE_URL as string | undefined;
  if (viteBase) return normalizeBaseUrl(viteBase);

  try {
    const p = window.location.pathname || "/";
    const dir = p.endsWith("/") ? p : p.slice(0, p.lastIndexOf("/") + 1);
    return normalizeBaseUrl(dir);
  } catch {
    return "/";
  }
}

type Project = { id: string; name: string };

// ✅ Entry senza travelMs: trasferta è un flag/memo
type Entry = { workMs: number; note: string; travel: boolean };

type Day = { entries: Record<string, Entry> };

type ActiveTimer = { projectId: string | null; startedAt: number | null };

type User = { id: string; name: string };

type UserState = { days: Record<string, Day>; active: ActiveTimer };

type AppState = {
  updatedAt: number;
  users: User[];
  currentUserId: string;
  projectsByUser: Record<string, Project[]>;
  perUser: Record<string, UserState>;
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

type ViewMode = "day" | "week" | "month" | "year";
type ScopeMode = "me" | "all";
type TeamMode = "sum" | "compare";
type LayoutMode = "pdf" | "dettagli";

const defaultState = (): AppState => {
  const me: User = { id: cryptoRandomId(), name: "Utente 1" };
  const myProjects: Project[] = [
    { id: cryptoRandomId(), name: "Progetto A" },
    { id: cryptoRandomId(), name: "Progetto B" },
    { id: cryptoRandomId(), name: "Progetto C" },
    { id: cryptoRandomId(), name: "Progetto D" },
    { id: cryptoRandomId(), name: "Progetto E" },
  ];
  return {
    updatedAt: Date.now(),
    users: [me],
    currentUserId: me.id,
    projectsByUser: { [me.id]: myProjects },
    perUser: {
      [me.id]: {
        days: {},
        active: { projectId: null, startedAt: null },
      },
    },
  };
};

const defaultSync = (): SyncConfig => ({
  supabaseUrl: "",
  supabaseAnonKey: "",
  workspaceKey: "",
  autoPush: true,
  autoPull: true,
  autoPullIntervalSec: 20,
});

function ensureUserState(s: AppState, userId: string): AppState {
  const perUser = s.perUser || {};
  const projectsByUser = s.projectsByUser || {};
  return {
    ...s,
    perUser: {
      ...perUser,
      [userId]: perUser[userId] || ({ days: {}, active: { projectId: null, startedAt: null } } as UserState),
    },
    projectsByUser: {
      ...projectsByUser,
      [userId]: projectsByUser[userId] || [],
    },
  };
}

function migrateState(raw: any): AppState {
  // v5 (this file)
  if (raw && typeof raw === "object" && Array.isArray(raw.users) && raw.perUser && raw.projectsByUser) {
    const s: AppState = {
      updatedAt: Number(raw.updatedAt || Date.now()),
      users: raw.users,
      currentUserId: String(raw.currentUserId || raw.users?.[0]?.id || ""),
      projectsByUser: typeof raw.projectsByUser === "object" && raw.projectsByUser ? raw.projectsByUser : {},
      perUser: typeof raw.perUser === "object" && raw.perUser ? raw.perUser : {},
    };

    if (!s.users.length) return defaultState();
    if (!s.currentUserId || !s.users.some((u) => u.id === s.currentUserId)) s.currentUserId = s.users[0].id;

    const nextPerUser: Record<string, UserState> = {};
    const nextProjectsByUser: Record<string, Project[]> = { ...s.projectsByUser };

    for (const u of s.users) {
      if (!Array.isArray(nextProjectsByUser[u.id])) nextProjectsByUser[u.id] = [];

      const userProjects = nextProjectsByUser[u.id] as Project[];
      nextProjectsByUser[u.id] = userProjects
        .filter((p) => p && typeof p === "object")
        .map((p) => ({ id: String((p as any).id || cryptoRandomId()), name: String((p as any).name || "") }))
        .filter((p) => p.name.trim().length > 0);

      const us = s.perUser[u.id] || ({ days: {}, active: { projectId: null, startedAt: null } } as UserState);
      const days = us.days && typeof us.days === "object" ? us.days : {};
      const nextDays: Record<string, Day> = {};

      for (const [date, day] of Object.entries(days)) {
        const entries: Record<string, Entry> = {};
        const e = (day as any)?.entries || {};
        for (const [pid, entry] of Object.entries(e)) {
          const ent: any = entry || {};

          // ✅ MIGRAZIONE: supporta legacy:
          // - v4: workMs / travelMs / note
          // - v1: ms / minutes
          // Strategia: lavoro = workMs + travelMs (così non perdi ore), travel flag se travelMs > 0 o ent.travel true
          const legacyWorkMs =
            typeof ent.workMs === "number"
              ? ent.workMs
              : typeof ent.ms === "number"
                ? ent.ms
                : minutesIntToMs(ent.minutes || 0);

          const legacyTravelMs = typeof ent.travelMs === "number" ? ent.travelMs : 0;
          const legacyTravelFlag = Boolean(ent.travel) || legacyTravelMs > 0;

          entries[String(pid)] = {
            workMs: clampNonNeg(legacyWorkMs + legacyTravelMs),
            note: String(ent.note || ""),
            travel: legacyTravelFlag,
          };
        }
        nextDays[String(date)] = { entries };
      }

      let active: ActiveTimer = {
        projectId: us.active?.projectId ?? null,
        startedAt: us.active?.startedAt ?? null,
      };

      if (active.projectId && !nextProjectsByUser[u.id].some((p) => p.id === active.projectId)) {
        active = { projectId: null, startedAt: null };
      }
      if (active.projectId && !active.startedAt) active = { projectId: null, startedAt: null };

      nextPerUser[u.id] = { days: nextDays, active };
    }

    const first = s.users[0];
    if (!nextProjectsByUser[first.id] || nextProjectsByUser[first.id].length === 0) {
      const base = defaultState();
      nextProjectsByUser[first.id] = base.projectsByUser[base.users[0].id];
    }

    return { ...s, projectsByUser: nextProjectsByUser, perUser: nextPerUser };
  }

  // Legacy v1 single-user
  if (raw && typeof raw === "object" && raw.active && raw.days && Array.isArray(raw.projects)) {
    const base = defaultState();
    const me = base.users[0];
    return migrateState({
      updatedAt: raw.updatedAt,
      users: [me],
      currentUserId: me.id,
      projectsByUser: { [me.id]: raw.projects as Project[] },
      perUser: { [me.id]: { days: raw.days, active: raw.active } },
    });
  }

  return defaultState();
}

function rangeDatesISO(startISO: string, endISO: string) {
  const out: string[] = [];
  let cur = startISO;
  for (let i = 0; i < 800; i++) {
    out.push(cur);
    if (cur === endISO) break;
    cur = addDaysISO(cur, 1);
  }
  return out;
}

function StopWatchIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="54" height="54" viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M26 6h12v6H26V6zm6 10c-13.3 0-24 10.7-24 24s10.7 24 24 24 24-10.7 24-24S45.3 16 32 16zm0 6c10 0 18 8 18 18s-8 18-18 18-18-8-18-18 8-18 18-18zm-2 4h4v16h-4V26z"
        fill={filled ? "var(--accent)" : "var(--accent)"}
      />
    </svg>
  );
}

function FlagStopIcon() {
  return (
    <svg width="54" height="54" viewBox="0 0 64 64" aria-hidden="true">
      <path
        d="M14 6h4v52h-4V6zm6 4c10 0 14-4 24-4 8 0 12 2 12 2v28s-4-2-12-2c-10 0-14 4-24 4-4 0-6-1-6-1V11s2-1 6-1z"
        fill="var(--accent)"
      />
    </svg>
  );
}

export default function App() {
  const today = useMemo(() => isoDate(new Date()), []);

  const [state, setState] = useState<AppState>(() => {
    const raw = window.localStorage.getItem(LS_KEY);
    const parsed = safeJsonParse<any>(raw, null);
    return migrateState(parsed);
  });

  const [selectedDate, setSelectedDate] = useState(today);
  const [newProjectName, setNewProjectName] = useState("");
  const [compact, setCompact] = useState(false);
  const [view, setView] = useState<ViewMode>("day");
  const [scope, setScope] = useState<ScopeMode>("me");
  const [teamMode, setTeamMode] = useState<TeamMode>("compare");
  const [layout, setLayout] = useState<LayoutMode>("pdf");

  const [newUserName, setNewUserName] = useState("");
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

  const [nowTick, setNowTick] = useState(() => Date.now());

  const pushDebounceRef = useRef<number | null>(null);
  const autoPullTimerRef = useRef<number | null>(null);
  const lastAppliedCloudStampRef = useRef<number>(0);

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

  // PWA: registra Service Worker (robusto per GitHub Pages / base path)
  useEffect(() => {
  const base = getRuntimeBaseUrl();

  try {
    const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (manifestLink) {
      const wanted = `${base}manifest.webmanifest`;
      if (manifestLink.getAttribute("href") !== wanted) {
        manifestLink.setAttribute("href", wanted);
      }
    }
  } catch {
    // ignore
  }

  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => reg.unregister());
  }).catch(() => {
    // ignore
  });
}, []);

  function setStateStamped(updater: (prev: AppState) => AppState) {
    setState((prev) => ({ ...updater(prev), updatedAt: Date.now() }));
  }

  const currentUser = useMemo(
    () => state.users.find((x) => x.id === state.currentUserId) || state.users[0],
    [state.currentUserId, state.users],
  );

  const currentProjects = useMemo<Project[]>(
    () => state.projectsByUser?.[currentUser.id] || [],
    [state.projectsByUser, currentUser.id],
  );

  const activeForCurrentUser = useMemo<ActiveTimer>(
    () => state.perUser?.[currentUser.id]?.active || { projectId: null, startedAt: null },
    [state.perUser, currentUser.id],
  );

  useEffect(() => {
    if (!activeForCurrentUser.projectId || !activeForCurrentUser.startedAt) return;
    const t = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [activeForCurrentUser.projectId, activeForCurrentUser.startedAt]);

  function ensureDay(date: string, userId: string) {
    setStateStamped((s0) => {
      const s = ensureUserState(s0, userId);
      const us = s.perUser[userId];
      if (us?.days?.[date]) return s;
      return {
        ...s,
        perUser: {
          ...s.perUser,
          [userId]: {
            ...us,
            days: {
              ...(us?.days || {}),
              [date]: { entries: {} },
            },
          },
        },
      };
    });
  }

  useEffect(() => {
    ensureDay(selectedDate, currentUser.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDate, currentUser.id]);

  function getEntry(userId: string, dateISO: string, projectId: string): Entry {
    const us = state.perUser?.[userId];
    const day = us?.days?.[dateISO];
    return day?.entries?.[projectId] || { workMs: 0, note: "", travel: false };
  }

  function getDisplayWork(userId: string, dateISO: string, projectId: string) {
    const entry = getEntry(userId, dateISO, projectId);
    const active = state.perUser?.[userId]?.active;

    let workMs = clampNonNeg(entry.workMs);

    if (active?.projectId === projectId && active.startedAt) {
      workMs = clampNonNeg(workMs + elapsedMs(active.startedAt, nowTick));
    }

    return { workMs };
  }

  function getDateRangeForView(): { startISO: string; endISO: string; label: string } {
    if (view === "day") return { startISO: selectedDate, endISO: selectedDate, label: selectedDate };
    if (view === "week") {
      const start = startOfWeekISO(selectedDate);
      const end = addDaysISO(start, 6);
      return { startISO: start, endISO: end, label: `Settimana ${start} → ${end}` };
    }
    if (view === "month") {
      const start = startOfMonthISO(selectedDate);
      const [y, m] = start.split("-").map(Number);
      const endDt = new Date(y, m, 0);
      const end = isoDate(endDt);
      return { startISO: start, endISO: end, label: `Mese ${start.slice(0, 7)}` };
    }
    const start = startOfYearISO(selectedDate);
    const end = endOfYearISO(selectedDate);
    return { startISO: start, endISO: end, label: `Anno ${start.slice(0, 4)}` };
  }

  const viewRange = useMemo(() => getDateRangeForView(), [selectedDate, view]);

  const projectNameUniverse = useMemo(() => {
    const names = new Set<string>();
    for (const u of state.users) {
      const ps = state.projectsByUser?.[u.id] || [];
      for (const p of ps) names.add(p.name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [state.users, state.projectsByUser]);

  const totalsMe = useMemo(() => {
    const dates = rangeDatesISO(viewRange.startISO, viewRange.endISO);
    let totalWorkMs = 0;

    const perProject: Record<string, { workMs: number }> = {};
    const perProjectTravelFlag: Record<string, boolean> = {};

    for (const p of currentProjects) {
      let w = 0;
      let anyTravel = false;

      for (const d of dates) {
        const b = getDisplayWork(currentUser.id, d, p.id);
        w += b.workMs;

        const e = getEntry(currentUser.id, d, p.id);
        if (e.travel) anyTravel = true;
      }

      perProject[p.id] = { workMs: w };
      perProjectTravelFlag[p.id] = anyTravel;
      totalWorkMs += w;
    }

    return { totalWorkMs, perProject, perProjectTravelFlag, dates };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjects, state.perUser, currentUser.id, viewRange.startISO, viewRange.endISO, nowTick]);

  const totalsTeam = useMemo(() => {
    const dates = rangeDatesISO(viewRange.startISO, viewRange.endISO);
    const userIds = state.users.map((u) => u.id);

    const matrix: Record<string, Record<string, { workMs: number; anyTravel: boolean }>> = {};
    let grandWorkMs = 0;

    for (const pname of projectNameUniverse) {
      matrix[pname] = {};
      for (const uid of userIds) {
        const ps = state.projectsByUser?.[uid] || [];
        const proj = ps.find((p) => p.name === pname);

        let w = 0;
        let anyTravel = false;

        if (proj) {
          for (const d of dates) {
            const b = getDisplayWork(uid, d, proj.id);
            w += b.workMs;

            const e = getEntry(uid, d, proj.id);
            if (e.travel) anyTravel = true;
          }
        }

        matrix[pname][uid] = { workMs: w, anyTravel };
        grandWorkMs += w;
      }
    }

    const perUserTotal: Record<string, { workMs: number }> = {};
    for (const uid of userIds) {
      let w = 0;
      for (const pname of projectNameUniverse) {
        w += matrix[pname][uid]?.workMs || 0;
      }
      perUserTotal[uid] = { workMs: w };
    }

    return { dates, matrix, grandWorkMs, perUserTotal };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.users, state.projectsByUser, state.perUser, projectNameUniverse, viewRange.startISO, viewRange.endISO, nowTick]);

  function updateEntry(userId: string, dateISO: string, projectId: string, patch: Partial<Entry>) {
    setStateStamped((s0) => {
      const s = ensureUserState(s0, userId);
      const us = s.perUser[userId];
      const prevDay = us.days?.[dateISO] || { entries: {} };
      const prevEntry: Entry = (prevDay.entries?.[projectId] as Entry) || { workMs: 0, note: "", travel: false };

      const nextEntry: Entry = {
        workMs: patch.workMs !== undefined ? clampNonNeg(patch.workMs) : clampNonNeg(prevEntry.workMs),
        note: patch.note !== undefined ? String(patch.note) : String(prevEntry.note || ""),
        travel: patch.travel !== undefined ? Boolean(patch.travel) : Boolean(prevEntry.travel),
      };

      return {
        ...s,
        perUser: {
          ...s.perUser,
          [userId]: {
            ...us,
            days: {
              ...us.days,
              [dateISO]: {
                ...prevDay,
                entries: {
                  ...prevDay.entries,
                  [projectId]: nextEntry,
                },
              },
            },
          },
        },
      };
    });
  }

  function bumpMs(userId: string, dateISO: string, projectId: string, deltaMs: number) {
    setStateStamped((s0) => {
      let s = ensureUserState(s0, userId);
      const us = s.perUser[userId];
      const prevDay = us.days?.[dateISO] || { entries: {} };
      const prevEntry: Entry = (prevDay.entries?.[projectId] as Entry) || { workMs: 0, note: "", travel: false };

      let nextWorkMs = clampNonNeg(prevEntry.workMs);

      // Se sto modificando il progetto attivo, materializzo l'elapsed prima (coerenza)
      let active = us.active;
      if (active.projectId === projectId && active.startedAt) {
        const add = elapsedMs(active.startedAt, Date.now());
        nextWorkMs = clampNonNeg(nextWorkMs + add);
        active = { projectId, startedAt: Date.now() };
      }

      nextWorkMs = clampNonNeg(nextWorkMs + deltaMs);

      return {
        ...s,
        perUser: {
          ...s.perUser,
          [userId]: {
            ...us,
            active,
            days: {
              ...us.days,
              [dateISO]: {
                ...prevDay,
                entries: {
                  ...prevDay.entries,
                  [projectId]: { ...prevEntry, workMs: nextWorkMs },
                },
              },
            },
          },
        },
      };
    });
  }

  function toggleTrasfertaMemo(userId: string, dateISO: string, projectId: string) {
    const cur = getEntry(userId, dateISO, projectId);
    updateEntry(userId, dateISO, projectId, { travel: !cur.travel });
  }

  function addProject() {
    const name = newProjectName.trim();
    if (!name) return;
    const id = cryptoRandomId();

    setStateStamped((s0) => {
      const s = ensureUserState(s0, currentUser.id);
      const cur = s.projectsByUser[currentUser.id] || [];
      return {
        ...s,
        projectsByUser: {
          ...s.projectsByUser,
          [currentUser.id]: [{ id, name }, ...cur],
        },
      };
    });

    setNewProjectName("");
    setTimeout(() => newProjectRef.current?.focus(), 0);
  }

  function removeProject(projectId: string) {
    setStateStamped((s0) => {
      const s = ensureUserState(s0, currentUser.id);
      const nextProjects = (s.projectsByUser[currentUser.id] || []).filter((p) => p.id !== projectId);

      const us = s.perUser[currentUser.id];
      const nextDays: Record<string, Day> = { ...(us?.days || {}) };
      for (const date of Object.keys(nextDays)) {
        const dd = nextDays[date];
        if (dd?.entries?.[projectId]) {
          const e = { ...(dd.entries || {}) };
          delete e[projectId];
          nextDays[date] = { ...dd, entries: e };
        }
      }

      const nextActive = us.active?.projectId === projectId ? { projectId: null, startedAt: null } : us.active;

      return {
        ...s,
        projectsByUser: { ...s.projectsByUser, [currentUser.id]: nextProjects },
        perUser: {
          ...s.perUser,
          [currentUser.id]: { ...us, days: nextDays, active: nextActive },
        },
      };
    });
  }

  function resetDay() {
    setStateStamped((s0) => {
      const s = ensureUserState(s0, currentUser.id);
      const uid = currentUser.id;
      const us = s.perUser[uid];
      const prevDay = us.days?.[selectedDate] || { entries: {} };
      const nextEntries: Record<string, Entry> = { ...prevDay.entries };

      for (const p of s.projectsByUser[uid] || []) {
        if (nextEntries[p.id]) nextEntries[p.id] = { ...nextEntries[p.id], workMs: 0 };
      }

      return {
        ...s,
        perUser: {
          ...s.perUser,
          [uid]: {
            ...us,
            days: {
              ...us.days,
              [selectedDate]: { ...prevDay, entries: nextEntries },
            },
          },
        },
      };
    });
  }

  function materializeActiveIfNeeded(s: AppState, userId: string, dateISO: string, now: number): AppState {
    const us = s.perUser?.[userId];
    if (!us) return s;

    const { projectId, startedAt } = us.active;
    if (!projectId || !startedAt) return s;

    const prevDay = us.days?.[dateISO] || { entries: {} };
    const prevEntry: Entry = (prevDay.entries?.[projectId] as Entry) || { workMs: 0, note: "", travel: false };

    const nextWorkMs = applyElapsed(prevEntry.workMs, startedAt, now);

    return {
      ...s,
      perUser: {
        ...s.perUser,
        [userId]: {
          ...us,
          active: { projectId: null, startedAt: null },
          days: {
            ...us.days,
            [dateISO]: {
              ...prevDay,
              entries: {
                ...prevDay.entries,
                [projectId]: { ...prevEntry, workMs: nextWorkMs },
              },
            },
          },
        },
      },
    };
  }

  function startProject(projectId: string) {
    const now = Date.now();
    setStateStamped((s0) => {
      let s = ensureUserState(s0, currentUser.id);
      const uid = currentUser.id;
      const us = s.perUser[uid];

      if (us.active.projectId === projectId && us.active.startedAt) return s;

      // stop previous (if any) on selectedDate
      s = materializeActiveIfNeeded(s, uid, selectedDate, now);

      // start new
      const nextUs = s.perUser[uid];
      return {
        ...s,
        perUser: {
          ...s.perUser,
          [uid]: {
            ...nextUs,
            active: { projectId, startedAt: now },
          },
        },
      };
    });
  }

  function stopActive() {
    const now = Date.now();
    setStateStamped((s0) => materializeActiveIfNeeded(s0, currentUser.id, selectedDate, now));
  }

  function exportCsv() {
    const header = ["Range", "Data", "Collaboratore", "Progetto", "Minuti lavoro", "Ore totali", "Trasferta (memo)", "Note"];
    const rows: string[][] = [header];

    const dates = rangeDatesISO(viewRange.startISO, viewRange.endISO);

    for (const u of state.users) {
      const ps = state.projectsByUser?.[u.id] || [];
      for (const dateISO of dates) {
        for (const p of ps) {
          const entry = getEntry(u.id, dateISO, p.id);
          const b = getDisplayWork(u.id, dateISO, p.id);
          const mWork = msToMinutesInt(b.workMs);
          const ore = (mWork / 60).toFixed(2);

          rows.push([viewRange.label, dateISO, u.name, p.name, String(mWork), ore, entry.travel ? "SI" : "NO", entry.note || ""]);
        }
      }
    }

    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ore_progetti_${view}_${scope}_${selectedDate}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function addUser() {
    const name = newUserName.trim();
    if (!name) return;
    const id = cryptoRandomId();

    setStateStamped((s0) => {
      let s = ensureUserState(s0, id);
      const template = (s.projectsByUser[currentUser.id] || []).map((p) => ({ id: cryptoRandomId(), name: p.name }));

      return {
        ...s,
        users: [...s.users, { id, name }],
        projectsByUser: {
          ...s.projectsByUser,
          [id]: template,
        },
        perUser: {
          ...s.perUser,
          [id]: s.perUser[id] || { days: {}, active: { projectId: null, startedAt: null } },
        },
      };
    });

    setNewUserName("");
  }

  function removeUser(userId: string) {
    setStateStamped((s0) => {
      if (s0.users.length <= 1) return s0;
      const nextUsers = s0.users.filter((u) => u.id !== userId);

      const nextPerUser = { ...(s0.perUser || {}) };
      delete nextPerUser[userId];

      const nextProjectsByUser = { ...(s0.projectsByUser || {}) };
      delete nextProjectsByUser[userId];

      const nextCurrent = s0.currentUserId === userId ? nextUsers[0].id : s0.currentUserId;
      return {
        ...s0,
        users: nextUsers,
        perUser: nextPerUser,
        projectsByUser: nextProjectsByUser,
        currentUserId: nextCurrent,
      };
    });
  }

  // ----------------------
  // Cloud Sync via Supabase REST
  // ----------------------

  function isSyncConfigured() {
    return Boolean(sync.supabaseUrl && sync.supabaseAnonKey && sync.workspaceKey);
  }

  async function supabaseUpsert(payload: AppState) {
    const { supabaseUrl, supabaseAnonKey, workspaceKey } = sync;
    const base = trimTrailingSlash(supabaseUrl);
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
    const base = trimTrailingSlash(supabaseUrl);
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
    return migrateState(rows[0]?.value);
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
        setSyncStatus((s) => ({
          ...s,
          state: "ok",
          message: "Nessun dato nel cloud per questa workspace.",
          lastPullAt: Date.now(),
        }));
        return;
      }

      const cloudStamp = Number(cloud.updatedAt || 0);
      const localStamp = Number(state.updatedAt || 0);

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

  const activeProjectName = useMemo(() => {
    const pid = activeForCurrentUser.projectId;
    if (!pid) return null;
    return currentProjects.find((p) => p.id === pid)?.name || null;
  }, [activeForCurrentUser.projectId, currentProjects]);

  const isAnyTimerRunningForCurrentUser = Boolean(activeForCurrentUser.projectId && activeForCurrentUser.startedAt);

  function exportTeamCompareCsv() {
    const header = ["Range", "Progetto", ...state.users.map((u) => `${u.name} (ore)`), "Totale ore"];
    const rows: string[][] = [header];

    for (const pname of projectNameUniverse) {
      const row: string[] = [viewRange.label, pname];
      let sum = 0;

      for (const u of state.users) {
        const ms = totalsTeam.matrix[pname]?.[u.id]?.workMs || 0;
        sum += ms;
        row.push(msToHhMm(ms));
      }

      row.push(msToHhMm(sum));
      rows.push(row);
    }

    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ore_team_compare_${view}_${selectedDate}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const titleUser = currentUser?.name || "Utente";

  return (
    <div className="app">
      <style>{styles}</style>

      <header className="topbar">
        <div>
          <div className="title">Tracker ore per progetti</div>
          <div className="subtitle">Cronometro per progetto • local + sync Supabase (opzionale) • last-write-wins • trasferta = memo</div>
        </div>

        <div className="toolbar">
          <label className="field">
            <span>Data</span>
            <input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          </label>

          <label className="field">
            <span>Vista</span>
            <select value={view} onChange={(e) => setView(e.target.value as ViewMode)}>
              <option value="day">Giorno</option>
              <option value="week">Settimana</option>
              <option value="month">Mese</option>
              <option value="year">Anno</option>
            </select>
          </label>

          <label className="field">
            <span>Scope</span>
            <select
              value={scope}
              onChange={(e) => {
                const next = e.target.value as ScopeMode;
                setScope(next);
                if (next === "all") setTeamMode("compare");
              }}
            >
              <option value="me">Solo io</option>
              <option value="all">Team</option>
            </select>
          </label>

          {scope === "all" && (
            <label className="field">
              <span>Team mode</span>
              <select value={teamMode} onChange={(e) => setTeamMode(e.target.value as TeamMode)}>
                <option value="sum">Somma</option>
                <option value="compare">Confronto</option>
              </select>
            </label>
          )}

          {scope === "me" && (
            <label className="field">
              <span>Layout</span>
              <select value={layout} onChange={(e) => setLayout(e.target.value as LayoutMode)}>
                <option value="pdf">Design PDF</option>
                <option value="dettagli">Dettagli</option>
              </select>
            </label>
          )}

          <button className={isAnyTimerRunningForCurrentUser ? "btn danger" : "btn"} onClick={stopActive} disabled={!isAnyTimerRunningForCurrentUser || scope === "all"}>
            STOP
          </button>

          <button className="btn" onClick={() => setCompact((v) => !v)}>
            {compact ? "Mostra dettagli" : "Compatta"}
          </button>

          <button className="btn" onClick={exportCsv}>
            Esporta CSV
          </button>

          {scope === "all" && teamMode === "compare" && (
            <button className="btn" onClick={exportTeamCompareCsv}>
              CSV confronto
            </button>
          )}

          <button className="btn" onClick={resetDay} disabled={scope === "all"}>
            Reset giorno
          </button>
        </div>

        <div className="activeStrip">
          <div className="userPill">
            <span className="muted small">Collaboratore</span>
            <select value={state.currentUserId} onChange={(e) => setStateStamped((s) => ({ ...s, currentUserId: e.target.value }))}>
              {state.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>

          {isAnyTimerRunningForCurrentUser && scope === "me" && (
            <>
              <span className="badge">Attivo: {activeProjectName || "(sconosciuto)"} • LAVORO</span>
              <span className="muted small">Avviato: {formatDateTime(activeForCurrentUser.startedAt)}</span>
            </>
          )}

          {scope === "all" && (
            <>
              <span className="badge outline">{viewRange.label}</span>
              <span className="muted small">Totale team: {msToHhMm(totalsTeam.grandWorkMs)}</span>
            </>
          )}
        </div>
      </header>

      <main className="grid">
        <section className={layout === "pdf" ? "card span2 pdf" : "card span2"}>
          {scope === "all" ? (
            <div className="teamWrap">
              <div className="sectionTitle">Team • {viewRange.label}</div>

              {teamMode === "sum" ? (
                <>
                  <div className="kv">
                    <div className="kvRow">
                      <span className="muted">Totale lavoro</span>
                      <span>{msToHhMm(totalsTeam.grandWorkMs)}</span>
                    </div>
                  </div>

                  <div className="tableWrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Progetto</th>
                          <th className="num">Totale</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projectNameUniverse.map((pname) => {
                          let w = 0;
                          for (const u of state.users) w += totalsTeam.matrix[pname]?.[u.id]?.workMs || 0;
                          if (!w) return null;
                          return (
                            <tr key={pname}>
                              <td className="truncate">{pname}</td>
                              <td className="num strong">{msToHhMm(w)}</td>
                            </tr>
                          );
                        })}
                        {projectNameUniverse.every((pname) => {
                          let sum = 0;
                          for (const u of state.users) sum += totalsTeam.matrix[pname]?.[u.id]?.workMs || 0;
                          return sum === 0;
                        }) && (
                          <tr>
                            <td colSpan={2} className="muted small">
                              Nessun dato nel periodo.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <>
                  <div className="muted small">Confronto ore per progetto e collaboratore (CSV confronto disponibile).</div>
                  <div className="tableWrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Progetto</th>
                          {state.users.map((u) => (
                            <th key={u.id} className="num">
                              {u.name}
                            </th>
                          ))}
                          <th className="num">Totale</th>
                        </tr>
                      </thead>
                      <tbody>
                        {projectNameUniverse.map((pname) => {
                          const cells = state.users.map((u) => totalsTeam.matrix[pname]?.[u.id]?.workMs || 0);
                          const rowSum = cells.reduce((a, b) => a + b, 0);
                          if (!rowSum) return null;
                          return (
                            <tr key={pname}>
                              <td className="truncate">{pname}</td>
                              {cells.map((ms, idx) => (
                                <td key={state.users[idx].id} className="num">
                                  {msToHhMm(ms)}
                                </td>
                              ))}
                              <td className="num strong">{msToHhMm(rowSum)}</td>
                            </tr>
                          );
                        })}
                        {projectNameUniverse.every((pname) => {
                          let sum = 0;
                          for (const u of state.users) sum += totalsTeam.matrix[pname]?.[u.id]?.workMs || 0;
                          return sum === 0;
                        }) && (
                          <tr>
                            <td colSpan={state.users.length + 2} className="muted small">
                              Nessun dato nel periodo.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          ) : layout === "pdf" ? (
            <div className="pdfWrap">
              <div className="pdfHead">
                <div>
                  <div className="pdfTitle">{titleUser}</div>
                  <div className="pdfDate">{selectedDate}</div>
                </div>
                <div className="pdfTotals">
                  <div className="pdfTotalRow">
                    <span className="muted">Totale</span>
                    <span className="strong">{msToHhMm(totalsMe.totalWorkMs)}</span>
                  </div>
                </div>
              </div>

              <div className={compact ? "pdfList compact" : "pdfList"}>
                {currentProjects.map((p) => {
                  const b = getDisplayWork(currentUser.id, selectedDate, p.id);
                  const isActive = activeForCurrentUser.projectId === p.id && !!activeForCurrentUser.startedAt;
                  const entry = getEntry(currentUser.id, selectedDate, p.id);

                  return (
                    <div key={p.id} className={isActive ? "pdfRow active" : "pdfRow"}>
                      <div className="pdfLeft">
                        <div className="pdfProjName">
                          {p.name} {entry.travel ? <span className="badge mini">TRASFERTA</span> : null}
                        </div>
                        <div className="pdfMeta">
                          <span className="pill strong">Totale: {msToHhMm(b.workMs)}</span>
                        </div>
                      </div>

                      <div className="pdfBtns oneCol">
                        <button className={isActive ? "bigBtn on" : "bigBtn"} onClick={() => startProject(p.id)} type="button">
                          <StopWatchIcon filled={isActive} />
                          <div className="bigLabel">Lavoro</div>
                        </button>

                        <button className={entry.travel ? "bigBtn on" : "bigBtn"} onClick={() => toggleTrasfertaMemo(currentUser.id, selectedDate, p.id)} type="button">
                          <FlagStopIcon />
                          <div className="bigLabel">Trasferta (memo)</div>
                        </button>
                      </div>

                      {!compact && (
                        <div className="pdfEdit">
                          <div className="editBlock">
                            <div className="editLabel">Minuti lavoro</div>
                            <div className="editRow">
                              <button className="mini" disabled={isActive} onClick={() => bumpMs(currentUser.id, selectedDate, p.id, -15 * 60000)}>
                                −15
                              </button>
                              <input
                                className="minutes"
                                inputMode="numeric"
                                value={String(msToMinutesInt(getEntry(currentUser.id, selectedDate, p.id).workMs))}
                                disabled={isActive}
                                onChange={(e) => {
                                  const v = Number(digitsOnly(e.target.value));
                                  updateEntry(currentUser.id, selectedDate, p.id, { workMs: minutesIntToMs(v) });
                                }}
                              />
                              <button className="mini" disabled={isActive} onClick={() => bumpMs(currentUser.id, selectedDate, p.id, 15 * 60000)}>
                                +15
                              </button>
                            </div>
                            {isActive && <div className="muted tiny">🔒 bloccato mentre il timer è attivo</div>}
                          </div>

                          <div className="editBlock wide">
                            <div className="editLabel">Nota</div>
                            <textarea
                              className="note"
                              rows={2}
                              value={getEntry(currentUser.id, selectedDate, p.id).note}
                              onChange={(e) => updateEntry(currentUser.id, selectedDate, p.id, { note: e.target.value })}
                              placeholder="Nota (opzionale)"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}

                {currentProjects.length === 0 && <div className="muted small">Nessun progetto. Aggiungine uno a destra.</div>}
              </div>
            </div>
          ) : (
            <div className="detailWrap">
              <div className="sectionTitle">Dettagli • {viewRange.label}</div>
              <div className="kv">
                <div className="kvRow">
                  <span className="muted">Totale</span>
                  <span className="strong">{msToHhMm(totalsMe.totalWorkMs)}</span>
                </div>
              </div>

              <div className="tableWrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Progetto</th>
                      <th>Trasferta</th>
                      <th className="num">Totale</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentProjects.map((p) => {
                      let w = 0;
                      let anyTravel = false;
                      for (const d of totalsMe.dates) {
                        const b = getDisplayWork(currentUser.id, d, p.id);
                        w += b.workMs;
                        const e = getEntry(currentUser.id, d, p.id);
                        if (e.travel) anyTravel = true;
                      }
                      return (
                        <tr key={p.id}>
                          <td className="truncate">{p.name}</td>
                          <td>{anyTravel ? "SI" : "NO"}</td>
                          <td className="num strong">{msToHhMm(w)}</td>
                        </tr>
                      );
                    })}
                    {currentProjects.length === 0 && (
                      <tr>
                        <td colSpan={3} className="muted small">
                          Nessun progetto.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        <aside className="card">
          <div className="sectionTitle">Gestione</div>

          <div className="box">
            <div className="boxTitle">Progetti ({titleUser})</div>
            <div className="row">
              <input ref={newProjectRef} className="input" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="Nuovo progetto…" />
              <button className="btn" onClick={addProject} disabled={!newProjectName.trim() || scope === "all"}>
                Aggiungi
              </button>
            </div>
            <div className="list">
              {currentProjects.map((p) => (
                <div key={p.id} className="listRow">
                  <div className="truncate">{p.name}</div>
                  <button className="btn ghost" onClick={() => removeProject(p.id)} disabled={scope === "all"}>
                    Rimuovi
                  </button>
                </div>
              ))}
              {currentProjects.length === 0 && <div className="muted small">Aggiungi un progetto sopra.</div>}
            </div>
          </div>

          <div className="box">
            <div className="boxTitle">Collaboratori</div>
            <div className="row">
              <input className="input" value={newUserName} onChange={(e) => setNewUserName(e.target.value)} placeholder="Nome collaboratore…" />
              <button className="btn" onClick={addUser} disabled={!newUserName.trim()}>
                Aggiungi
              </button>
            </div>
            <div className="list">
              {state.users.map((u) => (
                <div key={u.id} className="listRow">
                  <div className="truncate">
                    {u.name}
                    {u.id === state.currentUserId ? <span className="badge mini">attivo</span> : null}
                  </div>
                  <button className="btn ghost" onClick={() => removeUser(u.id)} disabled={state.users.length <= 1}>
                    Rimuovi
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="box">
            <div className="boxTitle">Riepilogo ({viewRange.label})</div>
            <div className="kv">
              <div className="kvRow">
                <span className="muted">Totale</span>
                <span className="strong">{scope === "all" ? msToHhMm(totalsTeam.grandWorkMs) : msToHhMm(totalsMe.totalWorkMs)}</span>
              </div>
            </div>
          </div>

          <div className="box">
            <div className="boxTitle">Sync (Supabase) • opzionale</div>
            <div className="muted small">
              Per sincronizzare tra dispositivi (iPhone/iMac/Android). Richiede una tabella <span className="mono">kv</span> su Supabase.
            </div>

            <label className="field full">
              <span>Supabase URL</span>
              <input className="input" value={sync.supabaseUrl} onChange={(e) => setSync((c) => ({ ...c, supabaseUrl: e.target.value }))} placeholder="https://xxxxx.supabase.co" />
            </label>
            <label className="field full">
              <span>Anon key</span>
              <input className="input" value={sync.supabaseAnonKey} onChange={(e) => setSync((c) => ({ ...c, supabaseAnonKey: e.target.value }))} placeholder="eyJ..." />
            </label>
            <label className="field full">
              <span>Workspace key</span>
              <input className="input" value={sync.workspaceKey} onChange={(e) => setSync((c) => ({ ...c, workspaceKey: e.target.value }))} placeholder="studio-rossi" />
            </label>

            <div className="row">
              <label className="check">
                <input type="checkbox" checked={sync.autoPush} onChange={(e) => setSync((c) => ({ ...c, autoPush: e.target.checked }))} />
                <span>Auto push</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={sync.autoPull} onChange={(e) => setSync((c) => ({ ...c, autoPull: e.target.checked }))} />
                <span>Auto pull</span>
              </label>
            </div>

            <label className="field full">
              <span>Intervallo pull (sec)</span>
              <input className="input" inputMode="numeric" value={String(sync.autoPullIntervalSec)} onChange={(e) => setSync((c) => ({ ...c, autoPullIntervalSec: Number(digitsOnly(e.target.value || "20")) || 20 }))} />
            </label>

            <div className="row">
              <button className="btn" onClick={pushToCloud} disabled={!isSyncConfigured()}>
                Push
              </button>
              <button className="btn" onClick={pullFromCloud} disabled={!isSyncConfigured()}>
                Pull
              </button>
            </div>

            <div className={syncStatus.state === "error" ? "syncStatus error" : "syncStatus"}>
              <div className="muted small">
                Stato: <span className="mono">{syncStatus.state}</span>
              </div>
              {syncStatus.message && <div className="small">{syncStatus.message}</div>}
              <div className="muted tiny">Ultimo push: {formatDateTime(syncStatus.lastPushAt)}</div>
              <div className="muted tiny">Ultimo pull: {formatDateTime(syncStatus.lastPullAt)}</div>
            </div>

            <hr className="sep" />
            <div className="muted small">PWA: su iPhone apri in Safari → Condividi → Aggiungi a Home. Su Android: menu browser → Installa app.</div>
          </div>
        </aside>
      </main>
    </div>
  );
}

const styles = `
  :root {
    color-scheme: light;
    --bg: #ffffff;
    --card: #ffffff;
    --border: #e5e7eb;
    --muted: #6b7280;
    --text: #111827;
    --accent: #a88a6b;
    --accent2: rgba(168, 138, 107, 0.10);
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: var(--bg); color: var(--text); }

  .app { padding: 16px; max-width: 1200px; margin: 0 auto; }

  .topbar { display: grid; gap: 10px; margin-bottom: 12px; }
  @media (min-width: 860px) {
    .topbar { grid-template-columns: 1fr auto; align-items: end; }
  }

  .title { font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
  .subtitle { font-size: 12px; color: var(--muted); margin-top: 4px; }

  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; justify-content: flex-end; }

  .field { display: grid; gap: 4px; font-size: 12px; color: var(--muted); }
  .field.full { width: 100%; }
  .field > span { font-weight: 600; }

  input, select, textarea { font-family: inherit; }
  select, input[type="date"], .input, .minutes, textarea {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px 12px;
    background: #fff;
    color: var(--text);
    outline: none;
  }

  .input { width: 100%; }
  textarea { width: 100%; resize: vertical; min-height: 46px; }

  .btn {
    border: 1px solid rgba(168, 138, 107, 0.45);
    background: rgba(168, 138, 107, 0.08);
    color: var(--text);
    border-radius: 12px;
    padding: 10px 12px;
    cursor: pointer;
    font-weight: 650;
    letter-spacing: 0.01em;
  }
  .btn:hover { background: rgba(168, 138, 107, 0.12); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.danger { border-color: rgba(239, 68, 68, 0.45); background: rgba(239, 68, 68, 0.08); }

  .btn.ghost { background: transparent; border-color: var(--border); }
  .btn.ghost:hover { background: rgba(17, 24, 39, 0.03); }

  .activeStrip { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid rgba(168, 138, 107, 0.45);
    background: rgba(168, 138, 107, 0.08);
    font-size: 12px;
    font-weight: 650;
  }
  .badge.outline { background: transparent; }
  .badge.mini { margin-left: 8px; padding: 2px 8px; font-size: 11px; }

  .muted { color: var(--muted); }
  .small { font-size: 12px; }
  .tiny { font-size: 11px; }
  .strong { font-weight: 750; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }

  .grid { display: grid; gap: 12px; }
  @media (min-width: 900px) { .grid { grid-template-columns: 2fr 1fr; } }

  .card {
    border: 1px solid var(--border);
    border-radius: 18px;
    background: var(--card);
    padding: 14px;
    box-shadow: 0 6px 18px rgba(17,24,39,0.04);
  }

  .span2 { grid-column: 1 / -1; }
  @media (min-width: 900px) { .span2 { grid-column: auto; } }

  .sectionTitle { font-weight: 800; margin-bottom: 10px; }

  .kv { display: grid; gap: 8px; margin-top: 10px; }
  .kvRow { display: flex; justify-content: space-between; gap: 10px; }

  .tableWrap { overflow: auto; border: 1px solid var(--border); border-radius: 14px; margin-top: 10px; }
  .table { width: 100%; border-collapse: collapse; }
  .table th, .table td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  .table th { text-align: left; font-size: 12px; color: var(--muted); background: rgba(17,24,39,0.02); }
  .table td.num, .table th.num { text-align: right; white-space: nowrap; }

  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .box { border: 1px solid var(--border); border-radius: 16px; padding: 12px; display: grid; gap: 10px; margin-top: 10px; }
  .boxTitle { font-weight: 800; }
  .row { display: flex; gap: 10px; align-items: center; }
  .row > * { flex: 1; }
  .row > button { flex: 0 0 auto; }

  .list { display: grid; gap: 8px; }
  .listRow { display: flex; gap: 10px; justify-content: space-between; align-items: center; }

  .check { display: inline-flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text); }

  .sep { border: none; border-top: 1px solid var(--border); margin: 10px 0; }

  .syncStatus { border: 1px solid var(--border); border-radius: 14px; padding: 10px; display: grid; gap: 4px; }
  .syncStatus.error { border-color: rgba(239,68,68,0.45); background: rgba(239,68,68,0.05); }

  /* PDF-like layout */
  .pdfWrap { display: grid; gap: 12px; }
  .pdfHead { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; flex-wrap: wrap; }
  .pdfTitle { font-size: 20px; font-weight: 900; letter-spacing: -0.02em; }
  .pdfDate { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .pdfTotals { display: grid; gap: 6px; min-width: 220px; }
  .pdfTotalRow { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }

  .pdfList { display: grid; gap: 12px; }
  .pdfList.compact .pdfEdit { display: none; }

  .pdfRow { border: 1px solid var(--border); border-radius: 18px; padding: 12px; display: grid; gap: 10px; }
  .pdfRow.active { border-color: rgba(168, 138, 107, 0.65); box-shadow: 0 10px 24px rgba(168,138,107,0.12); }

  .pdfLeft { display: grid; gap: 6px; }
  .pdfProjName { font-size: 16px; font-weight: 900; }
  .pdfMeta { display: flex; gap: 8px; flex-wrap: wrap; }

  .pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: rgba(17,24,39,0.02); }

  .pdfBtns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .pdfBtns.oneCol { grid-template-columns: 1fr 1fr; }
  .bigBtn {
    border: 1px solid rgba(168, 138, 107, 0.45);
    background: rgba(168, 138, 107, 0.06);
    border-radius: 18px;
    padding: 12px;
    cursor: pointer;
    display: grid;
    justify-items: center;
    gap: 8px;
  }
  .bigBtn:hover { background: rgba(168, 138, 107, 0.10); }
  .bigBtn.on { background: rgba(168, 138, 107, 0.14); border-color: rgba(168, 138, 107, 0.75); }
  .bigLabel { font-weight: 900; letter-spacing: 0.02em; }

  .pdfEdit { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
  .editBlock { display: grid; gap: 6px; }
  .editBlock.wide { grid-column: 1 / -1; }
  .editLabel { font-size: 12px; color: var(--muted); font-weight: 700; }
  .editRow { display: flex; gap: 8px; align-items: center; }

  .mini {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 9px 10px;
    background: #fff;
    cursor: pointer;
    font-weight: 800;
  }
  .mini:disabled { opacity: 0.5; cursor: not-allowed; }
  .minutes { width: 100%; text-align: center; font-weight: 800; }

  .detailWrap { display: grid; gap: 10px; }

  /* Mobile tweaks */
  @media (max-width: 520px) {
    .toolbar { justify-content: flex-start; }
    .pdfBtns { grid-template-columns: 1fr; }
    .pdfEdit { grid-template-columns: 1fr; }
    .row { flex-direction: column; align-items: stretch; }
    .row > button { width: 100%; }
  }
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
    console.assert(msToHhMm(0) === "0h 00m", "msToHhMm(0) failed");
    console.assert(msToHhMm(61 * 60000) === "1h 01m", "msToHhMm(61m) failed");

    console.assert(csvEscape("plain") === "plain", "csvEscape plain failed");
    console.assert(csvEscape('a"b') === '"a""b"', "csvEscape quote failed");
    console.assert(csvEscape("a,b") === '"a,b"', "csvEscape comma failed");
    console.assert(csvEscape("a\nb") === '"a\nb"', "csvEscape newline failed");
    console.assert(csvEscape("a\rb") === '"a\rb"', "csvEscape CR failed");

    console.assert(digitsOnly("a1b2") === "12", "digitsOnly failed");
    console.assert(trimTrailingSlash("https://x/") === "https://x", "trimTrailingSlash failed");

    const b = getRuntimeBaseUrl();
    console.assert(typeof b === "string" && b.startsWith("/") && b.endsWith("/"), "getRuntimeBaseUrl failed");
    console.assert(normalizeBaseUrl("tracker-ore") === "/tracker-ore/", "normalizeBaseUrl no slash failed");

    const id = cryptoRandomId();
    console.assert(typeof id === "string" && id.length > 5, "cryptoRandomId failed");

    console.assert(startOfMonthISO("2026-02-19") === "2026-02-01", "startOfMonthISO failed");
    console.assert(startOfYearISO("2026-02-19") === "2026-01-01", "startOfYearISO failed");
    console.assert(endOfYearISO("2026-02-19") === "2026-12-31", "endOfYearISO failed");

    const r = rangeDatesISO("2026-02-01", "2026-02-03");
    console.assert(r.length === 3 && r[0] === "2026-02-01" && r[2] === "2026-02-03", "rangeDatesISO failed");
  } catch {
    // ignore
  }
})();