/* =============================================================
   sync.js — Cross-device sync for Bubble (anger app)
   Local-first + Supabase mirror.  See Handoff SYSTEM 1.
   Lessons applied: 1 (smart merge), 2 (PIN excluded), 4, 5, 18.
============================================================= */

/* ---- CONFIGURED for Adelyn's household ---- */
const SUPABASE_URL      = 'https://jebmqawjduoqjtrsijql.supabase.co'; // base URL, NO /rest/v1
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplYm1xYXdqZHVvcWp0cnNpanFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk1OTE2NTcsImV4cCI6MjA5NTE2NzY1N30.ZaYDSNfrajzShuhEnt6CDiy6GvjqvEWPAmp4yyRDk2U';
const FAMILY_ID         = 'adelyn-household';                     // unique per family; same ID = shared data
/* ------------------------------------------------------------ */

const DATA_KEY = 'bubble-app-data';   // main state localStorage key

const Sync = (() => {
  let pushTimer = null;
  let pollTimer = null;
  let online = true;

  const headers = () => ({
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  });

  /* ---- LOCAL ---- */
  function loadLocal(){
    try{
      const raw = localStorage.getItem(DATA_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ console.warn('loadLocal failed', e); return null; }
  }
  function saveLocal(stateObj){
    try{ localStorage.setItem(DATA_KEY, JSON.stringify(stateObj)); }
    catch(e){ console.warn('saveLocal failed', e); }
  }

  /* ---- CLOUD ---- */
  async function pull(){
    if(!configured()) return null;
    try{
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/app_data?id=eq.${encodeURIComponent(FAMILY_ID)}&select=*`,
        { headers: headers() });
      if(!res.ok){
        const txt = await res.text();
        console.error('[SYNC] pull failed — HTTP '+res.status+' — '+txt);
        throw new Error('pull HTTP '+res.status);
      }
      const rows = await res.json();          // Lesson 5: may be [] if row doesn't exist yet
      online = true;
      console.log('[SYNC] pull ok — '+(rows.length?'found data':'no row yet'));
      return rows.length ? rows[0].data : null;
    }catch(e){ online = false; console.error('[SYNC] pull error', e); return null; }
  }

  async function push(stateObj){
    if(!configured()) return;
    try{
      const body = [{ id: FAMILY_ID, data: stateObj, updated_at: new Date().toISOString() }];
      // upsert: on_conflict tells Supabase which column decides a duplicate
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/app_data?on_conflict=id`, {
        method: 'POST',
        headers: { ...headers(),
          'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(body),
      });
      if(!res.ok){
        const txt = await res.text();
        console.error('[SYNC] push failed — HTTP '+res.status+' — '+txt);
        throw new Error('push HTTP '+res.status);
      }
      online = true;
      console.log('[SYNC] push ok — saved to cloud');
    }catch(e){ online = false; console.error('[SYNC] push error', e); }
  }

  function configured(){
    return !SUPABASE_URL.includes('YOUR-PROJECT-REF')
        && !SUPABASE_ANON_KEY.includes('YOUR-ANON');
  }

  /* ---- LESSON 1: smart merge, never blind overwrite ---- */
  function merge(localS, cloudS){
    if(!cloudS) return localS;
    if(!localS) return cloudS;

    const localNewer = (localS._localUpdatedAt||0) >= (cloudS._localUpdatedAt||0);
    const newer = localNewer ? localS : cloudS;
    const older = localNewer ? cloudS : localS;

    const out = { ...older, ...newer };  // start from newer for scalars/settings

    // logs / event history: union, dedupe by composite key
    out.log = dedupeLog([...(localS.log||[]), ...(cloudS.log||[])]);

    // lifetime total: never decreases -> MAX
    out.totalPoints = Math.max(localS.totalPoints||0, cloudS.totalPoints||0);

    // last app-opened timestamp: take the MAX across devices.
    // Used by the push cron to skip notifications when she just used the app.
    out.lastAppOpenedAt = Math.max(localS.lastAppOpenedAt||0, cloudS.lastAppOpenedAt||0);

    // current spendable points: from the MORE RECENTLY UPDATED device
    out.points = newer.points != null ? newer.points : (older.points||0);

    // custom user content: union, deduped (never lose what the child wrote)
    out.customMantras = unionStrings(localS.customMantras, cloudS.customMantras);
    out.customVerses  = unionStrings(localS.customVerses,  cloudS.customVerses);
    out.parentNotes   = dedupeNotes([...(localS.parentNotes||[]), ...(cloudS.parentNotes||[])]);

    // gratitudes: union by ts (each entry is unique-per-write)
    {
      const all = [...(localS.gratitudes||[]), ...(cloudS.gratitudes||[])];
      const seen = new Set();
      out.gratitudes = all.filter(g => {
        const k = (g.ts||'') + '|' + (g.type||'') + '|' + (g.text||'');
        if(seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a,b)=>(b.ts||0)-(a.ts||0));
    }

    // tellBubbles: union by ts + path + text
    {
      const all = [...(localS.tellBubbles||[]), ...(cloudS.tellBubbles||[])];
      const seen = new Set();
      out.tellBubbles = all.filter(t => {
        const k = (t.ts||'') + '|' + (t.path||'') + '|' + (t.text||'');
        if(seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a,b)=>(b.ts||0)-(a.ts||0));
    }

    // detectiveEntries: union by ts
    {
      const all = [...(localS.detectiveEntries||[]), ...(cloudS.detectiveEntries||[])];
      const seen = new Set();
      out.detectiveEntries = all.filter(d => {
        const k = (d.ts||'');
        if(seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a,b)=>(b.ts||0)-(a.ts||0));
    }

    // friendEntries, repairEntries, afterStormEntries, moodCheckIns: union by ts
    for(const field of ['friendEntries','repairEntries','afterStormEntries','moodCheckIns']){
      const all = [...(localS[field]||[]), ...(cloudS[field]||[])];
      const seen = new Set();
      out[field] = all.filter(e => {
        const k = (e.ts||'');
        if(seen.has(k)) return false;
        seen.add(k); return true;
      }).sort((a,b)=>(b.ts||0)-(a.ts||0));
    }
    // lastMoodCheckIn: take max
    out.lastMoodCheckIn = Math.max(localS.lastMoodCheckIn||0, cloudS.lastMoodCheckIn||0);

    // unlocked items: union — once unlocked, stays unlocked
    out.owned = { ...(localS.owned||{}), ...(cloudS.owned||{}) };

    // settings / pointsConfig: from newer side
    out.pointsConfig = newer.pointsConfig || older.pointsConfig;
    out.monsterName  = newer.monsterName  || older.monsterName;

    // lastReportDate: take the later one
    out.lastReportDate = Math.max(localS.lastReportDate||0, cloudS.lastReportDate||0);

    out._localUpdatedAt = Math.max(localS._localUpdatedAt||0, cloudS._localUpdatedAt||0);
    return out;
  }

  function dedupeLog(list){
    const seen = new Map(), out = [];
    for(const e of list){
      const key = (e.ts||e.date||'') + '|' + (e.door||e.type||'') + '|' + (e.result||e.title||'');
      if(seen.has(key)){
        // merge parent notes (and notes/doover) from this duplicate into the kept one
        const kept = seen.get(key);
        const incoming = (e.parentNotes||[]);
        const existing = (kept.parentNotes||[]);
        const noteKey = n => (n.ts||'') + '|' + (n.text||'');
        const all = [...existing, ...incoming];
        const seenNotes = new Set();
        kept.parentNotes = all.filter(n => {
          const k = noteKey(n);
          if(seenNotes.has(k)) return false;
          seenNotes.add(k); return true;
        });
        // prefer non-empty notes/doover if one side has them and the other doesn't
        if(!kept.notes && e.notes) kept.notes = e.notes;
        if(!kept.doover && e.doover) kept.doover = e.doover;
        continue;
      }
      seen.set(key, e); out.push(e);
    }
    return out.sort((a,b)=>(b.ts||0)-(a.ts||0));
  }
  function dedupeNotes(list){
    const seen = new Set(), out = [];
    for(const n of list){
      const key = (n.ts||'')+'|'+(n.text||'');
      if(seen.has(key)) continue;
      seen.add(key); out.push(n);
    }
    return out.sort((a,b)=>(b.ts||0)-(a.ts||0));
  }
  function unionStrings(a,b){
    return [...new Set([...(a||[]), ...(b||[])])];
  }

  /* ---- public: schedule a debounced push (Lesson 18) ---- */
  function schedulePush(stateObj){
    saveLocal(stateObj);                       // local-first: instant
    clearTimeout(pushTimer);
    pushTimer = setTimeout(()=>push(stateObj), 1500);  // debounce ~1.5s
  }

  /* ---- public: start polling (15s + on focus) ---- */
  function startPolling(onRemoteUpdate){
    async function tick(){
      const cloud = await pull();
      if(cloud) onRemoteUpdate(cloud);
    }
    clearInterval(pollTimer);
    pollTimer = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', ()=>{
      if(document.visibilityState === 'visible') tick();
    });
    tick(); // initial
  }

  return { loadLocal, saveLocal, pull, push, merge, schedulePush, startPolling,
           configured, isOnline: ()=>online };
})();
