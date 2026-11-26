import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Compass, DoorOpen, Gamepad2, Map, MessageSquare, Radio, Settings } from 'lucide-react';
import { api, ApiError, type CloudProject, type Me } from '../api';
import { openAssignment } from '../assignment';
import { colors } from '../campus/art';
import { startCollab } from '../collab';
import { distance, roomAt, type CampusMap, type Player } from '../campus/map';
import type { Direction, mountCampus } from '../campus/game';
import { LearningProgress } from '../components/LearningProgress';
import { downloadFile } from '../projects';
import { useUi } from '../store';

type CampusClass = { id: string; name: string; org_id: string; staff: boolean };
type Avatar = { color: number; unlocked: number[] };
type Mission = { id: string; title: string; statement: string | null; exam: boolean; room: string | null; duration_min: number | null; template: string | null; opens_at: string | null; kind: 'incident' | 'exercise' };
type Activity = { missions: Mission[]; announcements: string[]; completed: string[]; closed: string[]; muted: string[]; templates: { id: string; title: string }[] };
type Chat = { name: string; text: string; channel: string };
type Invitation = { name: string; project: string; token: string; title: string };
type Slide = { course_id: string; title: string; index: number; total: number; lesson: { title: string; body: string; takeaway: string } };
type Panel = 'plan' | 'station' | 'chat' | 'settings' | 'staff' | 'progress' | 'guide' | 'missions';
const empty: Activity = { missions: [], announcements: [], completed: [], closed: [], muted: [], templates: [] };
const control = 'rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-cyan-300 disabled:opacity-50';
const headings: Record<Panel, string> = {
  plan: 'Plan du campus', station: 'Poste pédagogique', chat: 'Communications',
  settings: 'Avatar et affichage', staff: 'Gestion de la classe', progress: 'Progression', guide: 'Discussion', missions: 'Missions de la classe',
};

export function Campus({ me, exit, suspended }: { me: Me; exit: () => void; suspended: boolean }) {
  const setUi = useUi(s => s.set);
  const toast = useUi(s => s.toast);
  const [data, setData] = useState<{ map: CampusMap; classes: CampusClass[]; profile: Avatar }>();
  const [error, setError] = useState('');
  const [cid, setCid] = useState(() => sessionStorage.getItem('campus-class') ?? '');
  const [activity, setActivity] = useState<Activity>(empty);
  const [players, setPlayers] = useState<Player[]>([]);
  const [policy, setPolicy] = useState({ closed: [] as string[], muted: false });
  const [connection, setConnection] = useState('Exploration libre');
  const [chat, setChat] = useState<Chat[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [courseOptions, setCourseOptions] = useState<{ id: string; title: string }[]>([]);
  const [courseId, setCourseId] = useState('');
  const [slide, setSlide] = useState<Slide | null>(null);
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState('class');
  const [panel, setPanel] = useState<Panel>();
  const [hint, setHint] = useState(0);
  const [pending, setPending] = useState(false);
  const [installing, setInstalling] = useState('');
  const [zoom, setZoom] = useState(1.35);
  const [economy, setEconomy] = useState(() => localStorage.getItem('campus-economy') === 'on');
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [avatar, setAvatar] = useState<Avatar>({ color: 0, unlocked: [0, 1, 2] });
  const viewport = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const chatField = useRef<HTMLInputElement>(null);
  const game = useRef<ReturnType<typeof mountCampus> | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const own = players.find(p => p.id === me.id);
  const selectedClass = data?.classes.find(c => c.id === cid);
  const staff = selectedClass?.staff ?? false;
  const room = own && data ? roomAt(data.map, own) : undefined;
  const nearStation = own && room && distance(own, { x: room.station[0], y: room.station[1] }) <= 2;
  const guide = data?.map.guides.find(g => g.room === (room?.id ?? 'hall'));
  const nearGuide = own && guide && distance(own, guide) <= 1;
  const live = useRef({ panel, zoom, reduced, suspended, color: avatar.color, policy });
  useEffect(() => { live.current = { panel, zoom, reduced, suspended, color: avatar.color, policy }; }, [panel, zoom, reduced, suspended, avatar.color, policy]);
  useEffect(() => { game.current?.update(players); }, [players]);
  useEffect(() => {
    game.current?.suspend(suspended);
    if (suspended) setPanel(undefined);
    if (socket.current?.readyState === WebSocket.OPEN) send({ type: 'status', value: suspended ? 'working' : '' });
  }, [suspended]);

  useEffect(() => {
    let cancelled = false;
    void api<NonNullable<typeof data>>('GET', '/campus').then(result => {
      if (cancelled) return;
      setAvatar(result.profile);
      setData(result);
      setCid(id => result.classes.some(c => c.id === id) ? id : result.classes[0]?.id ?? '');
    }).catch(() => { if (!cancelled) setError('Le campus est indisponible.'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!data || !viewport.current) return;
    const parent = viewport.current;
    let cancelled = false;
    void import('../campus/game').then(({ mountCampus }) => {
      if (cancelled) return;
      game.current = mountCampus(parent, {
        map: data.map, staff, userId: me.id, economy,
        reduced: () => live.current.reduced, blocked: () => !!live.current.panel || live.current.suspended, zoom: () => live.current.zoom,
        closed: () => live.current.policy.closed,
        step: (p, direction) => {
          if (cid) send({ type: 'step', ...p });
          else setPlayers(previous => previous.map(player => ({ ...player, ...p, direction })));
        },
      });
      game.current.update(currentPlayers.current);
    }).catch(() => { if (!cancelled) setError('Le moteur graphique est indisponible.'); });
    return () => {
      cancelled = true;
      game.current?.destroy();
      game.current = undefined;
    };
  }, [data, cid, staff, me.id, economy]);

  const currentPlayers = useRef(players);
  useEffect(() => { currentPlayers.current = players; }, [players]);

  useEffect(() => {
    if (!data) return;
    setChat([]);
    setInvitations([]);
    setPolicy({ closed: [], muted: false });
    setActivity(empty);
    if (!cid) {
      const [x, y] = data.map.spawn;
      setPlayers([{ id: me.id, name: me.display_name, x, y, emote: 0, status: '', direction: 'down', color: live.current.color }]);
      setConnection('Exploration libre');
      return;
    }
    sessionStorage.setItem('campus-class', cid);
    setPlayers([]);
    setConnection('Connexion…');
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let retry = 500;
    function connect() {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws/campus/${cid}`);
      socket.current = ws;
      ws.onopen = () => {
        retry = 500;
        setConnection('En ligne');
        if (live.current.suspended) ws.send(JSON.stringify({ type: 'status', value: 'working' }));
      };
      ws.onmessage = ({ data: raw }) => {
        if (cancelled) return;
        const event = JSON.parse(raw) as ({ type: 'state'; players: Player[]; closed: string[]; muted: boolean } | { type: 'muted' } | ({ type: 'chat' } & Chat) | ({ type: 'invite' } & Invitation));
        if (event.type === 'state') {
          setPlayers(event.players);
          setPolicy(previous => previous.muted === event.muted && previous.closed.join() === event.closed.join()
            ? previous : { muted: event.muted, closed: event.closed });
        }
        if (event.type === 'chat') setChat(previous => [...previous.slice(-49), event]);
        if (event.type === 'invite') setInvitations(previous => [...previous.slice(-4), event]);
      };
      ws.onclose = ({ code }) => {
        if (cancelled) return;
        setPlayers([]);
        if ([4404, 4408, 4409].includes(code)) {
          setConnection(code === 4404 ? 'Accès indisponible' : 'Session interrompue');
          return;
        }
        setConnection('Reconnexion…');
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    }
    connect();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      const ws = socket.current;
      socket.current = undefined;
      if (ws?.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
      else ws?.close();
    };
  }, [cid, data, me.id, me.display_name]);

  useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    function refresh() {
      void api<Activity>('GET', `/campus/classes/${cid}`).then(result => {
        if (!cancelled) setActivity(result);
      }).catch(() => { if (!cancelled) setActivity(empty); });
    }
    refresh();
    const interval = setInterval(refresh, 12000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [cid, suspended]);

  useEffect(() => {
    const node = dialog.current;
    if (panel && !suspended && node && !node.open) node.showModal();
    if (panel === 'chat' && !suspended) chatField.current?.focus();
    if ((!panel || suspended) && node?.open) node.close();
  }, [panel, suspended]);

  useEffect(() => {
    if (panel !== 'station' || room?.id !== 'collaboration' || !cid) return;
    let cancelled = false;
    void api<CloudProject[]>('GET', '/projects').then(result => {
      if (!cancelled) setProjects(result);
    }).catch(() => { if (!cancelled) setProjects([]); });
    return () => { cancelled = true; };
  }, [panel, room?.id, cid]);

  useEffect(() => {
    if (panel !== 'station' || room?.id !== 'lecture' || !cid || !selectedClass) return;
    let cancelled = false;
    function refresh() {
      void api<Slide | null>('GET', `/campus/classes/${cid}/presentation`).then(value => {
        if (!cancelled) setSlide(value);
      }).catch(() => { if (!cancelled) setSlide(null); });
    }
    refresh();
    if (staff) void api<typeof courseOptions>('GET', `/orgs/${selectedClass.org_id}/courses`).then(value => {
      if (!cancelled) setCourseOptions(value);
    }).catch(() => { if (!cancelled) setCourseOptions([]); });
    const interval = setInterval(refresh, 2000);
    return () => { cancelled = true; clearInterval(interval); setSlide(null); setCourseId(''); };
  }, [panel, room?.id, cid, selectedClass, staff]);

  function send(payload: object) {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(payload));
  }

  function goHome() {
    if (cid) send({ type: 'home' });
    else if (data) setPlayers(previous => previous.map(p => ({ ...p, x: data.map.spawn[0], y: data.map.spawn[1] })));
  }

  function showStation() {
    if (nearGuide && !nearStation) {
      setHint(0);
      setPanel('guide');
      return;
    }
    if (!nearStation && room) {
      toast('Approchez-vous de l’écran turquoise pour interagir.');
      return;
    }
    setHint(0);
    setPanel(room?.id === 'staff' && staff ? 'staff' : 'station');
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || panel || suspended) return;
      const key = event.key.toLowerCase();
      if (event.target instanceof HTMLElement && event.target.closest(
        key === 'enter' ? 'input,textarea,select,button,a,[contenteditable]' : 'input,textarea,select,[contenteditable]',
      )) return;
      if (!['e', 'm', 't', 'enter', '1', '2', '3', '4', '5', '6'].includes(key)) return;
      event.preventDefault();
      if (key === 'e') showStation();
      else if (key === 'm') setPanel('plan');
      else if (key === 't') goHome();
      else if (key === 'enter' && cid) setPanel('chat');
      else if (Number(key)) send({ type: 'emote', value: Number(key) });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function open(mission: Mission) {
    if (pending || (mission.exam && !window.confirm(mission.duration_min
      ? `Commencer ou reprendre cet examen de ${mission.duration_min} min ?`
      : 'Ouvrir cet examen ?'))) return;
    setPending(true);
    try {
      await openAssignment(mission.id, `/campus/classes/${cid}/missions/${mission.id}/start`);
    } catch (e) {
      const explanations: Record<string, string> = { deadline_passed: 'Le délai est dépassé.', not_open: 'Cette activité est fermée.', no_attempts_left: 'Toutes les tentatives ont été utilisées.', station_out_of_reach: 'Approchez-vous du poste et réessayez.' };
      toast((e instanceof ApiError && explanations[e.code]) || 'Impossible d’ouvrir cette activité.', 'error');
    } finally {
      setPending(false);
    }
  }

  async function place(id: string, roomId: string) {
    try {
      await api('PUT', `/campus/assignments/${id}/room`, { room: roomId || null });
      setActivity(previous => ({ ...previous, missions: previous.missions.map(m => m.id === id ? { ...m, room: roomId || null } : m) }));
    } catch {
      toast('Impossible de déplacer la mission.', 'error');
    }
  }

  async function install(key: string) {
    setInstalling(key);
    try {
      await api('POST', `/campus/classes/${cid}/templates/${key}`);
      const updated = await api<Activity>('GET', `/campus/classes/${cid}`);
      if (sessionStorage.getItem('campus-class') === cid) setActivity(updated);
    } catch {
      toast('Impossible d’installer la mission.', 'error');
    } finally {
      setInstalling('');
    }
  }

  async function chooseColor(color: number) {
    try {
      await api('PUT', '/campus/avatar', { color });
      setAvatar(previous => ({ ...previous, color }));
      if (!cid) setPlayers(previous => previous.map(p => ({ ...p, color })));
    } catch {
      toast('Impossible de changer de tenue.', 'error');
    }
  }

  async function setRule(path: string, enabled: boolean) {
    try {
      const changed = await api<Partial<Activity>>('PUT', `/campus/classes/${cid}/${path}`, { enabled });
      setActivity(previous => ({ ...previous, ...changed }));
    } catch {
      toast('Impossible de modifier les règles de la classe.', 'error');
    }
  }

  async function dispatch(mission: Mission) {
    try {
      const result = await api<{ opens_at: string }>('POST', `/campus/classes/${cid}/missions/${mission.id}/dispatch`);
      setActivity(previous => ({ ...previous, missions: previous.missions.map(m => m.id === mission.id ? { ...m, ...result } : m) }));
      toast('L’incident est ouvert à la classe.');
    } catch {
      toast('Impossible de déclencher l’incident.', 'error');
    }
  }

  async function invite() {
    if (!selectedClass || !projectId || !recipient) return;
    try {
      const result = await api<{ token: string }>('POST', `/projects/${projectId}/share`, { org_id: selectedClass.org_id, role: 'write' });
      send({ type: 'invite', project: projectId, token: result.token, target: recipient });
      setRecipient('');
    } catch {
      toast('Impossible de créer l’invitation.', 'error');
    }
  }

  async function joinProject(invitation: Invitation) {
    try {
      const id = await startCollab(invitation.project, invitation.token);
      setUi({ active: id });
      setInvitations(previous => previous.filter(item => item.token !== invitation.token));
    } catch {
      toast('Impossible de rejoindre ce projet.', 'error');
    }
  }

  async function present(id: string | null, index = 0) {
    try {
      setSlide(await api<Slide | null>('PUT', `/campus/classes/${cid}/presentation`, { course_id: id, lesson: index }));
    } catch {
      toast('Impossible de mettre à jour le cours collectif.', 'error');
    }
  }

  async function exportResults(mission: Mission) {
    try {
      const rows = await api<{ display_name: string; attempts: number; score: number | null; max_score: number | null; submitted_at: string | null }[]>(
        'GET', `/assignments/${mission.id}/submissions`,
      );
      const cell = (value: string | number | null) => {
        const raw = String(value ?? '');
        const safe = typeof value === 'string' && /^[\s=+@-]/.test(raw) ? "'" + raw : raw;
        return `"${safe.replaceAll('"', '""')}"`;
      };
      const table = [['Élève', 'Tentatives', 'Note', 'Maximum', 'Rendu le'], ...rows.map(r => [r.display_name, r.attempts, r.score, r.max_score, r.submitted_at])];
      downloadFile(`resultats-${mission.id}.csv`, '\uFEFF' + table.map(row => row.map(cell).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
    } catch {
      toast('Impossible d’exporter les résultats.', 'error');
    }
  }

  const missions = activity.missions.filter(m => m.room === room?.id && m.room !== null);
  const xp = activity.completed.length * 100;
  const level = 1 + Math.floor(xp / 200);
  return (
    <main className="relative flex h-full flex-col overflow-hidden bg-[#101a2a] text-slate-100">
      <header className="z-10 flex flex-wrap items-center gap-2 border-b border-slate-700 bg-[#142235] p-3 text-sm">
        <button className={control} onClick={exit} aria-label="Retour à l’Académie"><ArrowLeft size={17} /></button>
        <Gamepad2 size={22} className="text-cyan-300" />
        <h1 className="mr-2 text-base font-bold">TPacket Campus</h1>
        <span className="mr-auto text-slate-300">{room?.name ?? 'Hall principal'}</span>
        {data && <select className={control} aria-label="Instance du campus" value={cid} onChange={e => { setCid(e.target.value); setChannel('class'); }}>
          <option value="">Exploration libre</option>
          {data.classes.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}
        </select>}
        <span role="status" className="text-xs text-cyan-200">{connection}{cid && ` · ${players.length} joueur${players.length === 1 ? '' : 's'}`}</span>
        {!!cid && !staff && <button className={control} onClick={() => setPanel('missions')}>Missions ({activity.missions.length})</button>}
        <button className={control} onClick={() => setPanel('progress')}>{cid && !staff ? `Niv. ${level} · ${xp} XP` : 'Progression'}</button>
        <button className={control} aria-label="Carte" onClick={() => setPanel('plan')}><Map size={17} /></button>
        <button className={control} aria-label="Paramètres" onClick={() => setPanel('settings')}><Settings size={17} /></button>
      </header>
      <div className="relative min-h-0 flex-1">
        <div ref={viewport} aria-label="Carte jouable du campus" tabIndex={0} className="absolute inset-0 touch-none overflow-hidden focus-visible:outline-2 focus-visible:outline-cyan-300" />
        {error && <p role="alert" className="absolute inset-x-0 top-8 mx-auto w-fit rounded bg-red-950 p-3">{error}</p>}
        {!data && !error && <p className="absolute inset-x-0 top-8 text-center">Chargement du campus…</p>}
        {data && <button onClick={() => setPanel('plan')} className="absolute right-3 top-3 hidden rounded-lg border border-cyan-400/40 bg-slate-950/85 p-2 sm:block" aria-label="Ouvrir le plan">
          <Plan map={data.map} players={own ? [own] : []} small />
        </button>}
        {chat.length > 0 && !panel && <p className="pointer-events-none absolute bottom-3 left-3 max-w-sm rounded bg-slate-950/90 px-3 py-2 text-sm" aria-live="polite">
          {chat.at(-1)?.name} · {chat.at(-1)?.text}
        </p>}
        <div className="absolute bottom-12 right-3 grid grid-cols-3 gap-1 sm:hidden" aria-label="Déplacements tactiles">
          {([['up', '↑', 'col-start-2'], ['left', '←', 'col-start-1'], ['down', '↓', ''], ['right', '→', '']] as const).map(([direction, symbol, style]) =>
            <button className={`${control} ${style} touch-none select-none`} key={direction} aria-label={`Déplacement ${symbol}`}
              onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); game.current?.hold(direction, true); }}
              onLostPointerCapture={() => game.current?.hold(direction, false)}>{symbol}</button>)}
        </div>
      </div>
      <footer className="z-10 flex flex-wrap items-center gap-2 border-t border-slate-700 bg-[#142235] p-3 text-sm">
        <button className={`${control} flex items-center gap-2`} onClick={showStation}><DoorOpen size={16} /> Interagir <kbd>E</kbd></button>
        <button className={control} onClick={goHome} aria-label="Retour au hall"><Compass size={16} /></button>
        <button className={`${control} flex items-center gap-1`} disabled={!cid} onClick={() => setPanel('chat')} aria-label="Chat">
          <MessageSquare size={16} />{invitations.length > 0 && <span className="text-cyan-200">{invitations.length}</span>}
        </button>
        <button className={control} disabled={!cid} onClick={() => send({ type: 'status', value: own?.status === 'help' ? '' : 'help' })}>Besoin d’aide</button>
        <button className={control} disabled={!cid} onClick={() => send({ type: 'status', value: own?.status === 'done' ? '' : 'done' })}>J’ai terminé</button>
        {staff && <button className={control} onClick={() => setPanel('staff')}>Gestion</button>}
        <span className="ml-auto hidden text-xs text-slate-400 md:block">ZQSD · WASD · flèches · clic · M plan · T hall · 1–6 emotes</span>
      </footer>
      <dialog ref={dialog} aria-labelledby="campus-dialog-title" onCancel={e => { e.preventDefault(); setPanel(undefined); }} className="m-auto max-h-[85dvh] w-[min(92vw,40rem)] overflow-auto rounded-xl border border-slate-600 bg-[#17273c] p-5 text-slate-100 backdrop:bg-slate-950/70">
        {panel && <>
          <header className="mb-4 flex items-center justify-between gap-3">
            <h2 id="campus-dialog-title" className="text-lg font-bold">{panel === 'station' ? room?.name ?? 'Hall principal' : headings[panel]}</h2>
            <button className={control} onClick={() => setPanel(undefined)}>Fermer</button>
          </header>
          {panel === 'plan' && data && <>
            <Plan map={data.map} players={players} />
            <ul className="mt-3 grid grid-cols-2 gap-1 text-sm text-slate-300">{data.map.rooms.map(r => <li key={r.id}>
              <button className={`${control} w-full text-left`} disabled={!own || (!staff && (r.id === 'staff' || policy.closed.includes(r.id)))} onClick={() => {
                game.current?.goTo({ x: r.station[0], y: r.station[1] + 1 });
                setPanel(undefined);
              }}>{r.name}</button>
            </li>)}</ul>
          </>}
          {panel === 'progress' && <>
            {cid && !staff && <p className="mb-3 text-sm">Niveau {level} · {xp} XP · {activity.completed.length} mission(s) validée(s) dans cette classe</p>}
            <LearningProgress />
          </>}
          {panel === 'missions' && <>
            {!activity.missions.length && <p>Aucune mission disponible dans cette classe.</p>}
            <ul className="grid gap-2">{activity.missions.map(mission => {
              const target = data?.map.rooms.find(r => r.id === mission.room);
              return <li key={mission.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700 pb-2 text-sm">
                <span>{mission.title}{activity.completed.includes(mission.id) ? ' · Validée' : ''}</span>
                {target && <button className={control} disabled={!own || policy.closed.includes(target.id)} onClick={() => {
                  game.current?.goTo({ x: target.station[0], y: target.station[1] + 1 });
                  setPanel(undefined);
                }}>{target.name}</button>}
              </li>;
            })}</ul>
          </>}
          {panel === 'settings' && <div className="grid gap-4">
            <div className="flex flex-wrap gap-2">{colors.map((fill, index) => <button key={fill} aria-label={`Tenue ${index + 1}`} aria-pressed={avatar.color === index}
              disabled={!avatar.unlocked.includes(index)} className={`${control} min-w-10`} onClick={() => void chooseColor(index)}
              ><span className="block h-4 w-4 rounded" style={{ background: fill }} /></button>)}</div>
            <p className="text-xs text-slate-300">Trois tenues supplémentaires se débloquent en validant des missions.</p>
            <label className="flex items-center gap-3">Zoom <input type="range" min="0.8" max="2.1" step="0.05" value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label>
            <label><input type="checkbox" checked={reduced} onChange={e => setReduced(e.target.checked)} /> Réduire les animations</label>
            <label><input type="checkbox" checked={economy} onChange={e => {
              setEconomy(e.target.checked);
              localStorage.setItem('campus-economy', e.target.checked ? 'on' : 'off');
            }} /> Mode graphique économique (30 images/s)</label>
            <div className="flex flex-wrap gap-2">{['👋', '👍', '💡', '🎉', '❓', '☕'].map((value, index) => <button key={value} className={control} disabled={!cid}
              aria-label={`Emote ${index + 1}`} onClick={() => { send({ type: 'emote', value: index + 1 }); setPanel(undefined); }}>{value}</button>)}</div>
          </div>}
          {panel === 'chat' && <>
            {invitations.map(invitation => <div key={invitation.token} className="mb-2 flex flex-wrap items-center gap-2 text-sm">
              {invitation.name} vous invite sur « {invitation.title} ».
              <button className={control} onClick={() => void joinProject(invitation)}>Rejoindre</button>
              <button className={control} onClick={() => setInvitations(previous => previous.filter(item => item.token !== invitation.token))}>Refuser</button>
            </div>)}
            <div className="mb-3 max-h-60 overflow-auto text-sm" role="log">{chat.map((line, index) =>
              <p key={index} className="break-words border-b border-slate-700 py-1"><b>{line.name}</b> · {line.channel === 'nearby' ? 'Proximité' : line.channel === 'room' ? 'Salle' : line.channel === 'announcement' ? 'Annonce' : 'Classe'} · {line.text}</p>)}</div>
            {policy.muted && <p className="mb-2 text-sm text-amber-200">Un enseignant a suspendu l’envoi de vos messages.</p>}
            <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (!policy.muted && message.trim()) { send({ type: 'chat', channel, value: message }); setMessage(''); } }}>
              <select className={control} aria-label="Canal" value={channel} onChange={e => setChannel(e.target.value)}>
                <option value="class">Classe</option><option value="nearby">Proximité</option><option value="room">Salle</option>{staff && <option value="announcement">Annonce</option>}
              </select>
              <input ref={chatField} className={`${control} min-w-28 flex-1`} aria-label="Message" value={message} maxLength={280} onChange={e => setMessage(e.target.value)} />
              <button className={control} disabled={connection !== 'En ligne' || policy.muted}>Envoyer</button>
            </form>
          </>}
          {panel === 'station' && <>
            <p className="mb-3 text-sm text-slate-300">{room?.topic ?? 'Explorez les salles et approchez-vous des postes pédagogiques.'}</p>
            {guide && <button className={control} onClick={() => setPanel('guide')}>Parler à {guide.name}</button>}
            {(!room || room.id === 'lecture' || room.id === 'support') && activity.announcements.map((announcement, index) => <p className="mt-3 flex gap-2 text-sm" key={index}><Radio size={16} />{announcement}</p>)}
            {room?.id === 'collaboration' && <>
              {projects.length > 0 && <form className="mt-3 flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void invite(); }}>
                <select className={control} aria-label="Projet cloud" value={projectId} onChange={e => setProjectId(e.target.value)}>
                  <option value="">Choisir un projet</option>
                  {projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}
                </select>
                <select className={control} aria-label="Destinataire" value={recipient} onChange={e => setRecipient(e.target.value)}>
                  <option value="">Choisir un participant</option>
                  {players.filter(p => p.id !== me.id).map(p => <option value={p.id} key={p.id}>{p.name}</option>)}
                </select>
                <button className={control} disabled={!projectId || !recipient || policy.muted}>Inviter au projet</button>
              </form>}
              {projectId && <button className={`${control} mt-3`} onClick={() => void startCollab(projectId).then(id => setUi({ active: id })).catch(() => toast('Projet indisponible.', 'error'))}>Ouvrir ma session</button>}
              {!projects.length && <button className={`${control} mt-3`} onClick={() => { exit(); setUi({ page: 'home' }); }}>Ouvrir mes projets</button>}
            </>}
            {room?.id === 'lecture' && <section className="mt-3 grid gap-3">
              {slide ? <article className="rounded-lg border border-cyan-700 bg-slate-900 p-3" aria-live="polite">
                <p className="text-xs text-cyan-200">{slide.title} · {slide.index + 1}/{slide.total}</p>
                <h3 className="my-2 font-semibold">{slide.lesson.title}</h3>
                <p className="whitespace-pre-wrap text-sm">{slide.lesson.body}</p>
                {slide.lesson.takeaway && <p className="mt-2 text-sm text-amber-200">{slide.lesson.takeaway}</p>}
              </article> : <p className="text-sm text-slate-300">Aucun cours collectif en cours.</p>}
              {staff && (slide ? <div className="flex flex-wrap gap-2">
                <button className={control} disabled={slide.index === 0} onClick={() => void present(slide.course_id, slide.index - 1)}>Leçon précédente</button>
                <button className={control} disabled={slide.index + 1 === slide.total} onClick={() => void present(slide.course_id, slide.index + 1)}>Leçon suivante</button>
                <button className={control} onClick={() => void present(null)}>Terminer le cours</button>
              </div> : <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (courseId) void present(courseId); }}>
                <select className={control} aria-label="Cours à présenter" value={courseId} onChange={e => setCourseId(e.target.value)}>
                  <option value="">Choisir un cours</option>
                  {courseOptions.map(course => <option value={course.id} key={course.id}>{course.title}</option>)}
                </select>
                <button className={control} disabled={!courseId}>Présenter à la classe</button>
              </form>)}
              <button className={`${control} justify-self-start`} onClick={() => { exit(); setUi({ page: 'courses' }); }}>Ouvrir les cours de l’Académie</button>
            </section>}
            {room && !missions.length && <p className="mt-3 text-sm text-slate-300">Aucune mission affectée à ce poste.</p>}
            {missions.map(m => <article className="mt-3 border-t border-slate-600 pt-3" key={m.id}>
              <h3 className="font-semibold">{m.title}</h3>
              {activity.completed.includes(m.id) && <p className="text-sm text-emerald-300">Mission validée · 100 XP</p>}
              {m.statement && <p className="my-2 whitespace-pre-wrap text-sm text-slate-300">{m.statement}</p>}
              {m.exam && m.duration_min && <p className="my-2 text-sm">{m.duration_min} min</p>}
              {!staff && <button disabled={pending} className={control} onClick={() => void open(m)}>Ouvrir dans le simulateur</button>}
            </article>)}
          </>}
          {panel === 'guide' && guide && <div className="grid gap-3">
            <p className="font-semibold text-amber-200">{guide.name} · {guide.role}</p>
            {activity.missions.some(m => m.room === room?.id && activity.completed.includes(m.id)) && <p className="text-sm text-emerald-200">J’ai vu votre résultat. Bien joué, la mission est validée.</p>}
            {guide.hints.slice(0, hint + 1).map(line => <p key={line} className="text-sm">{line}</p>)}
            {hint + 1 < guide.hints.length && <button className={`${control} justify-self-start`} onClick={() => setHint(hint + 1)}>Demander un autre indice</button>}
          </div>}
          {panel === 'staff' && staff && <>
            <button className={control} onClick={() => { exit(); setUi({ page: 'teacher' }); }}>Ouvrir l’espace professeur</button>
            <h3 className="mt-4 font-semibold">Présences</h3>
            <ul className="mb-4 text-sm">{players.map(p => <li key={p.id} className="mt-1 flex flex-wrap items-center gap-2">
              <span>{p.name} · {data && roomAt(data.map, p)?.name || 'Hall'}{p.status === 'help' ? ' · Demande d’aide' : p.status === 'done' ? ' · Terminé' : p.status === 'working' ? ' · Simulateur' : ''}</span>
              {(p.status === 'help' || p.status === 'done') && <button className={control} onClick={() => send({ type: 'moderate', value: p.id })}>Marquer comme traité</button>}
              {!p.staff && <button className={control} onClick={() => void setRule(`chat/${p.id}/muted`, !activity.muted.includes(p.id))}>{activity.muted.includes(p.id) ? 'Rétablir le chat' : 'Suspendre le chat'}</button>}
            </li>)}</ul>
            <details className="mb-4">
              <summary className="cursor-pointer font-semibold">Accès aux salles</summary>
              <div className="mt-2 grid gap-1 sm:grid-cols-2">{data?.map.rooms.filter(r => r.id !== 'staff').map(r => <label key={r.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={!activity.closed.includes(r.id)} onChange={e => void setRule(`rooms/${r.id}/closed`, !e.target.checked)} /> {r.name}
              </label>)}</div>
            </details>
            <h3 className="mt-4 font-semibold">Missions prêtes à affecter</h3>
            <ul className="text-sm">{activity.templates.map(item => <li className="mt-2 flex items-center justify-between gap-2" key={item.id}>
              {item.title}
              {activity.missions.some(m => m.template === item.id) ? <span>Installée</span> :
                <button className={control} disabled={!!installing} onClick={() => void install(item.id)}>Installer</button>}
            </li>)}</ul>
            <h3 className="font-semibold">Affectation aux postes</h3>
            <ul className="text-sm">{activity.missions.map(m => <li className="mt-2 flex flex-wrap items-center justify-between gap-2" key={m.id}>
              {m.title}
              {m.exam ? <span>Salle d’examen</span> : <select aria-label={`Salle pour ${m.title}`} className={control} value={m.room ?? ''} onChange={e => void place(m.id, e.target.value)}>
                <option value="">Académie uniquement</option>
                {data?.map.rooms.filter(r => r.id !== 'staff' && r.id !== 'exam').map(r => <option value={r.id} key={r.id}>{r.name}</option>)}
              </select>}
              {!m.exam && m.kind === 'incident' && m.room && m.opens_at && Date.parse(m.opens_at) > Date.now() &&
                <button className={control} onClick={() => void dispatch(m)}>Déclencher</button>}
              <button className={control} onClick={() => void exportResults(m)}>Exporter CSV</button>
            </li>)}</ul>
          </>}
        </>}
      </dialog>
    </main>
  );
}

function Plan({ map, players, small = false }: { map: CampusMap; players: Player[]; small?: boolean }) {
  return <svg viewBox={`0 0 ${map.grid[0]!.length} ${map.grid.length}`} className={small ? 'w-28' : 'mx-auto max-h-64 w-full'} role="img" aria-label="Plan et position des joueurs">
    <rect width="100%" height="100%" fill="#0e1827" />
    <rect x={23} y={1} width={9} height={map.grid.length - 2} fill="#526b80" />
    {map.rooms.map(r => <g key={r.id}><rect x={r.x} y={r.y} width={r.w} height={r.h} rx={0.4} fill={r.id === 'staff' ? '#39435c' : '#3c6579'} stroke="#819cb2" strokeWidth={0.15} />
      {!small && <text x={r.x + r.w / 2} y={r.y + 3.4} fontSize={1.35} textAnchor="middle" fill="#e3f3f7">{r.name}</text>}
    </g>)}
    {players.map(p => <circle cx={p.x + 0.5} cy={p.y + 0.5} r={small ? 1.1 : 0.65} fill={colors[p.color]} stroke="#101a2a" strokeWidth={0.2} key={p.id} />)}
  </svg>;
}
