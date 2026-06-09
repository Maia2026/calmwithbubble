/* =============================================================
   app.js — Bubble (Adelyn's anger app)
   Core loop + points + PIN parent zone + therapist reports.
   Built on the Core Systems Handoff. Lessons applied throughout.
============================================================= */

/* ====== LESSON 9: declare config constants BEFORE state ====== */
const DEFAULT_POINTS_CONFIG = {
  reflectPts: 1,        // after-the-fact reflection
  duringPts: 2,         // used the app while angry
  warningPts: 3,        // caught a warning sign before anger
  bravePts: 3,          // took a brave step
  reflectBonusPts: 1,   // bonus for a thoughtful, complete reflection
  reflectDailyCap: 10,  // Lesson 6: cap low-stakes after-the-fact logging
  weeklyMultiplier: 1.0,// Lesson 7: parent raises this as Adelyn progresses
};

const MONSTER_SIZES = [150,134,118,104,90,76,62];

/* ====== PIN store — Lesson 2 & 10: its OWN localStorage key ====== */
const PIN_STORE = {
  KEY: 'bubble-parent-pin',
  get(){ return localStorage.getItem(this.KEY); },
  set(p){ localStorage.setItem(this.KEY, p); },
  has(){ return !!localStorage.getItem(this.KEY); },
};
const DEFAULT_PIN = '1234';   // parent changes this in settings

/* ====== single source of truth: state + save (Lesson 18) ====== */
let state = null;

function freshState(){
  return {
    points: 0,
    totalPoints: 0,
    monsterShrink: 0,
    monsterName: 'Grumble',
    buddyNamed: true,         // buddy is "Bubble" by default
    pointsConfig: { ...DEFAULT_POINTS_CONFIG },
    log: [],
    owned: {},
    wearing: null,            // currently equipped accessory id
    rewards: [               // parent-defined real-world rewards
      { id:'r1', name:'15 min extra screen time', cost:20 },
      { id:'r2', name:'Pick dinner',              cost:40 },
      { id:'r3', name:'Special outing with Mom or Dad', cost:100 },
    ],
    pendingClaims: [],        // {claimId, rewardId, name, cost, ts} awaiting parent approval
    earnedRewards: [],        // {rewardId, name, ts} for history
    gratitudes: [],           // {ts, text, chip, type:'gratitude'|'faith'} entries
    therapistEmail: '',       // parent-saved address for emailing reports
    tellBubbles: [],          // {ts, path, text, controlled, type:'tellbubble'} entries
    detectiveEntries: [],     // {ts, isPerson, answers:{q1..q5: text}, engagedCount} entries
    lastAppOpenedAt: 0,       // ms timestamp of most recent app open — used by Stage 2 push cron
    customMantras: [],
    customVerses: [],
    parentNotes: [],
    lastReportDate: 0,
    reflectCountByDay: {},    // 'YYYY-MM-DD' -> points earned via reflection that day
    usedDays: {},             // 'YYYY-MM-DD' -> true, for usage stats + streak
    streakCount: 0,           // consecutive-day streak
    lastUseDay: '',           // last day the app was used (YYYY-MM-DD)
    _localUpdatedAt: 0,
  };
}

/* LESSON 8: migrate older state — patch in any missing fields */
function migrate(s){
  if(!s) return freshState();
  const base = freshState();
  for(const k in base){ if(s[k] == null) s[k] = base[k]; }
  if(!s.pointsConfig) s.pointsConfig = { ...DEFAULT_POINTS_CONFIG };
  for(const k in DEFAULT_POINTS_CONFIG){
    if(s.pointsConfig[k] == null) s.pointsConfig[k] = DEFAULT_POINTS_CONFIG[k];
  }
  return s;
}

function save(){
  state._localUpdatedAt = Date.now();   // stamp for merge (Lesson 1)
  Sync.schedulePush(state);             // local-first + debounced cloud push
}

/* ====== LESSON 14: escape user input into HTML / attributes ====== */
function escapeHtml(str){
  return String(str==null?'':str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escapeAttr(str){ return escapeHtml(str).replace(/`/g,'&#96;'); }

/* ====== SYSTEM 2: points — single calcPoints function ====== */
/* Lesson 6: branches on session.mode so easy logging can't out-earn live effort */
function calcPoints(session){
  const c = state.pointsConfig;
  let pts = 0;
  if(session.mode === 'reflect'){
    pts = c.reflectPts + (session.thoughtful ? c.reflectBonusPts : 0);
    pts = applyReflectCap(pts);            // Lesson 6 daily cap
  } else if(session.mode === 'during'){
    pts = c.duringPts;
  } else if(session.mode === 'warning'){
    pts = c.warningPts;
  } else if(session.mode === 'brave'){
    pts = c.bravePts;
  }
  pts = Math.round(pts * (c.weeklyMultiplier || 1));
  return Math.max(0, pts);
}
function todayKey(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function applyReflectCap(want){
  const k = todayKey();
  const used = state.reflectCountByDay[k] || 0;
  const room = Math.max(0, state.pointsConfig.reflectDailyCap - used);
  const granted = Math.min(want, room);
  state.reflectCountByDay[k] = used + granted;
  return granted;
}

/* award points from a finished session */
function awardPoints(session){
  const pts = calcPoints(session);
  state.points += pts;
  state.totalPoints += pts;              // lifetime — never decreases (Lesson 1)
  return pts;
}

/* ====== STREAK + USAGE STATS (mirrors Blob Battle) ====== */
function dayKeyOffset(daysAgo){
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
/* call once per completed moment — records the day and updates the streak */
function recordUsageDay(){
  const today = todayKey();
  if(!state.usedDays) state.usedDays = {};
  state.usedDays[today] = true;

  if(state.lastUseDay === today){
    // already counted today — streak unchanged
  } else if(state.lastUseDay === dayKeyOffset(1)){
    state.streakCount = (state.streakCount || 0) + 1;   // consecutive day
  } else {
    state.streakCount = 1;                              // first day, or streak broke
  }
  state.lastUseDay = today;
}
/* if the streak's last day is older than yesterday, it has lapsed -> show 0 */
function currentStreak(){
  if(!state.lastUseDay) return 0;
  if(state.lastUseDay === todayKey() || state.lastUseDay === dayKeyOffset(1)){
    return state.streakCount || 0;
  }
  return 0;
}
/* count moments logged today / this week / all-time */
function usageCounts(){
  const today = todayKey();
  const weekKeys = [0,1,2,3,4,5,6].map(dayKeyOffset);
  let day=0, week=0;
  for(const e of (state.log||[])){
    const k = e.ts ? dayKeyFromTs(e.ts) : '';
    if(k === today) day++;
    if(weekKeys.includes(k)) week++;
  }
  return { day, week, all: (state.log||[]).length };
}
function dayKeyFromTs(ts){
  const d = new Date(ts);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}

/* ====== LESSON 3: wall-clock timer — start vs render are separate ====== */
const Timer = {
  startMs: 0, durationS: 0, intervalId: null, onTick: null, onDone: null,
  start(durationS, onTick, onDone){
    this.startMs = Date.now();           // wall-clock timestamp
    this.durationS = durationS;
    this.onTick = onTick; this.onDone = onDone;
    clearInterval(this.intervalId);
    this.intervalId = setInterval(()=>this._tick(), 250);
    this._tick();
  },
  _tick(){
    const elapsed = (Date.now() - this.startMs) / 1000;
    const remain = Math.max(0, Math.ceil(this.durationS - elapsed));
    if(this.onTick) this.onTick(remain, this.durationS);
    if(remain <= 0){ clearInterval(this.intervalId); if(this.onDone) this.onDone(); }
  },
  remaining(){
    const elapsed = (Date.now() - this.startMs) / 1000;
    return Math.max(0, Math.ceil(this.durationS - elapsed));
  },
  stop(){ clearInterval(this.intervalId); },
};

/* ====== SYSTEM 4: therapist report generator ====== */
function timeBucket(ts){                 // Lesson 12
  const h = new Date(ts).getHours();
  if(h < 6)  return 'Night';
  if(h < 12) return 'Morning';
  if(h < 17) return 'Afternoon';
  if(h < 21) return 'Evening';
  return 'Night';
}
function rangeStart(kind){
  const now = Date.now(), d = new Date();
  if(kind === 'week'){ d.setDate(d.getDate()-7);  return d.getTime(); }
  if(kind === 'month'){ d.setMonth(d.getMonth()-1); return d.getTime(); }
  if(kind === 'since') return state.lastReportDate || 0;
  return 0; // all time
}
function buildReport(kind){
  const start = rangeStart(kind);
  const events = state.log.filter(e => (e.ts||0) >= start)
                          .sort((a,b)=>(a.ts||0)-(b.ts||0));
  const doorName = { before:'Caught warning sign', during:'Used app while angry',
                     after:'Reflected afterward', brave:'Brave step' };
  // counts
  const byDoor = {}, byBucket = {}, byTool = {}, bySetoff = {}, byNextPlan = {};
  let drops = 0, dropTotal = 0, reflectUsedYes = 0, reflectUsedNo = 0;
  let multiToolMoments = 0, grownUpRequests = 0;
  for(const e of events){
    byDoor[e.door] = (byDoor[e.door]||0)+1;
    byBucket[timeBucket(e.ts)] = (byBucket[timeBucket(e.ts)]||0)+1;
    if(e.tool){
      // tool may be "A → B → C" (multiple tools used in one moment); count each
      e.tool.split(/\s*→\s*/).filter(Boolean).forEach(t => {
        byTool[t] = (byTool[t]||0)+1;
      });
    }
    if(e.toolsCount && e.toolsCount > 1) multiToolMoments++;
    if(e.gotGrownUp) grownUpRequests++;
    if(e.setoff) bySetoff[e.setoff] = (bySetoff[e.setoff]||0)+1;
    if(e.nextTimeTool) byNextPlan[e.nextTimeTool] = (byNextPlan[e.nextTimeTool]||0)+1;
    if(e.door==='after' && e.usedCoping===true) reflectUsedYes++;
    if(e.door==='after' && e.usedCoping===false) reflectUsedNo++;
    if(e.rateBefore!=null && e.rateAfter!=null){
      drops++; dropTotal += (e.rateBefore - e.rateAfter);
    }
  }
  const avgDrop = drops ? (dropTotal/drops).toFixed(1) : '—';
  const label = { week:'This Week', month:'This Month', since:'Since Last Report', all:'All Time' }[kind];

  const rows = events.map(e => {
    const when = new Date(e.ts).toLocaleString();
    const ba = (e.rateBefore!=null&&e.rateAfter!=null) ? `${e.rateBefore} → ${e.rateAfter}` : '—';
    return `<tr><td>${escapeHtml(when)}</td><td>${escapeHtml(doorName[e.door]||e.door)}</td>
      <td>${escapeHtml(e.setoff||e.title||'—')}</td>
      <td>${escapeHtml(e.thought||'—')}</td>
      <td>${escapeHtml(e.tool||'—')}</td><td>${ba}</td>
      <td>${escapeHtml(e.notes||'—')}</td></tr>`;
  }).join('');

  // Adelyn's own notes, gathered for a dedicated section
  const noteList = events.filter(e=>e.notes && e.notes.trim())
    .map(e=>`<tr><td>${escapeHtml(new Date(e.ts).toLocaleString())}</td>
      <td>${escapeHtml(e.setoff||e.title||'—')}</td>
      <td>${escapeHtml(e.notes)}</td></tr>`).join('');

  // Parent notes (added by you in the parent zone)
  const parentNoteRows = [];
  for(const e of events){
    if(e.parentNotes && e.parentNotes.length){
      for(const n of e.parentNotes){
        parentNoteRows.push(`<tr>
          <td>${escapeHtml(new Date(n.ts).toLocaleString())}</td>
          <td>${escapeHtml(e.setoff||e.title||'—')}<div style="font-size:11px;color:#666">moment from ${escapeHtml(new Date(e.ts).toLocaleString())}</div></td>
          <td>${escapeHtml(n.text)}</td></tr>`);
      }
    }
  }
  const parentNoteList = parentNoteRows.join('');

  const kv = obj => Object.entries(obj).sort((a,b)=>b[1]-a[1])
    .map(([k,v])=>`${escapeHtml(k)}: ${v}`).join(' · ') || '—';

  /* Lesson 13: sections built around what a clinician acts on; no repeated data */
  return `<!doctype html><html><head><meta charset="utf-8">
  <title>Bubble Report — Adelyn</title>
  <style>
    body{font-family:Arial,sans-serif;color:#222;max-width:760px;margin:24px auto;padding:0 16px;}
    h1{font-size:20px;} h2{font-size:15px;margin-top:22px;border-bottom:2px solid #8b3fb5;padding-bottom:4px;}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;}
    th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;vertical-align:top;}
    th{background:#f0e7f7;}
    .muted{color:#666;font-size:12px;}
    @media print{ button{display:none;} }
  </style></head><body>
    <h1>Bubble — Home Tracking Report</h1>
    <div class="muted">Child: Adelyn &nbsp;·&nbsp; Period: ${escapeHtml(label)}
      &nbsp;·&nbsp; Generated: ${escapeHtml(new Date().toLocaleString())}</div>

    <h2>Summary</h2>
    <p>${events.length} moment(s) logged. Average feeling change after using a skill:
       <b>${avgDrop}</b> points (on a 0–10 scale).</p>

    <h2>How Adelyn used the app</h2>
    <p>${kv(Object.fromEntries(Object.entries(byDoor).map(([k,v])=>[doorName[k]||k,v])))}</p>

    <h2>What set anger off</h2>
    <p>${kv(bySetoff)}</p>

    <h2>Coping tools used</h2>
    <p>${kv(byTool)}</p>
    ${multiToolMoments?`<p>In <b>${multiToolMoments}</b> moment(s), Adelyn used more than one tool back-to-back — meaning she stuck with it when the first tool was not enough.</p>`:''}
    ${grownUpRequests?`<p>In <b>${grownUpRequests}</b> moment(s), she chose to find a grown-up after multiple tools — a healthy choice to ask for human help.</p>`:''}

    <h2>Coping tool use during reflection</h2>
    <p>When looking back at a moment, Adelyn reported using a coping tool
       <b>${reflectUsedYes}</b> time(s), and not using one <b>${reflectUsedNo}</b> time(s).
       ${Object.keys(byNextPlan).length
         ? 'When she had not used a tool, her next-time plans were — '+kv(byNextPlan)+'.'
         : ''}</p>

    <h2>Time of day</h2>
    <p>${kv(byBucket)}</p>

    <h2>Adelyn's own notes</h2>
    ${noteList
      ? `<table><tr><th>When</th><th>Trigger</th><th>What Adelyn wrote</th></tr>${noteList}</table>`
      : '<p>No written notes in this period.</p>'}

    <h2>Sunshine — gratitude &amp; quiet moments</h2>
    <p style="font-size:12px;color:#666">The "Sunshine" section of the app, where Adelyn can either practice gratitude or tap "Remind me I am loved" for a comfort/identity message.</p>
    ${(()=>{
      const gs = (state.gratitudes||[]).filter(g => (g.ts||0) >= start)
        .sort((a,b)=>(b.ts||0)-(a.ts||0));
      if(!gs.length) return '<p>No gratitude entries in this period.</p>';
      const rows = gs.map(g => g.type==='faith'
        ? `<tr><td>${escapeHtml(new Date(g.ts).toLocaleString())}</td><td>Quiet moment 💛</td><td><i>Tapped "I need a reminder I'm loved" — viewed a comfort/identity message.</i></td></tr>`
        : `<tr><td>${escapeHtml(new Date(g.ts).toLocaleString())}</td><td>Gratitude 🌻</td><td>${escapeHtml(g.text||'')}</td></tr>`
      ).join('');
      return `<table><tr><th>When</th><th>Type</th><th>What Adelyn wrote / did</th></tr>${rows}</table>`;
    })()}

    <h2>Thought-detective investigations</h2>
    <p style="font-size:12px;color:#666">When Adelyn worked through a thought using the 5-question framework. Her own writing for each question is here — skipped questions are blank.</p>
    ${(()=>{
      const dets = (state.detectiveEntries||[]).filter(d => (d.ts||0) >= start)
        .sort((a,b)=>(b.ts||0)-(a.ts||0));
      if(!dets.length) return '<p>No detective investigations in this period.</p>';
      const qTitles = ['How big is it?','Is it true?','Is it bad?','Can she control it?','Comment or judgment?'];
      return dets.map(d => {
        const a = d.answers || {};
        const thoughtLine = d.thought ? `<p style="margin:4px 0;font-size:13px"><b>The thought:</b> "${escapeHtml(d.thought)}"</p>` : '';
        const personLine = `<p style="margin:4px 0;font-size:12px;color:#666">About a person: ${d.isPerson ? 'Yes' : 'No'} · Engaged: ${d.engagedCount||0} of ${d.isPerson===false?4:5} questions</p>`;
        const rows = qTitles.map((title,i) => {
          const q = i+1;
          if(q === 5 && d.isPerson === false) return '';   // Q5 was skipped by design
          const ans = a[q];
          return `<tr><td style="width:30%"><b>Q${q}.</b> ${escapeHtml(title)}</td>
            <td>${ans ? escapeHtml(ans) : '<i style="color:#999">(skipped)</i>'}</td></tr>`;
        }).join('');
        return `<div style="border:1px solid #ddd;border-radius:6px;padding:10px;margin-top:10px">
          <p style="margin:0;font-weight:bold">${escapeHtml(new Date(d.ts).toLocaleString())}</p>
          ${thoughtLine}
          ${personLine}
          <table style="margin-top:6px">${rows}</table>
        </div>`;
      }).join('');
    })()}

    <h2>What Adelyn told Bubble</h2>
    <p style="font-size:12px;color:#666">Times Adelyn came to Bubble to share something — what didn't work, friend troubles, or just venting. Includes what she identified as the part she controlled.</p>
    ${(()=>{
      const tbs = (state.tellBubbles||[]).filter(t => (t.ts||0) >= start)
        .sort((a,b)=>(b.ts||0)-(a.ts||0));
      if(!tbs.length) return '<p>No Tell-Bubble entries in this period.</p>';
      const pathName = { didntwork:"Something I tried didn't work", friend:"Trouble with a friend", else:"Something else" };
      const rows = tbs.map(t => {
        const ctrl = (t.controlled && t.controlled.length) ? t.controlled.join(', ') : '—';
        return `<tr>
          <td>${escapeHtml(new Date(t.ts).toLocaleString())}</td>
          <td>${escapeHtml(pathName[t.path]||t.path||'—')}</td>
          <td>${escapeHtml(t.text||'')}</td>
          <td>${escapeHtml(ctrl)}</td></tr>`;
      }).join('');
      return `<table><tr><th>When</th><th>What about</th><th>What Adelyn wrote</th><th>What she said she controlled</th></tr>${rows}</table>`;
    })()}

    <h2>Parent observations</h2>
    <p style="font-size:12px;color:#666">Context added by parent in the parent zone. Hidden from Adelyn.</p>
    ${parentNoteList
      ? `<table><tr><th>When added</th><th>About moment</th><th>Parent wrote</th></tr>${parentNoteList}</table>`
      : '<p>No parent notes in this period.</p>'}

    <h2>Thoughtful "do-overs" she planned</h2>
    <p style="font-size:12px;color:#666">After moments she labeled as impulsive (or partly so), Bubble prompted a gentle do-over — what the thoughtful version could have looked like next time.</p>
    ${(()=>{
      const doRows = events.filter(e=>e.doover && e.doover.trim()).map(e=>`<tr>
        <td>${escapeHtml(new Date(e.ts).toLocaleString())}</td>
        <td>${escapeHtml(e.setoff||e.title||'—')}</td>
        <td>${escapeHtml(e.doover)}</td></tr>`).join('');
      return doRows
        ? `<table><tr><th>When</th><th>Moment</th><th>Her do-over plan</th></tr>${doRows}</table>`
        : '<p>No do-overs in this period.</p>';
    })()}

    <h2>Full moment log — with trigger thoughts in context</h2>
    <table><tr><th>When</th><th>What she did</th><th>Trigger</th>
      <th>Thought</th><th>Tool</th><th>Feeling 0–10</th><th>Notes</th></tr>${rows||'<tr><td colspan="7">No moments in this period.</td></tr>'}</table>

    <p class="muted" style="margin-top:20px">This is home-tracked data entered by a child and parent.
       It is meant to support — not replace — clinical assessment. All values are self-reported
       in the moment unless noted as estimated.</p>
    <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
      <button onclick="window.print()" style="padding:10px 18px;font-size:15px;cursor:pointer">📄 Print / Save as PDF</button>
      <button onclick="window.__emailReport()" style="padding:10px 18px;font-size:15px;cursor:pointer;background:#8b3fb5;color:#fff;border:none;border-radius:6px">📧 Email to therapist</button>
      <button onclick="window.close()" style="padding:10px 18px;font-size:15px;cursor:pointer;margin-left:auto">✕ Close report</button>
    </div>
    <script>
      window.__emailReport = function(){
        var to = '__THERAPIST_EMAIL__';
        var subject = '__REPORT_SUBJECT__';
        var body = "Hi,\\n\\nHere is Adelyn's Bubble report for __REPORT_RANGE__.\\n\\nThe report is saved as a PDF — please see attached.\\n\\nThank you!";
        if(!to){ alert("No therapist email is saved yet. Add one in the parent zone (Settings)."); return; }
        var href = 'mailto:' + encodeURIComponent(to)
          + '?subject=' + encodeURIComponent(subject)
          + '&body=' + encodeURIComponent(body);
        window.location.href = href;
      };
    </script>
  </body></html>`;
}
function openReport(kind){
  let html = buildReport(kind);
  state.lastReportDate = Date.now();     // System 4: "since last report" tracking
  save();
  // Substitute the saved therapist email and a specific subject into the report HTML
  const rangeLabel = { week:'This Week', month:'This Month',
                       since:'Since Last Report', all:'All Time' }[kind] || 'All Time';
  const today = new Date().toLocaleDateString();
  const subject = `Adelyn's Bubble Report — ${rangeLabel} (${today})`;
  const therapistEmail = (state.therapistEmail || '').trim();
  html = html
    .replace('__THERAPIST_EMAIL__', therapistEmail.replace(/'/g, "\\'"))
    .replace('__REPORT_SUBJECT__', subject.replace(/'/g, "\\'"))
    .replace('__REPORT_RANGE__', rangeLabel.replace(/'/g, "\\'"));
  const w = window.open('', '_blank');
  if(w){ w.document.write(html); w.document.close(); }
  else { alert('Please allow pop-ups to view the report.'); }
}

/* =============================================================
   PUSH NOTIFICATIONS — per-device opt-in, stored on Supabase.
   Stage 1: subscribe/unsubscribe only. Actual sending in Stage 2.
============================================================= */

/* VAPID public key — embedded, safe to share (private key lives in Supabase secrets) */
const VAPID_PUBLIC_KEY = 'BAgEIHKPgI4h_NcwSJXjKme-tM4qc7iMiOrZZZvzGM-mkV1XVjZYc7mtMl5RqCljQYGc-xIK8qlaEGVNA4vbUoY';

/* "Is push enabled on THIS device" — local-only flag, never synced */
function pushIsEnabled(){
  try { return localStorage.getItem('bubble_push_enabled') === 'true'; }
  catch(e){ return false; }
}
function pushSetEnabled(v){
  try { localStorage.setItem('bubble_push_enabled', v ? 'true' : 'false'); }
  catch(e){}
}

/* Browser support check */
function pushIsSupported(){
  return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
}

/* Convert base64 VAPID key to Uint8Array for subscribe() */
function urlBase64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for(let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

/* Toggle handler — called from the bell chip on home */
async function togglePushReminder(){
  if(!pushIsSupported()){
    alert('Push reminders are not supported in this browser. On iPhone, make sure you opened the app from your home screen (not from Safari), and that you have iOS 16.4 or later.');
    return;
  }

  if(pushIsEnabled()){
    // Currently ON — turn OFF
    await pushUnsubscribe();
    pushSetEnabled(false);
    refreshBellChip();
    showPushStatus('Reminders OFF for this device.');
    return;
  }

  // Currently OFF — turn ON. First, request permission.
  let perm;
  try {
    perm = await Notification.requestPermission();
  } catch(e){
    alert('Could not request notification permission. Try opening the app from your home screen.');
    return;
  }
  if(perm !== 'granted'){
    if(perm === 'denied'){
      alert("Notifications were blocked. To enable them on iPhone:\n\n1. Open Settings on your phone\n2. Scroll down to find this app (calmwithbubble)\n3. Tap Notifications and turn them on\n\nThen come back and tap the bell again.");
    } else {
      alert('Notification permission was not granted. You can try again anytime.');
    }
    return;
  }

  // Permission granted — subscribe to push
  const sub = await pushSubscribe();
  if(!sub){
    alert('Could not set up reminders on this device. Please try again later.');
    return;
  }
  // Store subscription on Supabase
  const ok = await pushStoreSubscription(sub);
  if(!ok){
    alert('Permission was granted, but we could not save the subscription. Reminders may not work until this is fixed.');
    return;
  }
  pushSetEnabled(true);
  refreshBellChip();
  showPushStatus('Reminders are ON for this device. 🔔');
}

/* Subscribe to push via the service worker — returns the PushSubscription or null */
async function pushSubscribe(){
  try {
    const reg = await navigator.serviceWorker.ready;
    // If already subscribed, return that one
    let sub = await reg.pushManager.getSubscription();
    if(sub) return sub;
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    return sub;
  } catch(e){
    console.error('[PUSH] subscribe failed:', e);
    return null;
  }
}

async function pushUnsubscribe(){
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if(sub){
      // Remove from Supabase first, then unsubscribe locally
      await pushRemoveSubscription(sub);
      await sub.unsubscribe();
    }
  } catch(e){
    console.error('[PUSH] unsubscribe failed:', e);
  }
}

/* Store the subscription on Supabase. Uses the same SUPABASE_URL / SUPABASE_ANON_KEY
   from sync.js — they're globals there. */
async function pushStoreSubscription(sub){
  if(typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined'){
    console.error('[PUSH] Supabase not configured');
    return false;
  }
  const subJson = sub.toJSON();
  const body = {
    family_id: 'adelyn-household',
    device_id: getDeviceId(),
    endpoint: subJson.endpoint,
    keys: subJson.keys,
    user_agent: navigator.userAgent.slice(0, 200),
    updated_at: new Date().toISOString(),
  };
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?on_conflict=device_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
    if(!res.ok){
      console.error('[PUSH] store failed HTTP', res.status, await res.text());
      return false;
    }
    console.log('[PUSH] subscription stored ✓');
    return true;
  } catch(e){
    console.error('[PUSH] store error:', e);
    return false;
  }
}

async function pushRemoveSubscription(sub){
  if(typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') return;
  try {
    await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?device_id=eq.' + encodeURIComponent(getDeviceId()), {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      },
    });
    console.log('[PUSH] subscription removed ✓');
  } catch(e){
    console.error('[PUSH] remove error:', e);
  }
}

/* Stable per-device ID stored in localStorage */
function getDeviceId(){
  try {
    let id = localStorage.getItem('bubble_device_id');
    if(!id){
      id = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('bubble_device_id', id);
    }
    return id;
  } catch(e){
    return 'd_unknown_' + Math.random().toString(36).slice(2,10);
  }
}

/* Update just the bell chip without redrawing the whole home screen */
function refreshBellChip(){
  const el = document.getElementById('bellChip');
  if(!el) return;
  el.className = 'bellchip ' + (pushIsEnabled() ? 'on' : 'off');
  el.innerHTML = pushIsEnabled() ? '🔔' : '🔕';
}

/* Brief floating status message */
function showPushStatus(text){
  const old = document.getElementById('pushStatus');
  if(old) old.remove();
  const div = document.createElement('div');
  div.id = 'pushStatus';
  div.textContent = text;
  div.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:var(--grape-deep);color:#fff;padding:10px 18px;border-radius:24px;font-weight:700;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,0.2);z-index:9999;animation:fade .25s ease-in';
  document.body.appendChild(div);
  setTimeout(() => { try{ div.remove(); }catch(e){} }, 3000);
}

/* ====== BOOT ====== */
async function boot(){
  // load local, migrate, then merge any cloud data (Lesson 1)
  state = migrate(Sync.loadLocal());
  if(Sync.configured()){
    const cloud = await Sync.pull();
    if(cloud) state = migrate(Sync.merge(state, cloud));
  }
  if(!PIN_STORE.has()) PIN_STORE.set(DEFAULT_PIN);   // Lesson 10/11
  state.lastAppOpenedAt = Date.now();   // for Stage 2 push: skip if used recently
  Sync.saveLocal(state);

  // live updates from other devices — only redraw if user-visible data actually changed
  if(Sync.configured()){
    Sync.startPolling(cloud => {
      const beforeFp = stateFingerprint();
      state = migrate(Sync.merge(state, cloud));
      Sync.saveLocal(state);
      const afterFp = stateFingerprint();
      // Only re-render if something user-visible changed.
      // This prevents Bubble's greeting from re-rolling every 15 seconds
      // while Adelyn is reading the home screen.
      if(beforeFp !== afterFp && (currentView === 'home' || currentView === 'progress')){
        go(currentView, lastData, {back:true});  // back:true so navStack isn't disturbed
      }
      updateSyncDot();
    });
  }
  updateSyncDot();
  go('home');
  // Daily-ish push subscription health check — handle iOS silent revocation.
  // If she's marked enabled locally but the browser has no subscription
  // (or a different one), silently re-subscribe and refresh the server record.
  pushHealthCheck();
}

/* Push subscription health check. iOS sometimes silently revokes push
   subscriptions; without this, reminders would just stop arriving with
   no visible failure. Called on every app load.
   - If local says ON but browser has no sub → try to re-subscribe.
   - If browser has a sub but it doesn't match what we stored → re-register.
   - Failures are silent (logged only); user can always tap the bell to retry. */
async function pushHealthCheck(){
  if(!pushIsEnabled()) return;            // user opted out — nothing to check
  if(!pushIsSupported()) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub){
      // iOS revoked silently. Try to re-subscribe.
      console.log('[PUSH] health check: no subscription, attempting re-subscribe');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      if(sub){
        const ok = await pushStoreSubscription(sub);
        if(ok) console.log('[PUSH] health check: re-subscribed ✓');
        else console.warn('[PUSH] health check: re-subscribe stored failed');
      } else {
        console.warn('[PUSH] health check: re-subscribe blocked (permission revoked?)');
        pushSetEnabled(false);
        refreshBellChip();
      }
    } else {
      // Have a subscription — refresh it on the server in case device_id changed
      // or endpoint rotated. This is a cheap idempotent upsert.
      await pushStoreSubscription(sub);
    }
  } catch(e){
    console.error('[PUSH] health check failed:', e);
  }
}
/* Snapshot of user-visible state — used to decide if a polling redraw is needed */
function stateFingerprint(){
  if(!state) return '';
  const note = (state.parentNotes && state.parentNotes[0]) || {};
  return [
    state.points,
    state.totalPoints,
    (state.log||[]).length,
    (state.gratitudes||[]).length,
    (state.earnedRewards||[]).length,
    (state.pendingClaims||[]).length,
    state.monsterShrink,
    state.streakCount,
    note.ts || 0, !!note.dismissed,
    state.wearing||'',
  ].join('|');
}
function updateSyncDot(){
  const d = document.getElementById('syncdot');
  if(!d) return;
  d.className = 'syncdot' + (Sync.configured() && Sync.isOnline() ? '' : ' off');
}
setInterval(updateSyncDot, 5000);

/* =============================================================
   CORE LOOP UI  — the anger-app reskin of the shared loop:
   trigger -> name feeling -> rate -> use tool -> rate -> log -> celebrate
============================================================= */
const $ = id => document.getElementById(id);
const screen = $('screen');
let currentView = 'home';
let flow = {};   // per-session working data
let navStack = []; // history of {view, data} for back button
let cachedGreeting = null;  // sticky per home visit — set on entry, cleared on leave

function go(view, data, opts){
  // clear cached greeting when we enter home from somewhere else (fresh visit)
  // (polling redraws call go('home') too but currentView is already 'home', so cache is kept)
  if(view === 'home' && currentView !== 'home') cachedGreeting = null;
  // stop bubble animation if we're leaving that screen
  if(currentView === 'distractBubbles' && view !== 'distractBubbles'){
    if(typeof stopBubbleAnimation === 'function') stopBubbleAnimation();
  }
  // push current onto stack unless this is a back-nav or going home (reset)
  if(!opts || !opts.back){
    if(view === 'home'){ navStack = []; }
    else if(currentView && currentView !== view){
      navStack.push({ view: currentView, data: lastData });
      if(navStack.length > 50) navStack.shift(); // cap
    }
  }
  currentView = view;
  lastData = data || {};
  renderers[view](data||{});
  screen.scrollTop = 0;
}
let lastData = {};
function goBack(){
  if(!navStack.length){ go('home'); return; }
  const prev = navStack.pop();
  go(prev.view, prev.data, {back:true});
}

function topbar(backTo){
  // backTo can still be passed for an explicit target, but default uses goBack()
  // We always show a back button except on home itself.
  const showBack = currentView !== 'home';
  return `<div style="display:flex;align-items:center;gap:10px;padding:14px 18px 6px">
    ${showBack
      ? `<button class="back" onclick="${backTo?`go('${backTo}')`:'goBack()'}">‹</button>`
      : '<div style="width:42px"></div>'}
    <div class="pointchip">⭐ ${state.points}</div></div>`;
}

/* ---------- characters (Bubble buddy + anger monster) ---------- */
/* draws an equipped accessory over Bubble (SVG, 200-box coords) */
function accessorySVG(id){
  switch(id){
    case 'hat': return `
      <g><ellipse cx="100" cy="52" rx="34" ry="8" fill="#2a1640"/>
      <rect x="78" y="14" width="44" height="40" rx="6" fill="#2a1640"/>
      <rect x="78" y="40" width="44" height="8" fill="#8b3fb5"/></g>`;
    case 'crown': return `
      <g><path d="M66 50 L74 22 L88 40 L100 16 L112 40 L126 22 L134 50 Z"
        fill="#ffc23f" stroke="#e8a317" stroke-width="2"/>
      <circle cx="100" cy="30" r="4" fill="#ff5b6e"/>
      <circle cx="78" cy="40" r="3" fill="#5b8ff5"/><circle cx="122" cy="40" r="3" fill="#5b8ff5"/></g>`;
    case 'bow': return `
      <g><path d="M100 44 L72 30 L72 58 Z" fill="#ff7ec9"/>
      <path d="M100 44 L128 30 L128 58 Z" fill="#ff7ec9"/>
      <circle cx="100" cy="44" r="9" fill="#ff5b9e"/></g>`;
    case 'shades': return `
      <g><rect x="68" y="86" width="26" height="18" rx="6" fill="#2a1640"/>
      <rect x="106" y="86" width="26" height="18" rx="6" fill="#2a1640"/>
      <rect x="94" y="92" width="12" height="4" fill="#2a1640"/></g>`;
    case 'star': return `
      <g><path d="M150 46 l4 10 11 1 -8 8 2 11 -9 -6 -9 6 2 -11 -8 -8 11 -1 Z"
        fill="#ffc23f" stroke="#e8a317" stroke-width="1.5"/></g>`;
    case 'rainbow': return `
      <g fill="none" stroke-width="5" stroke-linecap="round" opacity="0.9">
      <path d="M40 168 Q100 120 160 168" stroke="#ff5b6e"/>
      <path d="M48 172 Q100 132 152 172" stroke="#ffc23f"/>
      <path d="M56 176 Q100 144 144 176" stroke="#3fd6a8"/></g>`;
    default: return '';
  }
}

function buddySVG(s){ s=s||140;
  const worn = (state && state.wearing) ? state.wearing : null;
  return `<svg width="${s}" height="${s}" viewBox="0 0 200 200">
  <g class="lobe">${[0,1,2,3,4].map(i=>{const a=(i/5)*Math.PI*2;
    const x=100+Math.cos(a)*50,y=100+Math.sin(a)*50;
    return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="42" ry="29" fill="#c861d9" opacity="0.55"
      transform="rotate(${(a*180/Math.PI).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;}).join('')}</g>
  <circle cx="100" cy="100" r="58" fill="#a64fc9"/><circle cx="100" cy="100" r="58" fill="url(#bshine)"/>
  <ellipse cx="84" cy="94" rx="8" ry="12" fill="#2a1640"/><ellipse cx="116" cy="94" rx="8" ry="12" fill="#2a1640"/>
  <circle cx="87" cy="89" r="3" fill="#fff"/><circle cx="119" cy="89" r="3" fill="#fff"/>
  <path d="M86 116 Q100 130 114 116" stroke="#2a1640" stroke-width="5" fill="none" stroke-linecap="round"/>
  <circle cx="74" cy="111" r="6.5" fill="#ff7ec9" opacity="0.6"/><circle cx="126" cy="111" r="6.5" fill="#ff7ec9" opacity="0.6"/>
  <path d="M83 148 L76 172 L97 165 Z" fill="#5b6fd6"/><path d="M117 148 L124 172 L103 165 Z" fill="#5b6fd6"/>
  ${worn ? accessorySVG(worn) : ''}
  <defs><radialGradient id="bshine" cx="0.36" cy="0.3" r="0.8">
    <stop offset="0%" stop-color="#e7a6f5" stop-opacity="0.9"/>
    <stop offset="55%" stop-color="#a64fc9" stop-opacity="0"/></radialGradient></defs></svg>`; }
function buddy(cls,size){ return `<div class="char-wrap"><div class="char idle ${cls||''}">${buddySVG(size)}</div></div>`; }

function monsterSVG(s,mad){ s=s||130; mad=(mad==null)?1:mad;
  const browL=90-mad*8;
  const mouth=mad>0.45?`M82 138 Q100 124 118 138`:`M84 132 Q100 144 116 132`;
  return `<svg width="${s}" height="${s}" viewBox="0 0 200 200">
  <g fill="#d8334a">${[...Array(9)].map((_,i)=>{const a=(i/9)*Math.PI*2;
    const x2=100+Math.cos(a)*78,y2=100+Math.sin(a)*78,pa=a+0.28,pb=a-0.28;
    const bx1=100+Math.cos(pa)*54,by1=100+Math.sin(pa)*54,bx2=100+Math.cos(pb)*54,by2=100+Math.sin(pb)*54;
    return `<path d="M${bx1.toFixed(1)} ${by1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)} L${bx2.toFixed(1)} ${by2.toFixed(1)} Z"/>`;}).join('')}</g>
  <circle cx="100" cy="100" r="56" fill="#ff5b6e"/><circle cx="100" cy="100" r="56" fill="url(#mshine)"/>
  <path d="M70 ${browL} L94 ${browL+14}" stroke="#7a1020" stroke-width="8" stroke-linecap="round"/>
  <path d="M130 ${browL} L106 ${browL+14}" stroke="#7a1020" stroke-width="8" stroke-linecap="round"/>
  <circle cx="84" cy="103" r="9" fill="#fff"/><circle cx="116" cy="103" r="9" fill="#fff"/>
  <circle cx="84" cy="104" r="4.5" fill="#2a1640"/><circle cx="116" cy="104" r="4.5" fill="#2a1640"/>
  <path d="${mouth}" stroke="#7a1020" stroke-width="6" fill="none" stroke-linecap="round"/>
  <defs><radialGradient id="mshine" cx="0.36" cy="0.3" r="0.85">
    <stop offset="0%" stop-color="#ff9aa6" stop-opacity="0.9"/>
    <stop offset="55%" stop-color="#ff5b6e" stop-opacity="0"/></radialGradient></defs></svg>`; }
function monster(cls,size,mad){ return `<div class="char-wrap"><div class="char idle ${cls||''}">${monsterSVG(size,mad)}</div></div>`; }
function monsterSize(){ return MONSTER_SIZES[Math.min(state.monsterShrink,6)]; }
function monsterMad(){ return Math.max(0, 1 - state.monsterShrink*0.16); }

/* ---------- coping tool bank ---------- */
const TOOLS=[
  {id:'move',e:'🛼',name:'Move my body',kind:'list',desc:'Get the angry energy out!',
   ideas:['Ride your skates for 5 minutes 🛼','Do 10 jumping jacks 🤸','Run one lap around the yard 🏃',
     'Wall pushes — "hold up the house" 🧱','Squeeze your fists, then let go — 5 times ✊',
     'Big animal stomps across the room 🦣','Shake the madies out, head to toe 🌀',
     'Wring a towel as hard as you can 🧻','Dance hard to one fast song 🎵']},
  {id:'calmbody',e:'🧸',name:'Calm my body',kind:'list',desc:'Settle the shaky, hot feeling.',
   ideas:['Hug a pillow tight, then let it go 🛏️','Wrap up like a cozy blanket burrito 🌯',
     'Hold something cold or something soft ❄️','Trace your hand slowly while you breathe ✋',
     'Press your feet into the floor, strong and still 🦶','Slow sips of cold water 🧊']},
  {id:'craft',e:'🎨',name:'Craft or read',kind:'list',desc:'Step away and settle down.',
   ideas:['Draw or color something just for fun 🎨','Read a few pages of your book 📖',
     'Build or make a little craft ✂️','Find a cozy spot that is just yours 🛋️']},
  {id:'calmmind',e:'🌈',name:'Calm my mind',kind:'list',desc:'For when everything feels like too much.',
   ideas:['5 things you see, 4 you hear, 3 you can touch 👀','Count slowly backwards from 20 🔢',
     'Name every color you can find in the room 🌈','Picture your calm happy place 🏖️',
     'Blow slow pretend bubbles 🫧']},
  {id:'dragon',e:'🐉',name:'Dragon breath',kind:'breath',desc:'Big slow breaths to cool down.'},
  {id:'water',e:'🧊',name:'Cold water',kind:'list',desc:'A cold sip resets your body fast.',
   ideas:['Sip cold water slowly and feel it cool you down 🧊',
     'Splash some cold water on your face 💦',
     'Hold an ice cube or something cold in your hand ❄️']},
  {id:'mantra',e:'💜',name:'Say my mantra',kind:'mantra',desc:'Tell myself something strong.'},
  {id:'faith',e:'🙏',name:'Prayer or verse',kind:'faith',desc:'A calm prayer or a verse I love.'},
  {id:'detective',e:'🔍',name:'Be a thought detective',kind:'detective',desc:'Check if a worried thought is really true.'},
  {id:'distract',e:'🎈',name:'Distract me',kind:'distract',desc:'Take my mind off it — facts, jokes, bubbles, math.'},
  {id:'express',e:'✏️',name:'Get the feeling out',kind:'express',desc:'A safe way to let the big feeling out.'},
];
const MANTRAS=['I can handle this.','I get to choose what happens next.',
  'A no is not the end of the world.','I can be mad AND still be kind.',
  'I am calm. I am brave. I am okay.'];
const EXPRESS=['Tell Bubble exactly what happened 💬','Draw what the angry feeling looks like ✏️',
  'Scribble hard on scratch paper, then crumple it 🗒️','Write it down, then rip it up 📄',
  'Say it out loud in a calm-down spot 🗣️'];
const DETECTIVE=['Maybe they were busy, not being mean.','Maybe it was an accident.',
  'Maybe they were having a hard day too.','I could ask them instead of guessing.',
  'What would I tell a friend who thought this?'];
const WARN=[{e:'😕',t:'I feel left out'},{e:'😠',t:'I feel picked on'},
  {e:'😤',t:'I feel frustrated'},{e:'⚖️',t:'Something feels unfair'},
  {e:'🚫',t:'Someone said no'},{e:'🌪️',t:'I feel overwhelmed'}];
const THOUGHTS=['They are talking about me','She did that on purpose','Nobody is being fair to me',
  "They don't want me around",'I never get my way'];
const FEARS=[{e:'🌙',t:'The dark / nighttime'},{e:'⛈️',t:'Thunderstorms'},{e:'🔊',t:'Loud noises'},
  {e:'🎢',t:'Roller coasters'},{e:'🐛',t:'Bugs'},{e:'🧍',t:'Being alone'}];
const AFTER_Q=[
  {tag:'WHERE WERE YOU?',q:'Where did it happen?',type:'chips',
   chips:['Home 🏠','My room 🛏️','School 🏫','In the car 🚗',"A friend's house 🏡",
     'Outside 🌳','At an activity ⚽','At church ⛪','Grandma/Grandpa\'s 👵','A store 🛒',
     'Somewhere else ✨']},
  {tag:'WHO WAS THERE?',q:'Who was with you?',type:'chips',
   chips:['Mom 💗','Dad 💙','Emily 🧒','A neighborhood friend 🏘️','A school friend 🎒',
     'A group of friends 👯','A family member 👪','A teacher 🍎','A coach 📣','A grown-up I didn\'t know 👤',
     'Just me 🙂']},
  {tag:'WHAT DID YOU DO?',q:'What did you do?',type:'chips',sub:'Just honest — no judging. Tap all that happened.',
   chips:['Yelled 😣','Screamed 😱','Clenched my fists ✊','Made a mean face 😠','Stomped off 👣',
     'Cried 😢','Said something mean 💢','Talked back 🗯️','Slammed a door 🚪','Threw something 🧸',
     'Hit something 👊','Pushed someone 🙅','Went quiet 🤐','Sulked 😒','Walked away 🚶',
     'Asked for help 🙋','Used a calm-down tool 🧰']},
  {tag:'THOUGHTFUL OR IMPULSIVE?',q:'Was that thoughtful or impulsive?',type:'single',
   sub:'Did you stop and think, or did it happen fast?',chips:['Thoughtful 🧠','A bit of both 🤔','Impulsive ⚡']},
  {tag:'WHAT SET IT OFF?',q:'What made you angry?',type:'chips',sub:'Tap what started it.',
   chips:['Someone said no 🚫','Felt left out 😕','Felt picked on 😠','Felt teased 🙄',
     'Something felt unfair ⚖️',"Didn't get my way 😤",'Someone took something 🤲',
     'Plans changed 🔄','Too much going on 🌪️','Got told to do something 📋',
     'Someone wouldn\'t share 🤐','Lost a game 🎲','Was rushed ⏰','Was tired or hungry 😴',
     'Someone broke a rule 📏','Someone laughed at me 😞']},
  {tag:'WHAT HAPPENED NEXT?',q:'What happened because of that?',type:'chips',sub:'How did it turn out? Tap all that fit.',
   chips:['Got in trouble ⚠️','Someone got upset 😟','I lost a privilege 📵','We stopped playing 🛑',
     'I felt bad after 💔','Got a hug 🤗','We worked it out 🤝','Someone said sorry 💬',
     'I said sorry 🙇','I calmed down 😮‍💨','Nothing really changed 😐','It got worse 📈',
     'I needed alone time 🛋️','A grown-up helped 🧑‍🤝‍🧑']},
  {tag:'DID YOU FEEL IT COMING?',q:'Did you feel it coming?',type:'single',
   sub:'Did you notice warning signs before it got big?',chips:['Yes, I felt it 👀','A little 🤏','No, it surprised me 💥']},
  {tag:'NEXT TIME',q:'What could you try next time?',type:'chips',sub:'Not to feel bad — just a plan. Tap any ideas.',
   chips:['Take a breath 🐉','Walk away to cool off 🚶','Count to 10 🔢','Drink cold water 🧊',
     'Move my body 🛼','Ask for help 🙋','Use a calm-down tool 🧰','Tell a grown-up 🗣️',
     'Use my words 💬','Take a break ⏸️','Say my mantra 💜','Pray 🙏','Catch it earlier 🌤️']},
];
function feelWord(v){
  if(v<=1)return['Calm','#3fd6a8']; if(v<=3)return['A little bugged','#7fce6a'];
  if(v<=5)return['Frustrated','#ffc23f']; if(v<=7)return['Pretty mad','#ff8a3f'];
  if(v<=9)return['Really angry','#ff5b6e']; return['Exploding','#e23a5e'];
}

const renderers = {};

/* ---------- HOME ---------- */
/* ---------- Specific cheerleader greetings tied to her real activity ---------- */
function bubbleGreeting(streak, u){
  // candidate pool — start with the always-warm baseline
  const pool = [
    "Hi, I'm <b>Bubble</b>. I'm so glad you came back today.",
    "I was just thinking about you. Glad you're here.",
    "Hey friend. Whatever today is — I'm right here with you.",
    "I'm <b>Bubble</b>, your buddy. We can take this one moment at a time, together.",
  ];
  // add activity-specific lines when there's something real to point to
  if(streak >= 3) pool.push(`That is <b>${streak} days in a row</b> you've come back. That kind of showing-up is real.`);
  if(u && u.week >= 5) pool.push(`You've used your tools <b>${u.week} times this week</b>. You keep trying, even when it's hard. I see that.`);
  if(u && u.day >= 2) pool.push("Already back today? You're really doing the work. I'm glad you came.");
  if(state.totalPoints && state.totalPoints >= 50) pool.push("Look at all you've practiced. The brave you is growing every day.");
  if(state.log && state.log.length){
    const last = state.log[0];
    if(last && last.door === 'brave') pool.push("Last time you took a brave step. That stays with you, you know.");
    if(last && last.door === 'people') pool.push("Last time you practiced reading people. That's a real skill — and you're building it.");
    if(last && last.rateAfter != null && last.rateBefore != null && last.rateAfter < last.rateBefore) pool.push("Last time, your feeling came down. That was your hard work — not magic.");
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

renderers.home = () => {
  const streak = currentStreak();
  const u = usageCounts();
  const note = (state.parentNotes && state.parentNotes.length && !state.parentNotes[0].dismissed)
    ? state.parentNotes[0] : null;
  // Specific, warm greeting tied to her actual activity — cached per home visit
  // so polling redraws don't make Bubble change what she's saying mid-read.
  if(!cachedGreeting) cachedGreeting = bubbleGreeting(streak, u);
  const greeting = cachedGreeting;
  screen.innerHTML = `
  <div style="display:flex;align-items:center;gap:10px;padding:14px 18px 6px">
    <div class="streakpill" title="day streak">🔥 ${streak}</div>
    <button id="bellChip" class="bellchip ${pushIsEnabled() ? 'on' : 'off'}" onclick="togglePushReminder()" title="Reminders for this device">
      ${pushIsEnabled() ? '🔔' : '🔕'}
    </button>
    <div class="pointchip">⭐ ${state.points}</div>
  </div>
  <div class="pad fade">
    <div style="text-align:center"><div class="hero-name">Adelyn's App</div>
    <div class="hello">Hi, Adelyn! 👋</div></div>
    <div class="duo" style="margin:4px auto 0">${buddy('',124)}</div>
    <div class="speech">${greeting}</div>
    <button class="tellbubble" onclick="go('tellBubble')">
      <span style="font-size:22px">💜</span>
      <span style="flex:1;text-align:left">
        <span style="font-weight:800;font-size:15px">Tell Bubble what happened</span>
        <span style="display:block;font-weight:600;font-size:12px;opacity:0.85">Share something — good or hard</span>
      </span>
    </button>
    ${note?`<div class="parentnote" onclick="dismissNote()">
      <div style="font-weight:800;font-size:12px;color:var(--grape);letter-spacing:.5px">💌 NEW NOTE FROM MOM/DAD</div>
      <div style="font-weight:700;font-size:15px;color:var(--ink);margin-top:3px">${escapeHtml(note.text)}</div>
      <div style="font-size:11px;color:var(--ink-soft);font-weight:700;margin-top:4px">tap to dismiss</div>
    </div>`:''}
    <div class="statrow">
      <div class="statcard"><div class="statnum">${u.day}</div><div class="statlbl">TODAY</div></div>
      <div class="statcard"><div class="statnum">${u.week}</div><div class="statlbl">THIS WEEK</div></div>
      <div class="statcard"><div class="statnum">${u.all}</div><div class="statlbl">ALL TIME</div></div>
    </div>
    <div style="height:10px"></div>
    <button class="door before" onclick="go('beforePick')"><div class="emoji">🌤️</div>
      <div><div class="dt">I feel it coming</div><div class="ds">I notice a warning sign</div></div></button>
    <button class="door during" onclick="go('duringStart')"><div class="emoji">🔥</div>
      <div><div class="dt">I need help NOW</div><div class="ds">I'm angry or frustrated</div></div></button>
    <button class="door after" onclick="go('afterStart')"><div class="emoji">📖</div>
      <div><div class="dt">Something happened</div><div class="ds">Look back at an angry moment</div></div></button>
    <button class="door brave" onclick="go('bravePick')"><div class="emoji">🦁</div>
      <div><div class="dt">Be brave</div><div class="ds">Something feels scary</div></div></button>
    <button class="door people" onclick="go('peopleStart')"><div class="emoji">🧩</div>
      <div><div class="dt">People practice</div><div class="ds">Get better at reading people</div></div></button>
    <button class="door gratitude" onclick="go('gratitude')"><div class="emoji">☀️</div>
      <div><div class="dt">Sunshine</div><div class="ds">Gratitude & a reminder I'm loved</div></div></button>
    <div class="minirow">
      <button class="minicard" onclick="go('progress')"><div class="mi">🏆</div><div class="ml">My Wins</div></button>
      <button class="minicard" onclick="go('rewards')"><div class="mi">🎁</div><div class="ml">Rewards</div></button>
      <button class="minicard" onclick="go('closet')"><div class="mi">🎩</div><div class="ml">Closet</div></button>
      <button class="minicard" onclick="go('parentGate')"><div class="mi">🔒</div><div class="ml">Grown-Ups</div></button>
    </div>
  </div>`;
};
function dismissNote(){
  if(state.parentNotes && state.parentNotes.length){
    state.parentNotes[0].dismissed = true;
    save();
    go('home');
  }
}

/* ---------- RATE ---------- */
renderers.rate = (d) => {
  const titles={now:['HOW BIG IS IT?','How big is the feeling right now?'],
    then:['HOW BIG WAS IT?','How big was the feeling back then?'],
    after:['HOW BIG IS IT NOW?','How big is the feeling now?']};
  const [tag,title]=titles[d.when]||titles.now;
  const startVal=d.when==='after'?Math.max(0,(flow.rateBefore!=null?flow.rateBefore:5)-2):5;
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">${tag}</span><div class="step-title">${title}</div>
    <div class="step-sub">${d.when==='after'?"You used your skill — let's see what changed.":'Slide the bubble to show how strong it feels.'}</div>
    <div class="meter-num" id="mnum">${startVal}</div><div class="meter-word" id="mword"></div>
    <input type="range" min="0" max="10" value="${startVal}" id="slider" oninput="updMeter()">
    <div class="scale-ends"><span>0 · calm</span><span>10 · biggest</span></div>
    ${d.when==='after'&&flow.rateBefore!=null?`<div class="card" style="text-align:center">
      <p style="margin:0">Before, you said it was <b>${flow.rateBefore}</b>.</p></div>`:''}
    <button class="btn" onclick="rateDone('${d.when}')">${d.when==='after'?"That's how I feel now":"That's how it feels"}</button>
  </div>`;
  updMeter();
};
function updMeter(){
  const v=+$('slider').value,[w,c]=feelWord(v);
  $('mnum').textContent=v; $('mnum').style.color=c;
  $('mword').textContent=w; $('mword').style.color=c;
}
function rateDone(when){
  const v=+$('slider').value;
  if(when==='now'||when==='then'){
    flow.rateBefore=v;
    if(flow.door==='brave') go('braveStep');
    else if(flow.door==='after') go('afterPrompts');
    else go('thought');
  } else {
    flow.rateAfter=v;
    // After second rating: for the DURING door, give her a calm choice
    // (another tool / tell what happened / done). Other doors finish normally.
    if(flow.door==='during') go('duringWhatNow');
    else finishFlow();
  }
}

/* ---------- DURING: after she's calmer, what does she want to do? ---------- */
renderers.duringWhatNow = () => {
  const calmer = (flow.rateBefore!=null && flow.rateAfter!=null && flow.rateAfter<flow.rateBefore);
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade" style="text-align:center">
    <span class="step-tag">YOU DID IT 🌟</span>
    <div class="step-title">${calmer?'Nice — your feeling came down!':'You showed up — that is huge.'}</div>
    <div class="duo" style="margin:8px auto">${buddy('happy',110)}</div>
    <div class="card"><p>What would you like to do next? <b>Whatever you pick is okay.</b></p></div>
    <button class="choice" onclick="duringAnotherTool()">
      <span class="ce">🔁</span>Use another tool</button>
    <button class="choice" onclick="duringLogIt()">
      <span class="ce">📖</span>Tell what happened (log it)</button>
    <button class="choice" onclick="duringDoneForNow()">
      <span class="ce">✅</span>I'm done for now</button>
    <div class="skipnote">If you choose "done", you can always come back later and log it. 💜</div>
  </div>`;
};
function duringAnotherTool(){
  // back to the picker; keep the toolsUsed history
  flow.tool = null;
  go('duringToolPick');
}
function duringLogIt(){
  // jump into the reflection prompts; rating already captured at start (rateBefore)
  flow.door = 'during';  // keep door label so the entry stays "during" with logging
  flow.logging = true;
  go('afterPrompts');    // chip-based prompts — she can fill them now that she's calmer
}
function duringDoneForNow(){
  // finish without reflection — moment is logged with what we have
  finishFlow();
}

/* ---------- BEFORE ---------- */
renderers.beforePick = () => {
  flow={door:'before'};
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade"><span class="step-tag">CATCH IT EARLY</span>
    <div class="step-title">What are you noticing?</div>
    <div class="step-sub">You opened the app early — that's a big win already! 🌟</div>
    ${WARN.map((w,i)=>`<button class="choice" onclick="pickWarn(${i})">
      <span class="ce">${w.e}</span>${escapeHtml(w.t)}</button>`).join('')}
  </div>`;
};
function pickWarn(i){
  flow.warn=WARN[i].t;
  if(i===0){ go('aloneTime'); return; }
  go('rate',{when:'now'});
}
renderers.aloneTime = () => {
  screen.innerHTML=`${topbar('beforePick')}
  <div class="pad fade"><span class="step-tag">A SMART RESET</span>
    <div class="step-title">Taking a little alone time 💜</div>
    <div class="card"><p>Wanting some space is a <b>smart, healthy choice</b> — not hiding. Let's make it a good reset. Pick something just for you:</p></div>
    ${['Draw or color something fun 🎨','Read a few pages 📖','Make a little craft ✂️','Find a cozy spot 🛋️']
      .map(c=>`<button class="choice" onclick="go('rate',{when:'now'})"><span class="ce">✨</span>${c}</button>`).join('')}
  </div>`;
};
renderers.duringStart=()=>{
  flow={door:'during'};
  go('duringRate');
};

/* ---------- DURING: super-simple opening rating ---------- */
renderers.duringRate = () => {
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade" style="text-align:center">
    <span class="step-tag" style="background:#ffd6c2;color:#c8530f">I'M HERE 🔥</span>
    <div class="step-title" style="margin-top:10px">How big is it?</div>
    <div class="duo" style="margin:8px auto">${buddy('',104)}</div>
    <div class="meter-num" id="mnum" style="font-size:90px">5</div>
    <input type="range" min="0" max="10" value="5" id="slider" oninput="updMeterSimple()" style="margin-top:10px">
    <div class="scale-ends" style="margin-top:6px"><span>0 · calm</span><span>10 · huge</span></div>
    <button class="btn" style="margin-top:18px" onclick="duringRateDone()">That's how big it is</button>
  </div>`;
  updMeterSimple();
};
function updMeterSimple(){
  const v=+$('slider').value, [w,c]=feelWord(v);
  $('mnum').textContent=v; $('mnum').style.color=c;
}
function duringRateDone(){
  flow.rateBefore = +$('slider').value;
  go('duringToolPick');
}

/* ---------- DURING: fast body-reset picker (3 huge options + auto) ---------- */
renderers.duringToolPick = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade" style="text-align:center">
    <span class="step-tag" style="background:#ffd6c2;color:#c8530f">PICK FAST 🔥</span>
    <div class="step-title" style="margin-top:8px">Let's get your body to calm down</div>
    <div class="bigtool move" onclick="pickTool('move')">
      <div class="bt-e">🛼</div><div class="bt-t">MOVE</div></div>
    <div class="bigtool dragon" onclick="pickTool('dragon')">
      <div class="bt-e">🐉</div><div class="bt-t">DRAGON BREATH</div></div>
    <div class="bigtool water" onclick="pickTool('water')">
      <div class="bt-e">🧊</div><div class="bt-t">COLD WATER</div></div>
    <div class="bigtool helpme" onclick="bubbleTakeover()">
      <div class="bt-e">💜</div><div class="bt-t">I CAN'T PICK — JUST HELP</div></div>
    <button class="btn ghost" style="margin-top:12px" onclick="go('toolPick')">Show all my tools</button>
  </div>`;
};
/* Bubble starts dragon breath automatically when she can't choose */
function bubbleTakeover(){
  flow.tool = TOOLS.find(t=>t.id==='dragon');
  go('breathe',{next:'afterTool'});
}
renderers.afterStart =()=>{ flow={door:'after'};  go('rate',{when:'then'}); };

/* ---------- THOUGHT ---------- */
renderers.thought = () => {
  const mn = escapeHtml(state.monsterName || 'the anger monster');
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">WHAT IS ${mn.toUpperCase()} SAYING?</span>
    <div class="step-title">What is ${mn} telling you?</div>
    <div class="step-sub">When you're angry, ${mn} whispers pushy thoughts. Naming them helps us look at them. Tap the closest one.</div>
    ${THOUGHTS.map((t,i)=>`<button class="choice" onclick="pickThought(this,${i})">
      <span class="ce">💭</span>${escapeHtml(t)}</button>`).join('')}
    <button class="moretoggle" onclick="showThoughtBox()" id="moreBtn">+ say it in my own words</button>
    <div id="morebox" style="display:none">
      <textarea id="ownthought" placeholder="Type what ${mn} is telling you..."></textarea></div>
    <button class="btn" onclick="thoughtNext()">Next</button>
    <div class="skipnote">Pick the closest one — it doesn't have to be perfect. 💜</div>
  </div>`;
};
function showThoughtBox(){ $('morebox').style.display='block'; $('moreBtn').style.display='none'; $('ownthought').focus(); }
function pickThought(el,i){
  el.parentElement.querySelectorAll('.choice').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel'); flow.thought=THOUGHTS[i];
}
function pickOne(el){
  el.parentElement.querySelectorAll('.choice').forEach(c=>c.classList.remove('sel'));
  el.classList.add('sel');
}
function thoughtNext(){
  const box=$('ownthought'); const own=box?box.value.trim():'';
  if(own) flow.thought=own;
  if(!flow.thought) flow.thought='(a hard thought)';
  go('notes');
}

/* ---------- NOTES — optional "tell us more" after the thought ---------- */
renderers.notes = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">TELL ME MORE 📝</span>
    <div class="step-title">Anything else you want to share?</div>
    <div class="step-sub">You can write a little about what's happening — or skip it. Totally up to you.</div>
    <div class="duo" style="margin:4px auto">${buddy('',92)}</div>
    <div class="card tip"><p>💜 Writing it down can help — and it helps the grown-ups who care about you understand. But only if you want to.</p></div>
    <textarea id="notebox" placeholder="What's going on? You can tell me as much or as little as you want..." style="min-height:120px"></textarea>
    <button class="btn" onclick="notesNext()">Next</button>
    <button class="btn ghost" onclick="notesSkip()">Skip for now</button>
  </div>`;
};
function notesNext(){
  const box=$('notebox');
  flow.notes = box ? box.value.trim() : '';
  go('toolPick');
}
function notesSkip(){ flow.notes=''; go('toolPick'); }

/* ---------- TOOL PICK ---------- */
renderers.toolPick = () => {
  const th=(flow.thought||'').toLowerCase();
  const targeted=/me|purpose|fair|want me|my way/.test(th);
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">PICK A TOOL</span>
    <div class="step-title">What will help right now?</div>
    <div class="step-sub">${targeted?'That sounds like '+escapeHtml(state.monsterName||'the anger monster')+' guessing the worst — "thought detective" could really help. Movement is great too!':'These all work. Moving your body is a great one for you!'}</div>
    ${TOOLS.map(t=>`<button class="choice ${targeted&&t.id==='detective'?'sel':''}" onclick="pickTool('${t.id}')">
      <span class="ce">${t.e}</span><span style="flex:1">${escapeHtml(t.name)}
      <div style="font-size:12px;color:${targeted&&t.id==='detective'?'#fff':'var(--ink-soft)'};font-weight:600">${escapeHtml(t.desc)}</div>
      </span></button>`).join('')}
  </div>`;
};
function pickTool(id){
  const tool=TOOLS.find(t=>t.id===id); flow.tool=tool;
  if(tool.kind==='breath') go('breathe',{next:'afterTool'});
  else if(tool.kind==='mantra') go('mantra');
  else if(tool.kind==='faith') go('faith');
  else if(tool.kind==='detective') go('detective');
  else if(tool.kind==='distract') go('distract');
  else if(tool.kind==='express') go('express');
  else go('toolList',{tool});
}

/* ---------- list-style tool (wall-clock Timer, Lesson 3) ---------- */
renderers.toolList = (d) => {
  const tool=d.tool;
  const idea=tool.ideas[Math.floor(Math.random()*tool.ideas.length)];
  const secs=(tool.id==='move')?60:45;
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade" style="text-align:center"><span class="step-tag">${escapeHtml(tool.name.toUpperCase())}</span>
    <div class="step-title">Your mission:</div>
    <div class="card" style="margin-top:8px"><h3 style="margin:0">${escapeHtml(idea)}</h3></div>
    <div class="timer-ring"><svg width="198" height="198">
      <circle cx="99" cy="99" r="86" stroke="#efd9ff" stroke-width="20" fill="none"/>
      <circle id="tprog" cx="99" cy="99" r="86" stroke="#8b3fb5" stroke-width="20" fill="none"
        stroke-linecap="round" stroke-dasharray="${(2*Math.PI*86).toFixed(1)}" stroke-dashoffset="0"/>
    </svg><div class="timer-mid"><div class="timer-count" id="tcount">${secs}</div>
      <div class="timer-label">seconds</div></div></div>
    <div style="margin-top:2px">${buddy('',96)}</div>
    <div style="font-weight:700;color:var(--ink-soft);font-size:13px">Bubble is doing it with you!</div>
    <button class="btn go" id="donebtn" onclick="afterTool()">I did it! ✅</button>
    <button class="btn ghost" onclick="Timer.stop();go('toolPick')">Try a different tool</button>
  </div>`;
  const circ=2*Math.PI*86;
  Timer.start(secs,(remain,total)=>{
    const tc=$('tcount'), tp=$('tprog');
    if(tc) tc.textContent = remain>0?remain:'⭐';
    if(tp) tp.style.strokeDashoffset = circ*(1-remain/total);
  },()=>{ const b=$('donebtn'); if(b) b.textContent='All done! Tap here ✅'; });
};
function afterTool(){
  Timer.stop();
  // record which tool was just used in this session
  if(!flow.toolsUsed) flow.toolsUsed = [];
  if(flow.tool) flow.toolsUsed.push(flow.tool.name);
  go('moreHelp');
}

/* ---------- "I feel better" vs "I need more help" ---------- */
renderers.moreHelp = () => {
  const tried = flow.toolsUsed ? flow.toolsUsed.length : 0;
  const suggestGrownUp = tried >= 3;
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">HOW ARE YOU?</span>
    <div class="step-title">How are you feeling now?</div>
    <div class="step-sub">${tried>1
      ? `You've tried ${tried} tools so far — that's hard work!`
      : 'You used a tool — nice job!'}</div>
    <div class="duo" style="margin:8px auto">${buddy('',96)}</div>
    <button class="choice" onclick="go('rate',{when:'after'})">
      <span class="ce">😌</span>I feel better — let's check it</button>
    <button class="choice" onclick="moreTool()">
      <span class="ce">🔁</span>I need more help — try another tool</button>
    ${suggestGrownUp?`
      <div class="card tip" style="margin-top:14px">
        <h3 style="margin:0">💜 You're working so hard.</h3>
        <p>Big feelings sometimes need a grown-up, not just a tool. Would you like to find someone who can be with you?</p>
        <button class="btn" style="margin-top:8px" onclick="grownUpSuggested()">Yes — I'll find a grown-up 🤗</button>
      </div>`:''}
    <div class="skipnote">Whatever you pick is okay. There's no wrong answer. 💜</div>
  </div>`;
};
function moreTool(){
  // back to the picker — but skip the warning/thought steps since she's mid-session
  flow.tool = null;          // ready to pick a new one
  go('toolPick');
}
function grownUpSuggested(){
  // log the moment as a "got grown-up help" outcome and finish
  flow.gotGrownUp = true;
  go('rate',{when:'after'});
}

/* ---------- dragon breath ---------- */
renderers.breathe = (d) => {
  const nextFn=d.next||'afterTool';
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade" style="text-align:center"><span class="step-tag">DRAGON BREATH 🐉</span>
    <div class="step-title">Breathe with the bubble</div>
    <div class="step-sub">Big breath in... slow breath out, like a dragon.</div>
    <div class="breathe-word" id="bword">Get ready...</div>
    <div class="breathe-dot" id="bdot"></div>
    <div style="font-weight:700;color:var(--ink-soft)" id="bcount">3 breaths to go</div>
    <button class="btn go" id="bdone" onclick="${nextFn}()">I feel calmer ✅</button>
  </div>`;
  let cycles=3;
  const word=$('bword'),cnt=$('bcount'),dot=$('bdot');
  setTimeout(()=>{
    if(dot) dot.classList.add('go');
    const tick=()=>{
      if($('bword')){word.textContent='Breathe in 🌬️';word.style.color='#5b8ff5';}
      setTimeout(()=>{if($('bword')){word.textContent='Hold...';word.style.color='#8b3fb5';}},4000);
      setTimeout(()=>{if($('bword')){word.textContent='Breathe out 🐉';word.style.color='#ff8a3f';}},4600);
    };
    tick();
    const iv=setInterval(()=>{
      cycles--;
      if(cycles<=0){ clearInterval(iv);
        if($('bword')){word.textContent='Great job! 💜';word.style.color='#3fd6a8';}
        if($('bcount')) cnt.textContent='You did it!'; return; }
      if($('bcount')) cnt.textContent=cycles+' breath'+(cycles>1?'s':'')+' to go';
      tick();
    },8000);
  },900);
};
renderers.mantra = () => {
  const customs=(state.customMantras||[]);
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">MY MANTRA 💜</span>
    <div class="step-title">Say it strong</div>
    <div class="step-sub">Tap a mantra and say it out loud — like you mean it!</div>
    ${MANTRAS.concat(customs).map(m=>`<button class="choice" onclick="pickOne(this)">
      <span class="ce">💜</span>${escapeHtml(m)}</button>`).join('')}
    <button class="moretoggle" onclick="$('mbox').style.display='block';this.style.display='none'">+ write my own mantra</button>
    <div id="mbox" style="display:none"><textarea id="ownmantra" placeholder="Write your very own mantra..."></textarea></div>
    <button class="btn go" onclick="saveMantraMaybe();afterTool()">I said it! ✅</button>
  </div>`;
};
function saveMantraMaybe(){
  const b=$('ownmantra');
  if(b && b.value.trim().length>1){
    state.customMantras.push(b.value.trim()); save();   // custom content -> synced & merged
  }
}
renderers.faith = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">PRAYER OR VERSE 🙏</span>
    <div class="step-title">A calm, quiet moment</div>
    <div class="step-sub">Say a little prayer in your own words, or read a verse you love.</div>
    <div class="card tip"><p>💛 Take all the time you need. When your heart feels calmer, tap below.</p></div>
    <textarea id="versebox" placeholder="Write a verse or prayer you want to remember..."></textarea>
    <button class="btn go" onclick="saveVerseMaybe();afterTool()">I feel calmer ✅</button>
  </div>`;
};
function saveVerseMaybe(){
  const b=$('versebox');
  if(b && b.value.trim().length>1){ state.customVerses.push(b.value.trim()); save(); }
}
/* =============================================================
   THOUGHT DETECTIVE — journaling-style 5-question walkthrough
   Same therapist framework, but reframed as writing prompts rather
   than quiz questions. Open writing box on every question with
   feeling-word chip starters. Every question skippable. Points
   scale with engagement: base 1 + thoughtful bonus if writing on 3+.
============================================================= */

const DETECTIVE_CHIPS = {
  1: ['Tiny problem','A small thing','Medium-sized','Big deal','Huge to me','Hard to tell'],
  2: ['Totally true','Probably true','Not sure','Probably a guess','Probably not true','I would have to ask'],
  3: ['Really bad','Annoying','Just different','Actually okay','Hard to say','I am still mad about it'],
  4: ['I can do something','I can ask a grown-up','A little of it','Not really','None of it','I can change how I feel about it'],
  5: ['Just a comment','About someone else','A question','Hard to tell','Yes — that was a judgment','Felt like an attack'],
};

renderers.detective = () => {
  const th = flow.thought || '';
  const mn = escapeHtml(state.monsterName || 'the anger monster');
  // reset the detective session
  flow.detective = { step:0, isPerson:null, answers:{} };
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">THOUGHT DETECTIVE 🔍</span>
    <div class="step-title">Investigate what ${mn} said</div>
    ${th ? `<div class="card"><h3 style="margin:0">What ${mn} is telling you:</h3><p style="font-size:15.5px;margin-top:6px">"${escapeHtml(th)}"</p></div>` : ''}
    <div class="card tip">
      <p>🕵️ A detective doesn't just believe the first thing they hear — they write down what they find.</p>
      <p>I'll ask you <b>5 questions</b> about this. You can write a little or a lot. Skip any you want.</p>
      <p style="margin-top:8px;font-size:13px;color:var(--ink-soft)"><b>One quick thing first:</b> Is this thought about another person — like a friend, classmate, or family member?</p>
    </div>
    <button class="choice" onclick="detectivePerson(true)"><span class="ce">👥</span>Yes — it's about a person</button>
    <button class="choice" onclick="detectivePerson(false)"><span class="ce">🧠</span>No — it's not about a person</button>
  </div>`;
};

function detectivePerson(isPerson){
  if(!flow.detective) flow.detective = { step:0, isPerson:null, answers:{} };
  flow.detective.isPerson = isPerson;
  detectiveStep(1);
}

const DETECTIVE_QUESTIONS = [
  { n:1, tag:'Q1: HOW BIG IS IT?', title:'How big is this problem, really?',
    why: 'Sometimes our anger monster makes a small thing feel huge. Write what you actually think the size is.',
    placeholder: 'Is this a tiny thing, a medium thing, or a real big thing? Why?' },
  { n:2, tag:'Q2: IS IT TRUE?', title:'Is what you\'re thinking actually true?',
    why: 'Our anger monster is fast, but it sometimes guesses. Write what you actually know is true vs. what you\'re guessing.',
    placeholder: 'What do you really know? What might be a guess?' },
  { n:3, tag:'Q3: IS IT A BAD THING?', title:'Even if it IS true... is it actually bad?',
    why: 'Sometimes something is just different — not bad. Write whether this is a real bad thing or just something you didn\'t like.',
    placeholder: 'Is it actually a bad thing, or just not your favorite? What do you think?' },
  { n:4, tag:'Q4: CAN YOU CONTROL IT?', title:'Is this something you can change?',
    why: 'If you CAN do something — what a relief! If you can\'t, getting mad won\'t change it. Write what part is up to you.',
    placeholder: 'What part of this is up to YOU? What part isn\'t?' },
  { n:5, tag:'Q5: COMMENT OR JUDGMENT?', title:'Was it a comment or a judgment?',
    why: 'A <b>comment</b> is just noticing ("your shirt is purple"). A <b>judgment</b> is deciding good or bad ("your shirt looks weird"). Write which one this was.',
    placeholder: 'Was the person just noticing — or actually being unkind? How can you tell?' },
];

function detectiveStep(n){
  if(!flow.detective) flow.detective = { step:0, isPerson:null, answers:{} };
  flow.detective.step = n;

  // Skip Q5 entirely if not about a person
  if(n === 5 && flow.detective.isPerson === false){
    detectiveDone();
    return;
  }
  if(n > 5){ detectiveDone(); return; }

  const q = DETECTIVE_QUESTIONS[n-1];
  const totalSteps = flow.detective.isPerson === false ? 4 : 5;
  const progress = ((n-1) / totalSteps) * 100;
  const chips = DETECTIVE_CHIPS[n] || [];
  const existing = (flow.detective.answers && flow.detective.answers[n]) || '';

  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">${escapeHtml(q.tag)}</span>
    <div class="bar" style="margin:8px 0 6px"><i style="width:${progress}%"></i></div>
    <div style="font-weight:800;color:var(--orchid);font-size:13px">Question ${n} of ${totalSteps}</div>
    <div class="step-title" style="margin-top:8px">${escapeHtml(q.title)}</div>
    <div class="card tip"><p>${q.why}</p></div>
    <textarea id="dtext" placeholder="${escapeAttr(q.placeholder)}" style="min-height:110px;margin-top:8px">${escapeHtml(existing)}</textarea>
    <div class="step-sub" style="margin-top:10px">Stuck? Tap a starter to get going:</div>
    <div class="chipwrap">
      ${chips.map(c => `<button class="chip" onclick="detectiveChipSeed(${JSON.stringify(c).replace(/"/g,'&quot;')})">
        <span>${escapeHtml(c)}</span></button>`).join('')}
    </div>
    <button class="btn" onclick="detectiveNext()">Next</button>
    <button class="btn ghost" onclick="detectiveSkip()">Skip this one</button>
  </div>`;
}

function detectiveChipSeed(text){
  const box = $('dtext'); if(!box) return;
  if(!box.value.trim()){ box.value = text + ' '; }
  else { box.value = box.value.trim() + ' — ' + text + ' '; }
  box.focus();
  box.selectionStart = box.selectionEnd = box.value.length;
}

function detectiveNext(){
  const box = $('dtext');
  const text = box ? box.value.trim() : '';
  const n = flow.detective.step;
  if(text) flow.detective.answers[n] = text;
  detectiveStep(n + 1);
}

function detectiveSkip(){
  const n = flow.detective.step;
  // explicitly do NOT save anything for this question
  if(flow.detective.answers && flow.detective.answers[n]) delete flow.detective.answers[n];
  detectiveStep(n + 1);
}

function detectiveDone(){
  const a = (flow.detective && flow.detective.answers) || {};
  // count how many questions got real writing (≥3 chars)
  const engagedCount = Object.values(a).filter(t => t && t.trim().length >= 3).length;
  const thoughtful = engagedCount >= 3;

  // award points — base 1 for finishing, bonus 1 if thoughtful
  let pts = 1;
  if(thoughtful) pts += 1;
  state.points += pts;
  state.totalPoints += pts;

  // log the entry for the therapist report
  if(!state.detectiveEntries) state.detectiveEntries = [];
  state.detectiveEntries.unshift({
    ts: Date.now(),
    isPerson: !!flow.detective.isPerson,
    thought: flow.thought || '',
    answers: { ...a },
    engagedCount,
    type: 'detective',
  });
  save();

  // honest closing screen — no verdict, just "you did the work"
  const inSession = !!flow.tool;   // if invoked as a coping tool, give option to continue
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">YOU DID THE WORK 🌟</span>
    <div class="step-title" style="color:var(--grape-deep)">${engagedCount === 0 ? 'You came here. That counts.' : 'You wrote it down. That is the work.'}</div>
    <div class="duo" style="margin:8px auto">${buddy('happy',104)}</div>
    <div class="card">
      <p style="font-size:15px">You ${engagedCount === 0 ? 'looked at the questions' : 'thought through '+engagedCount+' of the questions'} — that's the part that's yours.
      Your therapist will love seeing this.</p>
      ${thoughtful ? `<p style="font-size:13px;color:var(--mint);font-weight:800;margin-top:8px">🌟 Thoughtful bonus — you really dug in</p>` : ''}
    </div>
    <div class="pointpop">+${pts} ⭐</div>
    ${inSession ? `
      <div class="card tip" style="margin-top:12px">
        <p>Want to do a calm-down tool now?</p>
        <button class="btn" style="margin-top:8px" onclick="afterTool()">Yes — calm down now 🧰</button>
        <button class="btn ghost" style="margin-top:6px" onclick="go('home')">No, I'm okay — back home</button>
      </div>
    ` : `
      <button class="btn" onclick="go('home')">Back home</button>
    `}
  </div>`;
}
renderers.express = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">GET THE FEELING OUT ✏️</span>
    <div class="step-title">Let the big feeling out — safely</div>
    <div class="step-sub">Feelings need somewhere to go. Pick a safe way:</div>
    ${EXPRESS.map(t=>`<button class="choice" onclick="pickOne(this)">
      <span class="ce">${t.slice(-2)}</span>${escapeHtml(t.slice(0,-2))}</button>`).join('')}
    <button class="btn go" onclick="afterTool()">I got it out ✅</button>
  </div>`;
};

/* ---------- AFTER PROMPTS (chips) ---------- */
let answeredCount=0;
renderers.afterPrompts=()=>{ answeredCount=0; flow.answers={}; showAfterQ(0); };
function showAfterQ(i){
  if(i>=AFTER_Q.length){
    flow.reflectDone = answeredCount>=5;
    // If she's logging right after a during-session, she already used tools —
    // skip the "did you use a tool?" branch and go straight to notes.
    if(flow.logging) go('reflectNotes');
    else go('reflectCoping');
    return;
  }
  const q=AFTER_Q[i], last=i===AFTER_Q.length-1;
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">${q.tag}</span>
    <div class="step-title">${escapeHtml(q.q)}</div>
    ${q.sub?`<div class="step-sub">${escapeHtml(q.sub)}</div>`:''}
    <div style="font-weight:800;color:var(--orchid);font-size:13px;margin-top:6px">Step ${i+1} of ${AFTER_Q.length}</div>
    <div class="bar" style="margin-bottom:4px"><i style="width:${(i/AFTER_Q.length)*100}%"></i></div>
    <div class="chipwrap" id="chips">${q.chips.map(c=>`
      <button class="chip" onclick="toggleChip(this,${q.type==='single'})">
        <span>${escapeHtml(c.slice(0,-2))}</span><span class="cx">${c.slice(-2)}</span></button>`).join('')}</div>
    <button class="moretoggle" onclick="showMore(${i})" id="moreBtn">+ add my own words</button>
    <div id="morebox" style="display:none">
      <textarea id="aq${i}" placeholder="Type anything you want to add (you don't have to)..."></textarea></div>
    <button class="btn" onclick="afterNext(${i})">${last?'Finish':'Next ›'}</button>
    <div class="skipnote">Tap as many as you want — or just tap Next. It's all okay. 💜</div>
  </div>`;
}
function toggleChip(el,single){
  if(single){ el.parentElement.querySelectorAll('.chip').forEach(c=>c.classList.remove('sel')); el.classList.add('sel'); }
  else el.classList.toggle('sel');
}
function showMore(i){ $('morebox').style.display='block'; $('moreBtn').style.display='none'; $('aq'+i).focus(); }
function afterNext(i){
  const picked=[...screen.querySelectorAll('.chip.sel')].map(c=>c.textContent.trim());
  const box=$('aq'+i); const typed=box?box.value.trim():'';
  flow.answers[i]={chips:picked,text:typed||''};
  if(picked.length>0 || (typed && typed.length>2)) answeredCount++;
  // Q index 2 is "Thoughtful or impulsive?" — intercept for Bubble moment
  if(i===2 && picked.length){
    const ans = picked[0].toLowerCase();
    if(ans.includes('impulsive') || ans.includes('bit of both')){
      flow.bubbleResumeQ = i+1;          // where to return after Bubble moment
      go('bubbleReassure'); return;
    }
  }
  showAfterQ(i+1);
}

/* =============================================================
   BUBBLE MOMENT — gentle reassurance + thoughtful do-over
   When Adelyn says she was impulsive (or "a bit of both"),
   Bubble herself speaks to her: you are not a bad kid.
   Then a tap-first prompt: what would the thoughtful you have done?
============================================================= */
renderers.bubbleReassure = () => {
  const mn=escapeHtml(state.monsterName||'Grumble');
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade" style="text-align:center">
    <span class="step-tag">A NOTE FROM BUBBLE 💜</span>
    <div style="margin:14px auto 8px">${buddy('happy',132)}</div>
    <div class="speech" style="margin:6px auto 14px;max-width:100%;text-align:left">
      <b>Hey — impulsive happens.</b><br><br>
      It doesn't make you a bad kid. It just means ${mn} was faster than you that time. Everybody does it sometimes — even grown-ups. 💜<br><br>
      What matters is that you're <b>here, looking back</b>. That right there is the thoughtful you in action. I'm proud of you.
    </div>
    <button class="btn" onclick="go('bubbleDoover')">Thanks, Bubble 💜</button>
  </div>`;
};

const DOOVER_OPTIONS = [
  'Taken a deep breath first 🐉',
  'Walked away to cool off 🚶',
  'Asked a grown-up for help 🙋',
  'Used a calm-down tool 🧰',
  'Said how I felt with words 🗣️',
  'Counted to 10 in my head 🔢',
  'Stepped away to my cozy spot 🛋️',
];
renderers.bubbleDoover = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">A LITTLE DO-OVER 🌟</span>
    <div class="step-title">If you could rewind it...</div>
    <div class="step-sub">What is one <b>thoughtful</b> thing you could try next time? Tap any that fit.</div>
    <div class="duo" style="margin:4px auto 6px">${buddy('',96)}</div>
    <div class="chipwrap">
      ${DOOVER_OPTIONS.map(o=>`<button class="chip" onclick="toggleChip(this,false)">
        <span>${escapeHtml(o.slice(0,-2))}</span><span class="cx">${o.slice(-2)}</span></button>`).join('')}
    </div>
    <button class="moretoggle" onclick="$('doomore').style.display='block';this.style.display='none'">+ add my own idea</button>
    <div id="doomore" style="display:none">
      <textarea id="dootext" placeholder="What thoughtful thing could you try next time?"></textarea>
    </div>
    <button class="btn" onclick="dooverNext()">That's my plan ✅</button>
    <div class="skipnote">No right answer — just imagining a do-over. 💜</div>
  </div>`;
};
function dooverNext(){
  const picked=[...screen.querySelectorAll('.chip.sel')].map(c=>c.textContent.trim());
  const box=$('dootext'); const typed=box?box.value.trim():'';
  flow.doover = { chips: picked, text: typed||'' };
  showAfterQ(flow.bubbleResumeQ || 3);
}

/* ---------- REFLECT: did you use a coping tool? (optional, smart branch) ---------- */
renderers.reflectCoping = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">WHAT HELPED?</span>
    <div class="step-title">Did you use a calm-down tool?</div>
    <div class="step-sub">Something like moving your body, dragon breath, a mantra, a prayer...</div>
    <div class="duo" style="margin:4px auto">${buddy('',92)}</div>
    <button class="choice" onclick="reflectCopingYes()"><span class="ce">✅</span>Yes, I used one!</button>
    <button class="choice" onclick="reflectCopingNo()"><span class="ce">🤔</span>No, not this time</button>
    <div class="skipnote">Either answer is okay — this just helps us learn together. 💜</div>
  </div>`;
};
/* YES -> pick which, and get celebrated */
function reflectCopingYes(){
  flow.usedCoping = true;
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">YOU USED A TOOL! 🌟</span>
    <div class="step-title">Amazing — which one helped?</div>
    <div class="card tip"><p>🎉 Reaching for a tool when you're angry is a <b>big win</b>. That's exactly the skill you're growing!</p></div>
    ${TOOLS.map(t=>`<button class="choice" onclick="reflectPickTool('${t.id}')">
      <span class="ce">${t.e}</span>${escapeHtml(t.name)}</button>`).join('')}
  </div>`;
}
function reflectPickTool(id){
  const t=TOOLS.find(x=>x.id===id);
  flow.tool = t;                       // recorded -> shows in therapist report
  go('reflectNotes');
}
/* NO -> no shame, turn it into a next-time plan */
function reflectCopingNo(){
  flow.usedCoping = false;
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">THAT'S OKAY 💜</span>
    <div class="step-title">What could you try next time?</div>
    <div class="card"><p>It's okay — hard moments happen, and you're here looking back, which is its own win. Let's make a plan: which tool could you try next time you feel that way?</p></div>
    ${TOOLS.map(t=>`<button class="choice" onclick="reflectPlanTool('${t.id}')">
      <span class="ce">${t.e}</span>${escapeHtml(t.name)}</button>`).join('')}
  </div>`;
}
function reflectPlanTool(id){
  const t=TOOLS.find(x=>x.id===id);
  flow.nextTimeTool = t;               // a plan, not a tool-used
  go('reflectNotes');
}

/* ---------- REFLECT: optional notes ---------- */
renderers.reflectNotes = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">TELL ME MORE 📝</span>
    <div class="step-title">Anything else about what happened?</div>
    <div class="step-sub">You can write the story in your own words — or skip it. Up to you.</div>
    <div class="card tip"><p>💜 The more you tell, the better the grown-ups who love you can understand and help. But only share what you want to.</p></div>
    <textarea id="rnotebox" placeholder="What happened? You can write as much or as little as you want..." style="min-height:120px"></textarea>
    <button class="btn" onclick="reflectNotesNext()">Next</button>
    <button class="btn ghost" onclick="reflectNotesSkip()">Skip for now</button>
  </div>`;
};
function reflectNotesNext(){
  const box=$('rnotebox');
  flow.notes = box ? box.value.trim() : '';
  if(flow.logging) finishFlow();
  else go('rate',{when:'after'});
}
function reflectNotesSkip(){
  flow.notes='';
  if(flow.logging) finishFlow();
  else go('rate',{when:'after'});
}

/* ---------- BRAVE ---------- */
renderers.bravePick = () => {
  flow={door:'brave'};
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade"><span class="step-tag">BE BRAVE 🦁</span>
    <div class="step-title">What feels scary?</div>
    <div class="step-sub">Brave doesn't mean not scared. It means trying anyway. 💪</div>
    ${FEARS.map((f,i)=>`<button class="choice" onclick="pickFear(${i})">
      <span class="ce">${f.e}</span>${escapeHtml(f.t)}</button>`).join('')}
  </div>`;
};
function pickFear(i){ flow.fear=FEARS[i].t; go('rate',{when:'now'}); }
renderers.braveStep = () => {
  screen.innerHTML=`${topbar('bravePick')}
  <div class="pad fade"><span class="step-tag">ONE SMALL STEP</span>
    <div class="step-title">Comfort first 💜</div>
    <div class="card"><p>First, let's get calm together. Take a dragon breath with Bubble. Then we'll try just <b>one small brave step</b> — only if you're ready.</p></div>
    <div style="margin:6px 0">${buddy('',104)}</div>
    <button class="btn" onclick="go('breathe',{next:'braveAfterBreath'})">🐉 Calm down first</button>
    <button class="btn go" onclick="go('braveDo')">I'm ready for a brave step ›</button>
  </div>`;
};
function braveAfterBreath(){ go('braveDo'); }
renderers.braveDo = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">YOUR BRAVE STEP</span>
    <div class="step-title">Pick one tiny step</div>
    <div class="step-sub">Not the whole scary thing — just a small next step you choose.</div>
    ${['Talk about it with someone I trust','Look at a picture of it','Get a little closer for 10 seconds',
       'Try it with someone next to me','Make a cozy plan for next time']
      .map(t=>`<button class="choice" onclick="pickOne(this)"><span class="ce">🦁</span>${escapeHtml(t)}</button>`).join('')}
    <button class="btn go" onclick="go('rate',{when:'after'})">I did my brave step! ✅</button>
    <div class="skipnote">It's okay if you're not ready today. Coming back is brave too. 💜</div>
  </div>`;
};

/* =============================================================
   PEOPLE PRACTICE — reading people generously, AND knowing
   when something genuinely crossed a line. Practiced calm.
   (Simple first version — for the therapist to shape.)
============================================================= */

/* Each scenario: a situation + the four "buckets" to sort it into.
   correctIsh = the bucket(s) that fit best — but the app never scolds;
   "actually unkind" is ALWAYS a valid, respected choice. */
const PEOPLE_SCENES = [
  { s:'Your friend laughed when you tripped, then said "you okay?" and helped you up.',
    best:'joke', note:'They laughed, but they checked on you and helped — that points to a friendly, not mean, laugh.' },
  { s:'Two friends were whispering and looked over at you.',
    best:'unsure', note:'This one is genuinely hard to know! Whispering near you could be about anything. When you can\'t tell — you can ask, instead of guessing the worst.' },
  { s:'You said hi and your friend walked past without answering.',
    best:'busy', note:'They might not have heard you, or had a lot on their mind. People miss things — it usually is not about you.' },
  { s:'A kid copied your drawing style and said "yours is so cool, I want to try it."',
    best:'kind', note:'Copying can feel weird — but they told you WHY: they liked it. That is a compliment.' },
  { s:'Someone bumped your tower and it fell, then said "oh no, sorry!"',
    best:'accident', note:'It knocked down — but "sorry" and "oh no" tell you they did not mean to.' },
  { s:'A friend said "that haircut is... interesting" and smirked.',
    best:'unkind', note:'Sometimes it really IS unkind — and your feelings about that are right. This is one where speaking up makes sense.' },
  { s:'Your friend picked someone else to be their partner today.',
    best:'busy', note:'Being picked second stings. But one choice on one day usually is not a message about you — friends mix it up.' },
  { s:'A classmate teased you about your shoes, you said "ha, yeah" — and they kept going after you went quiet.',
    best:'unkind', note:'A friendly joke STOPS when it stops being fun for you. Kept going after you went quiet — that crossed a line.' },
];
const BUCKETS = [
  { id:'joke',     e:'😄', label:'A friendly joke' },
  { id:'accident', e:'🤷', label:'An accident' },
  { id:'busy',     e:'🌀', label:'They were busy / didn\'t notice' },
  { id:'kind',     e:'💛', label:'Actually something kind' },
  { id:'unsure',   e:'🤔', label:'Hard to tell — I could ask' },
  { id:'unkind',   e:'💔', label:'That was actually unkind' },
];

renderers.peopleStart = () => {
  state.flow = { door:'people', round:0, score:0 };
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade">
    <span class="step-tag">PEOPLE PRACTICE 🧩</span>
    <div class="step-title">Reading people — your superpower</div>
    <div class="duo" style="margin:6px auto">${buddy('',104)}</div>
    <div class="card"><p>When something happens with friends, our mind makes a fast <b>guess</b> about why. Sometimes ${escapeHtml(state.monsterName||'the anger monster')} jumps in with "they were being mean!" — but lots of times it is something else entirely.</p></div>
    <div class="step-sub" style="margin-top:14px">Pick what you want to practice today:</div>
    <button class="door before" style="margin-top:8px" onclick="peopleRound()">
      <div class="emoji">🧩</div>
      <div><div class="dt">Sort situations</div><div class="ds">Mean? joke? accident?</div></div>
    </button>
    <button class="door after" style="margin-top:10px" onclick="go('commentVsJudgment')">
      <div class="emoji">🗣️</div>
      <div><div class="dt">Comment or judgment?</div><div class="ds">Is someone noticing — or judging?</div></div>
    </button>
    <div class="card tip" style="margin-top:14px"><p>💜 "That was actually unkind" is always okay to pick. If it WAS unkind, your feelings are right — and we practice what to do about it too.</p></div>
  </div>`;
};

/* =============================================================
   COMMENT vs JUDGMENT — practice telling them apart
   The piece Adelyn needs most: not every comment is a judgment.
============================================================= */
const COMMENT_SCENES = [
  // clear comments
  { s:'A friend says: "Your shirt is purple today."',     best:'comment',
    note:'They are <b>just noticing</b> — that is what a comment is. Not good, not bad. Purple is just purple.' },
  { s:'Someone says: "Your hair is in a ponytail."',      best:'comment',
    note:'A comment, not a judgment. They are just saying what they see.' },
  { s:'Someone says: "You\'re younger than me."',          best:'comment',
    note:'A simple fact — they are noticing, not putting you down. (Even if it stings a little!)' },
  { s:'Your teacher says: "You drew that really fast."',  best:'comment',
    note:'A comment. "Fast" is just describing — not saying fast is good or bad.' },

  // about-someone-else (the sneaky ones for Adelyn)
  { s:'Emily got picked first for the team today.',       best:'aboutother',
    note:'This is not even about you — it is about Emily. ${MN} might say "they like her better!" — but really, it is just one moment of one game.' },
  { s:'A friend says: "I really like Emily\'s drawing."',  best:'aboutother',
    note:'This is a <b>comment about Emily\'s drawing</b> — not a judgment of yours. Liking one thing does not mean disliking another.' },

  // questions (easy to mishear)
  { s:'Someone asks: "Why did you do it that way?"',      best:'question',
    note:'A <b>question</b>, not a judgment. People ask questions to understand. You can just answer: "I tried it this way."' },
  { s:'A friend says: "Are you mad?"',                     best:'question',
    note:'A question, not an accusation. They might be checking on you.' },

  // clear judgments (real ones)
  { s:'A kid says: "That shirt looks weird on you."',     best:'judgment',
    note:'That IS a judgment — they decided "weird" about something on you. Your feelings about that are right.' },
  { s:'Someone says: "Your drawing is bad."',             best:'judgment',
    note:'A judgment. "Bad" is a put-down, not a description. You can speak up.' },
  { s:'A classmate says: "You\'re too loud."',             best:'tricky',
    note:'This one could go either way. Said calmly, it is a comment (just noticing). Said meanly, it is a judgment. The <b>tone</b> tells you which.' },
];

renderers.commentVsJudgment = () => {
  state.flow = { door:'people', kind:'cvj', round:0, used:[], score:0 };
  screen.innerHTML=`${topbar('peopleStart')}
  <div class="pad fade">
    <span class="step-tag">COMMENT OR JUDGMENT? 🗣️</span>
    <div class="step-title">A really important difference</div>
    <div class="duo" style="margin:6px auto">${buddy('',96)}</div>
    <div class="card tip">
      <p>🗣️ A <b>comment</b> is when someone just <i>notices</i> something. "Your shirt is purple." It is not good or bad — just true.</p>
      <p>⚖️ A <b>judgment</b> is when someone decides good or bad about you. "Your shirt looks weird."</p>
      <p>${escapeHtml(state.monsterName||'Grumble')} sometimes hears a comment and shouts "they are judging you!" — when really, they were just noticing.</p>
    </div>
    <div class="card"><p>We will look at 5 things someone might say. Your job: figure out which kind it is.</p></div>
    <button class="btn" onclick="cvjRound()">Start practicing 🗣️</button>
  </div>`;
};

function cvjRound(){
  const f = state.flow;
  if(!f.used) f.used = [];
  if(f.round >= 5){ cvjDone(); return; }
  let pool = COMMENT_SCENES.map((_,i)=>i).filter(i=>!f.used.includes(i));
  if(!pool.length){ pool = COMMENT_SCENES.map((_,i)=>i); f.used = []; }
  const idx = pool[Math.floor(Math.random()*pool.length)];
  f.used.push(idx); f.scene = idx;
  const sc = COMMENT_SCENES[idx];
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">WHICH IS IT?</span>
    <div style="font-weight:800;color:var(--orchid);font-size:13px;margin-top:8px">Round ${f.round+1} of 5</div>
    <div class="bar" style="margin-bottom:8px"><i style="width:${(f.round/5)*100}%"></i></div>
    <div class="card"><h3 style="margin:0">Someone says:</h3>
      <p style="font-size:16px;color:var(--ink);margin-top:6px">${escapeHtml(sc.s)}</p></div>
    <div class="step-sub" style="margin-top:12px">Is that a comment or a judgment? Tap your best guess.</div>
    <button class="choice" onclick="cvjPick('comment')"><span class="ce">🗣️</span>A comment — just noticing</button>
    <button class="choice" onclick="cvjPick('aboutother')"><span class="ce">↔️</span>A comment, but about someone else (not me)</button>
    <button class="choice" onclick="cvjPick('question')"><span class="ce">❓</span>Actually a question, not a judgment</button>
    <button class="choice" onclick="cvjPick('tricky')"><span class="ce">🎭</span>Hard to tell — depends on tone</button>
    <button class="choice" onclick="cvjPick('judgment')"><span class="ce">⚖️</span>A judgment — they were being unkind</button>
  </div>`;
}

function cvjPick(pick){
  const f = state.flow;
  const sc = COMMENT_SCENES[f.scene];
  const mn = escapeHtml(state.monsterName||'Grumble');
  const correct = pick === sc.best;
  if(correct) f.score = (f.score||0) + 1;
  f.round++;

  let head, color;
  if(correct){
    head = 'Great reading! 🎯'; color = 'var(--mint)';
  } else if(pick === 'judgment' && sc.best !== 'judgment'){
    head = 'That is okay to feel.'; color = 'var(--orchid)';
  } else {
    head = 'Good thinking — and notice this.'; color = 'var(--orchid)';
  }

  const note = sc.note.replace(/\$\{MN\}/g, mn);

  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">LET'S LOOK CLOSER</span>
    <div class="step-title" style="color:${color}">${head}</div>
    <div class="card"><p style="font-size:14.5px">"${escapeHtml(sc.s)}"</p>
      <p style="font-size:14.5px;margin-top:8px">${note}</p></div>
    ${sc.best==='judgment' ? `
      <div class="card tip"><p>💪 When it really IS a judgment, you can speak up — kind and strong. Want to practice?</p>
        <button class="btn" style="margin-top:8px" onclick="go('boundaryPractice')">Practice speaking up 💪</button>
        <button class="btn ghost" style="margin-top:6px" onclick="cvjRound()">Next one ›</button>
      </div>` :
      `<button class="btn" onclick="cvjRound()">Next one ›</button>`}
  </div>`;
}

function cvjDone(){
  const f = state.flow;
  const session = { mode:'reflect', thoughtful: f.score>=3 };
  const pts = awardPoints(session);
  recordUsageDay();
  state.log.unshift({
    ts: Date.now(), door:'people',
    title:'Comment vs judgment practice', setoff:'', thought:'', tool:'Reading people',
    rateBefore:null, rateAfter:null,
    result:'sorted '+f.score+'/5 (comment vs judgment)', pts,
  });
  save();
  screen.innerHTML=`<div class="celebrate" id="celeb">
    <div style="font-size:26px">🗣️ 🎉 🗣️</div>
    <h2>Practice done!</h2>
    <div class="big">You practiced telling a <b>comment</b> from a <b>judgment</b> — one of the trickiest people-reading skills there is.</div>
    <div class="duo" style="margin:8px 0">${buddy('happy',100)}</div>
    <div class="big" style="color:var(--mint)">You got ${f.score} of 5 right 🌟</div>
    <div class="pointpop">+${pts} ⭐</div>
    <div class="big" style="margin-top:10px;font-size:13px">The more you practice, the more often you will hear a comment as a comment — not an attack.</div>
    <button class="btn" style="max-width:260px" onclick="go('home')">Back home</button>
    <button class="btn ghost" style="max-width:260px" onclick="go('commentVsJudgment')">Practice again 🗣️</button>
  </div>`;
  burst();
}

function peopleRound(){
  const f=state.flow;
  if(f.round>=5){ peopleDone(); return; }
  // pick a scene not yet used this session
  if(!f.used) f.used=[];
  let pool=PEOPLE_SCENES.map((_,i)=>i).filter(i=>!f.used.includes(i));
  if(!pool.length){ pool=PEOPLE_SCENES.map((_,i)=>i); f.used=[]; }
  const idx=pool[Math.floor(Math.random()*pool.length)];
  f.used.push(idx); f.scene=idx;
  const sc=PEOPLE_SCENES[idx];
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">SORT THIS MOMENT</span>
    <div style="font-weight:800;color:var(--orchid);font-size:13px;margin-top:8px">Round ${f.round+1} of 5</div>
    <div class="bar" style="margin-bottom:8px"><i style="width:${(f.round/5)*100}%"></i></div>
    <div class="card"><h3 style="margin:0">What happened:</h3>
      <p style="font-size:15.5px;color:var(--ink);margin-top:6px">${escapeHtml(sc.s)}</p></div>
    <div class="step-sub" style="margin-top:12px">What is your best guess about why? Tap one.</div>
    ${BUCKETS.map(b=>`<button class="choice" onclick="peoplePick('${b.id}')">
      <span class="ce">${b.e}</span>${escapeHtml(b.label)}</button>`).join('')}
  </div>`;
}

function peoplePick(bucketId){
  const f=state.flow;
  const sc=PEOPLE_SCENES[f.scene];
  const pickedUnkind = bucketId==='unkind';
  const sceneIsUnkind = sc.best==='unkind';
  // we never say "wrong" — we affirm, then gently widen the view
  let head, body, headColor;
  if(bucketId===sc.best){
    head='Great reading! 🧩'; headColor='var(--mint)';
    body=sc.note;
  } else if(pickedUnkind && !sceneIsUnkind){
    head='That is okay to feel.'; headColor='var(--orchid)';
    body='If it felt unkind, your feeling counts. Here is one other way to see it too: '+sc.note;
  } else if(!pickedUnkind && sceneIsUnkind){
    head='Good thinking — and notice this.'; headColor='var(--orchid)';
    body='Looking for the kind reason is a great habit! This one, though, is worth a second look: '+sc.note;
  } else {
    head='Nice — here is another angle.'; headColor='var(--orchid)';
    body=sc.note;
  }
  f.round++;
  if(bucketId===sc.best) f.score++;
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">LET'S LOOK CLOSER</span>
    <div class="step-title" style="color:${headColor}">${head}</div>
    <div class="card"><p style="font-size:15px;color:var(--ink)">${escapeHtml(body)}</p></div>
    ${sceneIsUnkind?`
      <div class="card tip"><p>💪 When something really is unkind, you can set a <b>kind, strong boundary</b> — speak up without being mean back. Want to practice that?</p></div>
      <button class="btn" onclick="go('boundaryPractice')">Practice speaking up 💪</button>
      <button class="btn ghost" onclick="peopleRound()">Next moment ›</button>`
    : `<button class="btn" onclick="peopleRound()">Next moment ›</button>`}
  </div>`;
}

/* boundary practice — kind + strong ways to speak up */
const BOUNDARY_LINES = [
  '"That one didn\'t feel good to me. Please stop."',
  '"I know you\'re joking, but I don\'t like that joke."',
  '"I need a minute — that hurt my feelings."',
  '"Please don\'t talk about me like that."',
  '"I want to keep being friends, and that wasn\'t kind."',
];
renderers.boundaryPractice = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">SPEAKING UP 💪</span>
    <div class="step-title">Kind AND strong</div>
    <div class="step-sub">A boundary is not being mean back. It is calmly saying what is okay and not okay. Tap one to practice saying it out loud:</div>
    ${BOUNDARY_LINES.map(l=>`<button class="choice" onclick="pickOne(this)">
      <span class="ce">💪</span>${escapeHtml(l)}</button>`).join('')}
    <div class="card tip"><p>🌟 Strong does not mean loud or mean. A calm, clear voice is the strongest of all.</p></div>
    <div class="card"><p style="font-size:13.5px"><b>Honest thing to know:</b> Sometimes when you speak up, the other person listens — and sometimes they don't. <b>That's their choice, not yours.</b> Saying it kindly and clearly is the part that is up to you. That's the win, no matter how they react.</p></div>
    <button class="btn go" onclick="peopleRound()">I practiced it ✅</button>
  </div>`;
};

function peopleDone(){
  const f=state.flow;
  // People Practice earns points like a reflection-level effort
  const session={mode:'reflect', thoughtful:f.score>=3};
  const pts=awardPoints(session);
  recordUsageDay();
  state.log.unshift({
    ts:Date.now(), door:'people',
    title:'People practice', setoff:'', thought:'', tool:'Reading people',
    rateBefore:null, rateAfter:null,
    result:'sorted '+f.score+'/5 with kind thinking', pts,
  });
  save();
  screen.innerHTML=`<div class="celebrate" id="celeb">
    <div style="font-size:26px">🧩 🎉 🧩</div>
    <h2>Practice done!</h2>
    <div class="big">You practiced reading people in a kind, fair way — and remembering when to speak up.</div>
    <div class="duo" style="margin:8px 0">${buddy('happy',100)}</div>
    <div class="big" style="color:var(--mint)">You sorted ${f.score} of 5 with generous thinking 🧩</div>
    <div class="pointpop">+${pts} ⭐</div>
    <div class="big" style="margin-top:10px;font-size:13px">The more you practice, the easier it gets to tell a real problem from a misread one.</div>
    <button class="btn" style="max-width:260px" onclick="go('home')">Back home</button>
    <button class="btn ghost" style="max-width:260px" onclick="go('peopleStart')">Practice again 🧩</button>
  </div>`;
  burst();
}

/* ---------- FINISH FLOW — uses calcPoints/awardPoints ---------- */
function finishFlow(){
  const mode = flow.door==='before'?'warning'
             : flow.door==='during'?'during'
             : flow.door==='brave'?'brave':'reflect';
  const session = { mode, thoughtful: !!flow.reflectDone };
  const pts = awardPoints(session);
  if(state.monsterShrink<6) state.monsterShrink++;
  recordUsageDay();   // streak + usage stats

  // build log entry (with composite-key fields for sync dedupe)
  let setoff='', thoughtful='';
  if(flow.door==='after' && flow.answers){
    setoff = (flow.answers[4]&&flow.answers[4].chips[0])||'';
    thoughtful = (flow.answers[2]&&flow.answers[2].chips[0])||'';
  }
  const entry = {
    ts: Date.now(),
    door: flow.door,
    title: flow.warn||flow.fear||(flow.door==='during'?'Got help with anger':'Reflected on a moment'),
    setoff: setoff || flow.warn || '',
    thought: flow.thought || '',
    tool: (flow.toolsUsed && flow.toolsUsed.length)
      ? flow.toolsUsed.join(' → ')
      : (flow.tool ? flow.tool.name : ''),
    toolsCount: flow.toolsUsed ? flow.toolsUsed.length : (flow.tool ? 1 : 0),
    gotGrownUp: !!flow.gotGrownUp,
    nextTimeTool: flow.nextTimeTool ? flow.nextTimeTool.name : '',
    usedCoping: flow.usedCoping,
    notes: flow.notes || '',
    doover: flow.doover ? (
      (flow.doover.chips||[]).join('; ')
        + (flow.doover.text ? (flow.doover.chips&&flow.doover.chips.length?' | ':'') + flow.doover.text : '')
    ) : '',
    parentNotes: [],          // populated only via the parent zone
    rateBefore: flow.rateBefore!=null?flow.rateBefore:null,
    rateAfter: flow.rateAfter!=null?flow.rateAfter:null,
    result: thoughtful || (flow.door==='before'?'caught early':'logged'),
    pts,
  };
  state.log.unshift(entry);
  save();
  go('celebrate',{pts,entry});
}
renderers.celebrate = (d) => {
  const e=d.entry;
  const hasPair=e.rateBefore!=null && e.rateAfter!=null;
  const dropped=hasPair && e.rateAfter<e.rateBefore;
  const calm = e.rateAfter!=null && e.rateAfter<4;   // below 4 -> offer calm menu
  // Specific cheerleader line tied to what she just did
  let specific = '';
  if(hasPair && dropped){
    specific = `You came to me at a ${e.rateBefore}, and you came down to a ${e.rateAfter}. That took real work.`;
  } else if(e.door==='before'){
    specific = `You caught a warning sign before it got big. That is the thoughtful you in action.`;
  } else if(e.door==='brave'){
    specific = `You did a brave step today. That is yours, and no one can take it from you.`;
  } else if(e.door==='after'){
    specific = `You looked back at a hard moment instead of avoiding it. That takes real courage.`;
  } else {
    specific = `You showed up. That is the work, and you did it.`;
  }
  const labels={before:'You caught a warning sign early!',during:'You used the app while angry!',
    after: d.entry.result&&/thought/i.test(d.entry.result)?'Thoughtful reflection! 🌟':'You looked back and reflected!',
    brave:'You took a brave step!',people:'You practiced reading people!'};
  const emojis={before:'🌤️',during:'🔥',after:'📖',brave:'🦁',people:'🧩'};
  screen.innerHTML=`<div class="celebrate" id="celeb">
    <div style="font-size:26px">${emojis[e.door]} 🎉 ${emojis[e.door]}</div>
    <h2>Way to go!</h2><div class="big">${escapeHtml(labels[e.door]||'Great job!')}</div>
    <div class="duo" style="margin:6px 0">${buddy('happy',92)}${monster('',monsterSize()-16,monsterMad())}</div>
    ${hasPair?`<div class="ratepair">
      <div class="ratebubble" style="background:${feelWord(e.rateBefore)[1]}">${e.rateBefore}</div>
      <span class="arrow">➜</span>
      <div class="ratebubble" style="background:${feelWord(e.rateAfter)[1]}">${e.rateAfter}</div></div>
      <div class="big" style="${dropped?'color:var(--mint)':''};font-size:15px">${escapeHtml(specific)}</div>`
      :`<div class="big" style="font-size:15px">${escapeHtml(specific)}</div>`}
    <div class="pointpop">+${d.pts} ⭐</div>
    <div class="big" style="margin-top:10px;font-size:13px">${escapeHtml(state.monsterName)} got smaller — you and Bubble are helping it calm down!</div>
    ${calm ? `
      <div class="card" style="margin-top:16px;background:#eaf4ec;text-align:left">
        <h3 style="margin:0;color:var(--grape-deep);text-align:center">You are in a good place 🌟</h3>
        <p style="text-align:center;margin:6px 0 10px">Want to do something good with this calm?</p>
        <button class="choice" onclick="go('gratitude')"><span class="ce">☀️</span>Sunshine</button>
        <button class="choice" onclick="go('peopleStart')"><span class="ce">🧩</span>People Practice</button>
        <button class="choice" onclick="go('rewards')"><span class="ce">🎁</span>Look at my rewards</button>
        <button class="choice" onclick="go('closet')"><span class="ce">🎩</span>Go to my closet</button>
      </div>
      <button class="btn ghost" style="max-width:260px;margin-top:10px" onclick="go('home')">Just back home</button>`
    : `
      <button class="btn" style="max-width:260px" onclick="go('home')">Back home</button>
      <button class="btn ghost" style="max-width:260px" onclick="go('progress')">See my wins 🏆</button>`}
  </div>`;
  burst();
};
function burst(){
  const cols=['#ff7ec9','#8b3fb5','#ffc23f','#3fd6a8','#5b8ff5','#ff8a3f'];
  const host=$('celeb'); if(!host) return;
  for(let i=0;i<44;i++){
    const c=document.createElement('div'); c.className='confetti';
    c.style.left=Math.random()*100+'%'; c.style.background=cols[i%cols.length];
    c.style.animation=`fall ${1.6+Math.random()*1.8}s ${Math.random()*.5}s linear forwards`;
    if(i%3===0) c.style.borderRadius='50%';
    host.appendChild(c);
  }
}

/* ---------- PROGRESS ---------- */
renderers.progress = () => {
  const pct=Math.round((state.monsterShrink/6)*100);
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade"><span class="step-tag">MY WINS 🏆</span>
    <div class="step-title">Look how you're growing!</div>
    <div class="shrinkbox" style="text-align:center;margin-top:10px">
      <div class="duo">${buddy('',84)}${monster('',monsterSize(),monsterMad())}</div>
      <div style="font-weight:800;color:var(--grape-deep);margin-top:8px">
        ${state.monsterShrink>=6?escapeHtml(state.monsterName)+' is calm and tiny now! 🌟'
          :'You + Bubble are helping '+escapeHtml(state.monsterName)+' calm down'}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div style="font-size:12px;font-weight:700;color:var(--ink-soft);margin-top:6px">
        Every win helps the anger monster get smaller and calmer</div>
    </div>
    <div class="card" style="display:flex;align-items:center;gap:14px">
      <div style="font-size:38px">⭐</div>
      <div><div style="font-family:'Baloo 2',cursive;font-size:30px;color:var(--grape-deep)">${state.points}</div>
      <div style="font-weight:700;color:var(--ink-soft);font-size:13px">points to spend · ${state.totalPoints} earned all-time</div></div>
    </div>
    <div class="door-q" style="margin-top:18px">My moments</div>
    ${state.log.length?state.log.slice(0,30).map(l=>{
      const sub=(l.tool?'Used: '+escapeHtml(l.tool)+' · ':'')
        +(l.rateBefore!=null&&l.rateAfter!=null?'Feeling '+l.rateBefore+' → '+l.rateAfter:escapeHtml(l.result||'logged'));
      const emoji={before:'🌤️',during:'🔥',after:'📖',brave:'🦁',people:'🧩'}[l.door]||'⭐';
      return `<div class="logitem"><span class="lemoji">${emoji}</span>
        <div style="flex:1"><div class="lt">${escapeHtml(l.title)}</div><div class="ls">${sub}</div></div>
        <span class="badge">+${l.pts}⭐</span></div>`;
    }).join('')
      :`<div class="card"><p>No moments yet. Try a door on the home screen — every try is a win! 💜</p></div>`}
    <button class="btn" onclick="go('home')">Back home</button>
  </div>`;
};

/* ---------- CLOSET ---------- */
const ITEMS=[
  {id:'hat',    e:'🎩',n:'Top Hat',     c:5},
  {id:'crown',  e:'👑',n:'Crown',       c:10},
  {id:'bow',    e:'🎀',n:'Big Bow',     c:8},
  {id:'shades', e:'🕶️',n:'Cool Shades', c:6},
  {id:'star',   e:'⭐',n:'Star Pal',    c:7},
  {id:'rainbow',e:'🌈',n:'Rainbow Trail',c:12},
];
/* =============================================================
   REWARDS — real-world rewards (parent-set, two-step claiming)
============================================================= */
renderers.rewards = () => {
  const rewards = state.rewards || [];
  const pending = state.pendingClaims || [];
  // points "held" by pending claims so she can't double-claim with the same points
  const heldPts = pending.reduce((s,c)=>s+(c.cost||0),0);
  const spendable = Math.max(0, state.points - heldPts);
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade">
    <span class="step-tag">REWARDS 🎁</span>
    <div class="step-title">Real-world rewards</div>
    <div class="step-sub">Trade your points for fun things — picked by you and a grown-up!</div>

    <div class="card" style="display:flex;align-items:center;gap:14px">
      <div style="font-size:38px">⭐</div>
      <div style="flex:1">
        <div style="font-family:'Baloo 2',cursive;font-size:30px;color:var(--grape-deep);line-height:1">${spendable}</div>
        <div style="font-weight:700;color:var(--ink-soft);font-size:13px">points to spend</div>
      </div>
      ${heldPts?`<div style="text-align:right">
        <div style="font-size:12px;font-weight:800;color:var(--orchid)">${heldPts}⭐</div>
        <div style="font-size:10.5px;color:var(--ink-soft);font-weight:700">waiting for grown-up</div></div>`:''}
    </div>

    ${pending.length?`
      <div class="door-q" style="margin-top:18px">Waiting for grown-up ⏳</div>
      ${pending.map(c=>`
        <div class="card" style="display:flex;gap:12px;align-items:center;background:#fff3d6">
          <div style="font-size:24px">⏳</div>
          <div style="flex:1">
            <div style="font-weight:800;font-size:15px">${escapeHtml(c.name)}</div>
            <div style="font-size:12px;color:var(--ink-soft);font-weight:700">Asked: ${escapeHtml(new Date(c.ts).toLocaleString())}</div>
          </div>
          <div style="font-weight:800;color:var(--tangerine)">${c.cost}⭐</div>
        </div>`).join('')}`:''}

    <div class="door-q" style="margin-top:18px">Available rewards</div>
    ${rewards.length ? rewards.map(r=>{
      const alreadyPending = pending.some(c=>c.rewardId===r.id);
      const canGet = spendable >= r.cost && !alreadyPending;
      return `<div class="card" style="display:flex;gap:12px;align-items:center">
        <div style="font-size:30px">🎁</div>
        <div style="flex:1">
          <div style="font-weight:800;font-size:16px">${escapeHtml(r.name)}</div>
          <div style="font-size:13px;color:var(--ink-soft);font-weight:700">${r.cost} ⭐</div>
        </div>
        ${alreadyPending
          ? `<div class="pill" style="background:#fff3d6;color:#c8530f">Waiting ⏳</div>`
          : canGet
            ? `<button class="btn" style="width:auto;padding:10px 18px;margin:0" onclick="claimReward('${r.id}')">Get it!</button>`
            : `<div class="pill" style="background:#eee;color:#999">Locked 🔒</div>`}
      </div>`;
    }).join('') : `<div class="card"><p>A grown-up hasn't set up rewards yet. Ask them to add some in the parent zone!</p></div>`}

    ${(state.earnedRewards && state.earnedRewards.length) ? `
      <div class="door-q" style="margin-top:18px">Earned ✨</div>
      ${state.earnedRewards.slice(0,8).map(e=>`
        <div class="card" style="display:flex;gap:12px;align-items:center;background:#eaf4ec">
          <div style="font-size:22px">✨</div>
          <div style="flex:1">
            <div style="font-weight:800;font-size:14.5px">${escapeHtml(e.name)}</div>
            <div style="font-size:12px;color:var(--ink-soft);font-weight:700">${escapeHtml(new Date(e.ts).toLocaleString())}</div>
          </div>
          <div class="pill" style="background:#3fd6a8;color:#fff">Earned ✓</div>
        </div>`).join('')}`:''}

    <button class="btn" onclick="go('home')">Back home</button>
  </div>`;
};

function claimReward(rewardId){
  const r = (state.rewards||[]).find(x=>x.id===rewardId);
  if(!r) return;
  if(!state.pendingClaims) state.pendingClaims = [];
  // prevent duplicate pending claims for the same reward
  if(state.pendingClaims.some(c=>c.rewardId===rewardId)) return;
  const heldPts = state.pendingClaims.reduce((s,c)=>s+(c.cost||0),0);
  if(state.points - heldPts < r.cost) return; // not enough spendable
  state.pendingClaims.unshift({
    claimId: 'c'+Date.now()+'_'+Math.floor(Math.random()*1000),
    rewardId, name: r.name, cost: r.cost, ts: Date.now(),
  });
  save();
  // show a quick confirmation
  screen.innerHTML=`<div class="celebrate" id="celeb">
    <div style="font-size:32px">🎁 ✨ 🎁</div>
    <h2>Reward requested!</h2>
    <div class="big">You asked for: <b>${escapeHtml(r.name)}</b></div>
    <div class="duo" style="margin:8px 0">${buddy('happy',104)}</div>
    <div class="big" style="color:var(--orchid)">Now a grown-up will look at it and say yes! 🌟</div>
    <div class="big" style="font-size:13px;margin-top:6px">Your ${r.cost} points are held for now. They go back if a grown-up can't say yes.</div>
    <button class="btn" style="max-width:260px" onclick="go('rewards')">Back to rewards</button>
    <button class="btn ghost" style="max-width:260px" onclick="go('home')">Home</button>
  </div>`;
  burst();
}

/* =============================================================
   GRATITUDE & FAITH — gentle daily noticing + "I'm loved" reminders
============================================================= */

/* Gratitude chip starters — mix of questions, I-statements, and noticing.
   Pre-built so she has something to lean on if blank. */
const GRATITUDE_CHIPS = [
  'What made you smile today?',
  'Who was nice to you today?',
  'What was the best part of today?',
  'I had fun when...',
  'I felt happy when...',
  'I liked it when...',
  'Today I got to...',
  'I\'m glad about...',
  'Today I noticed...',
  'A good thing today was...',
];

/* Faith messages — comfort + identity + made-on-purpose, all woven together.
   Each item: { msg, verse }. Easy to add more later — just append. */
const FAITH_MESSAGES = [
  { msg:'Hey, Adelyn — even on hard days, Jesus loves you. Always. Nothing you do or do not do changes that.',
    verse:'"The Lord is near to the brokenhearted." — Psalm 34:18' },
  { msg:'You don\'t have to be happy, or grateful, or anything special. You are loved exactly how you are right now.',
    verse:'"I have loved you with an everlasting love." — Jeremiah 31:3' },
  { msg:'On rough days, God is even closer. He does not pull away when you are sad — he stays.',
    verse:'"He will never leave you nor forsake you." — Deuteronomy 31:6' },
  { msg:'You are precious. Not because of what you did — just because you are you.',
    verse:'"You are precious in my sight, and I love you." — Isaiah 43:4' },
  { msg:'It is okay to not be okay. Jesus is right here with you.',
    verse:'"Cast all your anxiety on him, because he cares for you." — 1 Peter 5:7' },
  { msg:'God made you on purpose. He is glad you are here today, even if today was hard.',
    verse:'"You are fearfully and wonderfully made." — Psalm 139:14' },
  /* Identity / made-on-purpose */
  { msg:'You were made on purpose. Every part of you — even the parts that feel different — Jesus put there on purpose. You are not a mistake. You are a plan.',
    verse:'"For we are God\'s handiwork, created in Christ Jesus to do good works." — Ephesians 2:10' },
  { msg:'The world needs YOU. Not a copy of someone else. You. Jesus made you different for a reason.',
    verse:'"Before I formed you in the womb I knew you." — Jeremiah 1:5' },
  { msg:'You are not "too much" or "not enough." You are exactly who you were made to be.',
    verse:'"You are fearfully and wonderfully made." — Psalm 139:14' },
  { msg:'The things that feel hard about being you? Those are going to make you strong. They will help you understand other kids who feel the same way. That is a gift.',
    verse:'"You are God\'s chosen people, holy and dearly loved." — Colossians 3:12' },
  { msg:'When you feel like people are picking on you — remember: Jesus picked YOU. He made you the way you are because the world needs exactly that.',
    verse:'"You are precious in my sight, and I love you." — Isaiah 43:4' },
  { msg:'You do not have to be like anyone else. Being you is the whole point. Jesus is so glad you are you.',
    verse:'"For we are God\'s handiwork." — Ephesians 2:10' },
  { msg:'Your feelings are big sometimes — and that is because you care big. That is a beautiful thing, even when it is hard.',
    verse:'"The Lord is near to the brokenhearted." — Psalm 34:18' },
];

/* =============================================================
   TELL BUBBLE WHAT HAPPENED — the honesty path
   When something didn't work, or a friend let her down, or
   she just needs to vent. Validation + name-what-she-controlled.
============================================================= */
const TELLBUBBLE_PATHS = [
  { id:'didntwork', e:'🪫', label:"I tried something and it didn't work",
    prompt:"Tell me what you tried, and how it went.",
    placeholder:"What did you try? What happened after?" },
  { id:'friend',    e:'💔', label:"Something with a friend didn't go well",
    prompt:"Tell me what happened with your friend.",
    placeholder:"What did they do or say? How did it feel?" },
  { id:'else',      e:'🌪️', label:"Something else is bugging me",
    prompt:"Tell me what's bugging you.",
    placeholder:"What happened? How are you feeling?" },
];
const CONTROLLED_CHIPS = [
  'I tried hard',
  'I used my words',
  'I asked for help',
  'I walked away',
  'I stayed calm',
  'I told the truth',
  'I tried a tool',
  'I came back here',
];

renderers.tellBubble = () => {
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade">
    <span class="step-tag">TELL BUBBLE 💜</span>
    <div class="step-title">Hey. What happened?</div>
    <div class="duo" style="margin:6px auto">${buddy('',108)}</div>
    <div class="card"><p>I am here. Pick whichever fits best — or "something else" works too.</p></div>
    ${TELLBUBBLE_PATHS.map(p=>`
      <button class="choice" onclick="tellBubblePath('${p.id}')">
        <span class="ce">${p.e}</span>${escapeHtml(p.label)}</button>`).join('')}
    ${(state.tellBubbles && state.tellBubbles.length) ? `
      <div class="door-q" style="margin-top:18px">Things you've told me before</div>
      ${state.tellBubbles.slice(0,3).map(t => `
        <div class="card" style="background:#f5edfb">
          <div style="font-size:11px;color:var(--ink-soft);font-weight:800">${escapeHtml(new Date(t.ts).toLocaleString())}</div>
          <div style="font-size:14px;color:var(--ink);font-weight:600;margin-top:4px">💜 ${escapeHtml((t.text||'').slice(0,140))}${(t.text||'').length>140?'...':''}</div>
        </div>`).join('')}` : ''}
  </div>`;
};

function tellBubblePath(id){
  const path = TELLBUBBLE_PATHS.find(p=>p.id===id);
  if(!path) return;
  flow.tellBubble = { pathId:id };
  go('tellBubbleStory');
}

renderers.tellBubbleStory = () => {
  const path = TELLBUBBLE_PATHS.find(p=>p.id===(flow.tellBubble&&flow.tellBubble.pathId));
  if(!path){ go('tellBubble'); return; }
  screen.innerHTML=`${topbar('tellBubble')}
  <div class="pad fade">
    <span class="step-tag">${path.e} I'M LISTENING</span>
    <div class="step-title">${escapeHtml(path.prompt)}</div>
    <div class="duo" style="margin:6px auto">${buddy('',96)}</div>
    <div class="step-sub">Take your time. There is no right way to say it.</div>
    <textarea id="tbtext" placeholder="${escapeAttr(path.placeholder)}" style="min-height:130px;margin-top:8px"></textarea>
    <button class="btn" onclick="tellBubbleSubmit()">I told Bubble 💜</button>
    <button class="btn ghost" onclick="go('tellBubble')">Back</button>
  </div>`;
};

function tellBubbleSubmit(){
  const box = $('tbtext');
  const text = box ? box.value.trim() : '';
  flow.tellBubble.text = text;
  // Bubble's response — validation first, then name-what-she-controlled, then gentle invite
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">BUBBLE HEARD YOU 💜</span>
    <div class="step-title">Thank you for telling me.</div>
    <div class="duo" style="margin:8px auto">${buddy('happy',116)}</div>
    <div class="card" style="background:#f5edfb">
      <p style="font-size:15.5px;color:var(--ink);line-height:1.5">
        That sounds hard. I am sorry that happened. Your feelings about it make sense. 💜
      </p>
    </div>
    <div class="card">
      <h3 style="margin:0;color:var(--grape-deep)">Here is something true:</h3>
      <p style="font-size:14.5px;margin-top:6px;line-height:1.5">
        You did the part <b>that was yours</b> — you showed up here and told me.
        What other people did, or whether something worked, is <b>not</b> all on you.
        Some of that is up to other people, and some of it is just how life goes sometimes.
      </p>
    </div>
    <div class="step-sub" style="margin-top:14px">If you want, tap any parts that <b>you</b> did. Or skip this step.</div>
    <div class="chipwrap">
      ${CONTROLLED_CHIPS.map(c => `<button class="chip" onclick="toggleChip(this,false)">
        <span>${escapeHtml(c)}</span></button>`).join('')}
    </div>
    <button class="btn" onclick="tellBubbleDone()">Done telling Bubble ✅</button>
    <button class="btn ghost" onclick="tellBubbleDone()">Skip and finish</button>
  </div>`;
};

function tellBubbleDone(){
  const controlled = [...screen.querySelectorAll('.chip.sel')].map(c=>c.textContent.trim());
  if(!state.tellBubbles) state.tellBubbles = [];
  state.tellBubbles.unshift({
    ts: Date.now(),
    path: flow.tellBubble.pathId,
    text: flow.tellBubble.text || '',
    controlled,
    type: 'tellbubble',
  });
  // earn 1 point for showing up
  state.points += 1;
  state.totalPoints += 1;
  save();
  screen.innerHTML=`<div class="celebrate" id="celeb">
    <div style="font-size:28px">💜 ✨ 💜</div>
    <h2 style="color:var(--grape-deep)">Thank you for trusting me.</h2>
    <div class="duo" style="margin:10px 0">${buddy('happy',104)}</div>
    <div class="big" style="font-size:14.5px">Telling Bubble is how we keep getting through hard things together.</div>
    <div class="pointpop">+1 ⭐</div>
    <button class="btn" style="max-width:260px" onclick="go('home')">Back home</button>
  </div>`;
  burst();
}

/* =============================================================
   DISTRACT ME — coping tool: facts, ideas, jokes, bubbles, math
   Lives only inside the coping tool picker. Each sub-tool earns
   1 point per session (not per item). No timers, no streaks,
   no sound. The goal is calming, not scoring.
============================================================= */

const DISTRACT_FACTS = [
  "Octopuses have three hearts and blue blood.",
  "A group of flamingos is called a flamboyance.",
  "Honey never spoils — archaeologists found 3,000-year-old honey still good to eat.",
  "Cows have best friends and get stressed when they're apart.",
  "A snail can sleep for three years at a time.",
  "Bananas are berries, but strawberries aren't.",
  "Sea otters hold hands while they sleep so they don't drift apart.",
  "The tongue is the strongest muscle in the body for its size.",
  "A day on Venus is longer than a year on Venus.",
  "Sharks existed before trees did.",
  "Wombat poop is cube-shaped.",
  "Butterflies taste with their feet.",
  "The shortest war in history lasted only 38 minutes.",
  "Your brain uses about 20% of your body's energy.",
  "Penguins propose to each other with pebbles.",
  "Cats have 32 muscles in each ear.",
  "Lightning is five times hotter than the surface of the sun.",
  "An ostrich's eye is bigger than its brain.",
  "Bees can recognize human faces.",
  "Goats have rectangular pupils.",
  "Polar bears have black skin under their white fur.",
  "Slugs have four noses.",
  "The Eiffel Tower can grow about 6 inches taller in the summer.",
  "Dolphins call each other by name using unique whistles.",
  "Your nose can remember 50,000 different scents.",
  "Crows can remember human faces for years.",
  "A blue whale's heart is as big as a small car.",
  "Apples float because they are 25% air.",
  "There are more stars in space than grains of sand on every beach on Earth.",
  "Otters carry a favorite rock in a pouch under their arm.",
];

const DISTRACT_IDEAS = [
  "Find 5 things in this room that are the color blue 🔵",
  "Count backwards from 100 by 7s 🔢",
  "Name an animal for every letter of the alphabet 🐇",
  "Stretch like a cat 🐱",
  "Do 10 jumping jacks 🤸",
  "Hum your favorite song 🎵",
  "Look out a window and count the clouds ☁️",
  "Draw something silly on paper ✏️",
  "List your top 3 favorite books 📚",
  "Wiggle every finger one at a time 👋",
  "Try to lick your elbow (you can't — it's funny to try) 😆",
  "Spin in a circle 3 times 🌀",
  "Stand on one foot for as long as you can 🦩",
  "Whisper your name very slowly 🤫",
  "Look at something far away, then close, then far again 👀",
  "Touch your toes 🦶",
  "Name 5 things you can hear right now 👂",
  "Find something soft and pet it 🧸",
  "Think of your favorite memory and replay it in your head 💭",
  "Make the silliest face you can in a mirror 🤪",
  "Stretch your arms way up high 🙆",
  "Count how many letters are in your full name ✏️",
  "Wiggle your nose like a bunny 🐰",
  "Pretend you're a tree in the wind 🌳",
  "Hop on one foot 10 times 🦘",
];

const DISTRACT_JOKES = [
  ["What do you call a bear with no teeth?", "A gummy bear!"],
  ["Why don't scientists trust atoms?", "Because they make up everything!"],
  ["What do you call a fish wearing a crown?", "Your royal hi-ness!"],
  ["Why did the math book look sad?", "It had too many problems."],
  ["What's brown and sticky?", "A stick!"],
  ["Why can't a bicycle stand up by itself?", "It's two-tired!"],
  ["What did one wall say to the other wall?", "I'll meet you at the corner!"],
  ["Why did the cookie go to the doctor?", "It was feeling crumby."],
  ["What do you call cheese that isn't yours?", "Nacho cheese!"],
  ["How does the moon cut its hair?", "Eclipse it."],
  ["What's a vampire's favorite fruit?", "A blood orange!"],
  ["Why was the broom late?", "It overswept."],
  ["What did the ocean say to the shore?", "Nothing — it just waved."],
  ["What do you call a sleeping bull?", "A bulldozer!"],
  ["Why did the scarecrow win an award?", "He was outstanding in his field!"],
  ["What kind of shoes do ninjas wear?", "Sneakers!"],
  ["Why don't eggs tell jokes?", "They'd crack each other up."],
  ["What's a tornado's favorite game?", "Twister!"],
  ["Why did the banana go to the doctor?", "It wasn't peeling well."],
  ["How do you organize a space party?", "You planet."],
  ["What do you call a dinosaur that crashes his car?", "Tyrannosaurus wrecks!"],
  ["Why did the picture go to jail?", "It was framed!"],
  ["What do you get when you cross a snowman and a vampire?", "Frostbite!"],
  ["Why did the kid bring a ladder to school?", "Because it was high school!"],
  ["What did the grape do when it got stepped on?", "Nothing — it just let out a little wine!"],
];

/* --- Distract Me: sub-tool picker --- */
renderers.distract = () => {
  // Award the session point once per fresh entry from outside Distract Me.
  // Coming from any distract sub-tool keeps the flag (don't double-award).
  const fromOutside = !['distract','distractFacts','distractIdeas','distractJokes','distractBubbles','distractMath'].includes(navStack.length ? navStack[navStack.length-1].view : '');
  if(fromOutside) flow.distractAwarded = false;

  if(!flow.distractAwarded){
    state.points += 1;
    state.totalPoints += 1;
    flow.distractAwarded = true;
    save();
  }
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade">
    <span class="step-tag">DISTRACT ME 🎈</span>
    <div class="step-title">Take your mind off it</div>
    <div class="duo" style="margin:6px auto">${buddy('',104)}</div>
    <div class="card"><p>Pick something fun to do for a minute. Your feelings can wait while your brain gets a little break.</p></div>
    <button class="choice" onclick="go('distractFacts')"><span class="ce">💡</span>Random fun facts</button>
    <button class="choice" onclick="go('distractIdeas')"><span class="ce">🎲</span>Something to do right now</button>
    <button class="choice" onclick="go('distractJokes')"><span class="ce">😂</span>Tell me a joke</button>
    <button class="choice" onclick="go('distractBubbles')"><span class="ce">🫧</span>Pop bubbles</button>
    <button class="choice" onclick="go('distractMath')"><span class="ce">✖️</span>Math game</button>
    <button class="btn ghost" style="margin-top:12px" onclick="afterTool()">Done — back to coping</button>
  </div>`;
};

/* --- Facts sub-tool --- */
renderers.distractFacts = () => {
  if(typeof flow.factIdx !== 'number') flow.factIdx = Math.floor(Math.random()*DISTRACT_FACTS.length);
  const fact = DISTRACT_FACTS[flow.factIdx];
  screen.innerHTML=`${topbar('distract')}
  <div class="pad fade">
    <span class="step-tag">FUN FACT 💡</span>
    <div class="duo" style="margin:6px auto">${buddy('',96)}</div>
    <div class="card" style="background:#fff8e1">
      <p style="font-size:16px;color:var(--ink);line-height:1.5;font-weight:600">${escapeHtml(fact)}</p>
    </div>
    <button class="btn" onclick="distractNextFact()">Tell me another 💡</button>
    <button class="btn ghost" onclick="go('distract')">Try something else</button>
  </div>`;
};
function distractNextFact(){
  let next = Math.floor(Math.random()*DISTRACT_FACTS.length);
  if(next === flow.factIdx && DISTRACT_FACTS.length > 1){
    next = (next + 1) % DISTRACT_FACTS.length;
  }
  flow.factIdx = next;
  go('distractFacts');
}

/* --- Distraction ideas sub-tool --- */
renderers.distractIdeas = () => {
  if(typeof flow.ideaIdx !== 'number') flow.ideaIdx = Math.floor(Math.random()*DISTRACT_IDEAS.length);
  const idea = DISTRACT_IDEAS[flow.ideaIdx];
  screen.innerHTML=`${topbar('distract')}
  <div class="pad fade">
    <span class="step-tag">TRY THIS 🎲</span>
    <div class="duo" style="margin:6px auto">${buddy('',96)}</div>
    <div class="card" style="background:#eaf4ec">
      <p style="font-size:16px;color:var(--ink);line-height:1.5;font-weight:700">${escapeHtml(idea)}</p>
    </div>
    <div class="card tip"><p>Go ahead and try it! When you're done, come back.</p></div>
    <button class="btn" onclick="distractNextIdea()">Give me another idea 🎲</button>
    <button class="btn ghost" onclick="go('distract')">Try something else</button>
  </div>`;
};
function distractNextIdea(){
  let next = Math.floor(Math.random()*DISTRACT_IDEAS.length);
  if(next === flow.ideaIdx && DISTRACT_IDEAS.length > 1){
    next = (next + 1) % DISTRACT_IDEAS.length;
  }
  flow.ideaIdx = next;
  go('distractIdeas');
}

/* --- Jokes sub-tool: setup → tap → punchline → next --- */
renderers.distractJokes = () => {
  if(typeof flow.jokeIdx !== 'number') flow.jokeIdx = Math.floor(Math.random()*DISTRACT_JOKES.length);
  if(typeof flow.jokeReveal !== 'boolean') flow.jokeReveal = false;
  const [setup, punch] = DISTRACT_JOKES[flow.jokeIdx];
  screen.innerHTML=`${topbar('distract')}
  <div class="pad fade">
    <span class="step-tag">JOKE TIME 😂</span>
    <div class="duo" style="margin:6px auto">${buddy('',96)}</div>
    <div class="card" style="background:#f5edfb">
      <p style="font-size:16.5px;color:var(--ink);line-height:1.55;font-weight:700">${escapeHtml(setup)}</p>
      ${flow.jokeReveal ? `<p style="font-size:16px;color:var(--grape-deep);line-height:1.55;font-weight:800;margin-top:14px">${escapeHtml(punch)}</p>` : ''}
    </div>
    ${flow.jokeReveal
      ? `<button class="btn" onclick="distractNextJoke()">Another one 😂</button>`
      : `<button class="btn" onclick="distractRevealJoke()">Tell me the answer 🥁</button>`}
    <button class="btn ghost" onclick="go('distract')">Try something else</button>
  </div>`;
};
function distractRevealJoke(){
  flow.jokeReveal = true;
  go('distractJokes');
}
function distractNextJoke(){
  let next = Math.floor(Math.random()*DISTRACT_JOKES.length);
  if(next === flow.jokeIdx && DISTRACT_JOKES.length > 1){
    next = (next + 1) % DISTRACT_JOKES.length;
  }
  flow.jokeIdx = next;
  flow.jokeReveal = false;
  go('distractJokes');
}

/* --- Bubble popping sub-tool ---
   Floating bubbles drift up; tap to pop. Counter tracks total pops.
   No win condition, silent, no score pressure. */
renderers.distractBubbles = () => {
  if(typeof flow.popCount !== 'number') flow.popCount = 0;
  screen.innerHTML=`${topbar('distract')}
  <div class="pad fade">
    <span class="step-tag">BUBBLES 🫧</span>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
      <div style="font-weight:800;color:var(--orchid);font-size:14px">Popped: <span id="popCount">${flow.popCount}</span></div>
      <button class="btn ghost" style="width:auto;margin:0;padding:8px 14px" onclick="distractStopBubbles()">Done</button>
    </div>
    <div id="bubbleStage" style="position:relative;width:100%;height:480px;background:linear-gradient(180deg,#f5edfb 0%,#e8d6f4 100%);border-radius:18px;margin-top:10px;overflow:hidden;cursor:pointer;touch-action:manipulation"></div>
    <div class="card tip" style="margin-top:10px"><p>Tap the bubbles to pop them. As many as you want. 🫧</p></div>
  </div>`;
  startBubbleAnimation();
};

let bubbleIntervalSpawn = null;
let bubbleIntervalAnim = null;
let bubbleList = [];

function startBubbleAnimation(){
  stopBubbleAnimation();
  bubbleList = [];
  const stage = $('bubbleStage');
  if(!stage) return;

  // spawn a new bubble every ~700ms
  bubbleIntervalSpawn = setInterval(() => {
    spawnBubble();
  }, 700);
  // spawn 3 immediately so it feels alive on entry
  spawnBubble(); spawnBubble(); spawnBubble();

  // animation frame — using interval for simplicity (~33ms = ~30fps)
  bubbleIntervalAnim = setInterval(() => {
    animateBubbles();
  }, 33);
}

function spawnBubble(){
  const stage = $('bubbleStage');
  if(!stage) return;
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  if(!stageW || !stageH) return;
  const size = 36 + Math.floor(Math.random()*42);  // 36-78px
  const x = Math.floor(Math.random() * (stageW - size));
  const y = stageH + size;  // start just below the stage
  const speed = 0.6 + Math.random()*1.0;   // pixels per frame
  const wobble = 0.4 + Math.random()*0.6;  // horizontal sway
  const wobblePhase = Math.random()*Math.PI*2;

  const el = document.createElement('button');
  el.className = 'bubble-float';
  el.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${size}px;height:${size}px;border-radius:50%;border:none;padding:0;cursor:pointer;background:radial-gradient(circle at 30% 30%,rgba(255,255,255,0.85),rgba(173,138,219,0.55) 60%,rgba(125,82,178,0.4));box-shadow:inset -4px -6px 8px rgba(125,82,178,0.3),0 2px 8px rgba(125,82,178,0.25);touch-action:manipulation`;
  el.setAttribute('aria-label','bubble');
  el.onclick = (e) => { e.stopPropagation(); popBubble(el); };
  stage.appendChild(el);

  bubbleList.push({ el, x, y, size, speed, wobble, wobblePhase, baseX:x, t:0 });
}

function animateBubbles(){
  const stage = $('bubbleStage');
  if(!stage) return;
  const stageH = stage.clientHeight;
  bubbleList = bubbleList.filter(b => {
    b.t += 1;
    b.y -= b.speed;
    // horizontal sway
    const wob = Math.sin((b.t * 0.05) + b.wobblePhase) * (b.wobble * 12);
    b.x = b.baseX + wob;
    b.el.style.top = b.y + 'px';
    b.el.style.left = b.x + 'px';
    // remove bubbles that floated off the top
    if(b.y + b.size < 0){
      try { b.el.remove(); } catch(e){}
      return false;
    }
    return true;
  });
}

function popBubble(el){
  // pop animation
  el.style.transition = 'transform 0.18s ease-out, opacity 0.18s ease-out';
  el.style.transform = 'scale(1.7)';
  el.style.opacity = '0';
  el.onclick = null;
  setTimeout(() => { try{ el.remove(); } catch(e){} }, 200);
  // remove from list immediately
  bubbleList = bubbleList.filter(b => b.el !== el);
  flow.popCount = (flow.popCount||0) + 1;
  const counter = $('popCount');
  if(counter) counter.textContent = flow.popCount;
}

function stopBubbleAnimation(){
  if(bubbleIntervalSpawn){ clearInterval(bubbleIntervalSpawn); bubbleIntervalSpawn = null; }
  if(bubbleIntervalAnim){ clearInterval(bubbleIntervalAnim); bubbleIntervalAnim = null; }
  bubbleList = [];
}

function distractStopBubbles(){
  stopBubbleAnimation();
  go('distract');
}

/* --- Math game sub-tool: multiplication up to 12×12, type-in answer --- */
renderers.distractMath = () => {
  // Generate fresh problem if none set
  if(!flow.mathProb){
    const a = 1 + Math.floor(Math.random()*12);
    const b = 1 + Math.floor(Math.random()*12);
    flow.mathProb = { a, b, ans: a*b };
    flow.mathStatus = null;   // 'right', 'wrong', null
    flow.mathLastWrongAns = null;
    if(typeof flow.mathCount !== 'number') flow.mathCount = 0;
  }
  const { a, b } = flow.mathProb;
  const showRight = flow.mathStatus === 'right';
  const showWrong = flow.mathStatus === 'wrong';

  screen.innerHTML=`${topbar('distract')}
  <div class="pad fade">
    <span class="step-tag">MATH GAME ✖️</span>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px">
      <div style="font-weight:800;color:var(--orchid);font-size:14px">Problems done: ${flow.mathCount}</div>
      <button class="btn ghost" style="width:auto;margin:0;padding:8px 14px" onclick="distractMathDone()">Done</button>
    </div>
    <div class="card" style="text-align:center;margin-top:14px;background:#eaf4ec">
      <p style="font-size:32px;color:var(--ink);font-weight:800;font-family:'Baloo 2',cursive;margin:6px 0">${a} × ${b} = ?</p>
    </div>
    ${showRight ? `
      <div class="card" style="background:#d8f5e6;text-align:center">
        <p style="font-size:17px;font-weight:800;color:#1f9d77">Yes! ${a} × ${b} = ${a*b} 🎯</p>
      </div>
      <button class="btn" onclick="distractMathNext()">Next problem ›</button>
    ` : showWrong ? `
      <div class="card" style="background:#fff3d6;text-align:center">
        <p style="font-size:15px;font-weight:700;color:#8b6e1a">Close! ${a} × ${b} = <b>${a*b}</b>. Let's try another. 💜</p>
      </div>
      <button class="btn" onclick="distractMathNext()">Next problem ›</button>
    ` : `
      <input type="number" id="mathInput" inputmode="numeric" pattern="[0-9]*"
        placeholder="Type your answer"
        style="display:block;width:100%;margin-top:14px;padding:14px;font-size:22px;font-family:'Baloo 2',cursive;text-align:center;border:2px solid var(--lilac);border-radius:12px;color:var(--grape-deep);font-weight:800"
        onkeydown="if(event.key==='Enter'){ distractMathCheck(); }">
      <button class="btn" onclick="distractMathCheck()">Check my answer ✓</button>
    `}
    <button class="btn ghost" onclick="go('distract')">Try something else</button>
  </div>`;
  // auto-focus the input on render (only when prompting)
  if(!showRight && !showWrong){
    setTimeout(() => { const i = $('mathInput'); if(i) i.focus(); }, 50);
  }
};

function distractMathCheck(){
  const i = $('mathInput');
  if(!i) return;
  const v = parseInt(i.value, 10);
  if(isNaN(v)) return;  // ignore empty/garbage
  const correct = (v === flow.mathProb.ans);
  flow.mathStatus = correct ? 'right' : 'wrong';
  if(correct) flow.mathCount = (flow.mathCount||0) + 1;
  go('distractMath');
}
function distractMathNext(){
  flow.mathProb = null;
  flow.mathStatus = null;
  go('distractMath');
}
function distractMathDone(){
  flow.mathProb = null;
  flow.mathStatus = null;
  go('distract');
}

renderers.gratitude = () => {
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade">
    <span class="step-tag">SUNSHINE ☀️</span>
    <div class="step-title">A little warmth</div>
    <div class="duo" style="margin:6px auto">${buddy('',104)}</div>
    <div class="card"><p>Two things you can do here — pick whichever fits today.</p></div>
    <button class="door before" style="margin-top:8px" onclick="go('gratitudeWrite')">
      <div class="emoji">🌻</div>
      <div><div class="dt">Gratitude Practice</div><div class="ds">Notice a good thing from your day</div></div>
    </button>
    <button class="door after" style="margin-top:10px" onclick="go('faithMoment')">
      <div class="emoji">💛</div>
      <div><div class="dt">Remind me I am loved</div><div class="ds">A quiet moment</div></div>
    </button>
    ${(state.gratitudes && state.gratitudes.length) ? `
      <div class="door-q" style="margin-top:18px">Things you have noticed</div>
      ${state.gratitudes.slice(0,5).map(g => g.type==='faith'
        ? `<div class="card" style="background:#fff8e1;display:flex;gap:10px;align-items:center">
            <div style="font-size:22px">💛</div>
            <div style="flex:1;font-size:13px;color:var(--ink-soft);font-weight:700">${escapeHtml(new Date(g.ts).toLocaleDateString())} · Amen 💜</div>
          </div>`
        : `<div class="card" style="background:#fffaef">
            <div style="font-size:11px;color:var(--ink-soft);font-weight:800">${escapeHtml(new Date(g.ts).toLocaleDateString())}</div>
            <div style="font-size:14.5px;color:var(--ink);font-weight:600;margin-top:3px">🌻 ${escapeHtml(g.text)}</div>
          </div>`).join('')}` : ''}
  </div>`;
};

renderers.gratitudeWrite = () => {
  screen.innerHTML=`${topbar('gratitude')}
  <div class="pad fade">
    <span class="step-tag">GRATITUDE PRACTICE 🌻</span>
    <div class="step-title">Tell me about a good part of your day</div>
    <div class="duo" style="margin:4px auto">${buddy('',96)}</div>
    <div class="step-sub">Just one thing. Big or small — they all count. Type it, or tap a starter below to help.</div>
    <textarea id="gtext" placeholder="Type your good thing here..." style="min-height:110px;margin-top:8px"></textarea>
    <div class="step-sub" style="margin-top:14px">Need a starter? Tap one to begin:</div>
    <div class="chipwrap">
      ${GRATITUDE_CHIPS.map(c => `<button class="chip" onclick="gratitudeStarter(${JSON.stringify(c).replace(/"/g,'&quot;')})">
        <span>${escapeHtml(c)}</span></button>`).join('')}
    </div>
    <button class="btn" onclick="gratitudeSave()">Save my good thing 🌻</button>
    <button class="btn ghost" onclick="gratitudeEmpty()">I can't think of one today</button>
    <div class="skipnote">No pressure. Some days are easier than others — both are okay. 💜</div>
  </div>`;
};
function gratitudeStarter(text){
  const box=$('gtext'); if(!box) return;
  // prepend or set
  if(!box.value.trim()){ box.value = text + ' '; }
  else { box.value = box.value.trim() + '\n' + text + ' '; }
  box.focus();
  // place cursor at end
  box.selectionStart = box.selectionEnd = box.value.length;
}
function gratitudeSave(){
  const box=$('gtext'); const text = box ? box.value.trim() : '';
  if(!text){ gratitudeEmpty(); return; }
  if(!state.gratitudes) state.gratitudes = [];
  state.gratitudes.unshift({ ts: Date.now(), text, type:'gratitude' });
  // earn 1 point — modest, not a quiz reward
  state.points += 1;
  state.totalPoints += 1;
  save();
  // celebrate gently
  screen.innerHTML=`<div class="celebrate" id="celeb">
    <div style="font-size:30px">🌻 ✨ 🌻</div>
    <h2 style="color:var(--grape-deep)">Thank you for sharing.</h2>
    <div class="duo" style="margin:8px 0">${buddy('happy',104)}</div>
    <div class="big" style="font-size:16px;color:var(--ink)">"${escapeHtml(text)}"</div>
    <div class="big" style="margin-top:10px;font-size:14px">Noticing good things is its own kind of brave. 💜</div>
    <div class="pointpop">+1 ⭐</div>
    <button class="btn" style="max-width:260px" onclick="go('home')">Back home</button>
    <button class="btn ghost" style="max-width:260px" onclick="go('gratitude')">Back to Sunshine</button>
  </div>`;
  burst();
}
function gratitudeEmpty(){
  screen.innerHTML=`${topbar('gratitude')}
  <div class="pad fade" style="text-align:center">
    <span class="step-tag">THAT'S OKAY 💜</span>
    <div class="step-title" style="margin-top:14px">Some days are like that.</div>
    <div class="duo" style="margin:14px auto">${buddy('',110)}</div>
    <div class="card"><p style="font-size:15px">Just coming here was a good thing. You do not have to find one today.</p></div>
    <div class="card tip"><p>💛 If you want, you can tap "I need a reminder I'm loved" instead. No pressure either way.</p></div>
    <button class="btn" onclick="go('faithMoment')">A reminder I'm loved 💛</button>
    <button class="btn ghost" onclick="go('home')">Back home</button>
  </div>`;
}

renderers.faithMoment = () => {
  // pick a random message from the bank
  const idx = Math.floor(Math.random() * FAITH_MESSAGES.length);
  const m = FAITH_MESSAGES[idx];
  screen.innerHTML=`${topbar('gratitude')}
  <div class="pad fade" style="text-align:center">
    <span class="step-tag">A QUIET MOMENT 💛</span>
    <div class="duo" style="margin:16px auto 8px">${buddy('',120)}</div>
    <div class="card" style="background:#fff8e1;text-align:left">
      <p style="font-size:16px;color:var(--ink);font-weight:600;line-height:1.55">${escapeHtml(m.msg)}</p>
      <p style="font-size:13.5px;color:#8b6e3a;font-style:italic;font-weight:600;margin-top:12px;text-align:center">${escapeHtml(m.verse)}</p>
    </div>
    <button class="btn" onclick="faithAmen()">Amen 💜</button>
  </div>`;
};
function faithAmen(){
  if(!state.gratitudes) state.gratitudes = [];
  state.gratitudes.unshift({ ts: Date.now(), type:'faith' });
  state.points += 1;
  state.totalPoints += 1;
  save();
  screen.innerHTML=`<div class="celebrate" id="celeb">
    <div style="font-size:30px">💛 ✨ 💛</div>
    <h2 style="color:var(--grape-deep)">Amen.</h2>
    <div class="duo" style="margin:14px 0">${buddy('happy',110)}</div>
    <div class="big" style="font-size:15px">You are loved. Always. 💜</div>
    <div class="pointpop">+1 ⭐</div>
    <button class="btn" style="max-width:260px" onclick="go('home')">Back home</button>
    <button class="btn ghost" style="max-width:260px" onclick="go('gratitude')">Back to Sunshine</button>
  </div>`;
  burst();
}

renderers.closet = () => {
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade"><span class="step-tag">BUBBLE'S CLOSET 🎩</span>
    <div class="step-title">Dress up Bubble</div>
    <div class="step-sub">Buy an item, then tap it to put it on. Tap again to take it off!</div>
    <div class="shrinkbox" style="text-align:center">${buddy('',124)}</div>
    <div class="minirow" style="flex-wrap:wrap">
    ${ITEMS.map(it=>{
      const owned=!!state.owned[it.id], worn=state.wearing===it.id, can=state.points>=it.c;
      const status = worn ? 'Wearing 👕' : owned ? 'Tap to wear' : it.c+' ⭐';
      const col = worn ? 'var(--grape)' : owned ? 'var(--mint)' : can ? 'var(--tangerine)' : 'var(--ink-soft)';
      return `<button class="minicard ${worn?'wearing':''}" style="flex:0 0 30%" onclick="closetTap('${it.id}')">
        <div class="mi">${it.e}</div><div class="ml">${escapeHtml(it.n)}</div>
        <div style="font-size:11px;font-weight:800;margin-top:3px;color:${col}">${status}</div></button>`;
    }).join('')}
    </div>
    <div class="skipnote">Earn points by using the doors on the home screen.</div>
    <button class="btn" onclick="go('home')">Back home</button>
  </div>`;
};
function closetTap(id){
  const it=ITEMS.find(x=>x.id===id);
  if(state.owned[id]){
    // already owned -> toggle wearing it
    state.wearing = (state.wearing===id) ? null : id;
    save(); go('closet');
  } else if(state.points>=it.c){
    // buy it, and put it on right away
    state.points-=it.c;
    state.owned[id]=true;
    state.wearing=id;
    save(); go('closet');
  } else {
    const idx=ITEMS.findIndex(x=>x.id===id);
    const card=document.querySelectorAll('.minicard')[idx];
    if(card) card.animate([{transform:'translateX(0)'},{transform:'translateX(-6px)'},
      {transform:'translateX(6px)'},{transform:'translateX(0)'}],{duration:300});
  }
}

/* =============================================================
   SYSTEM 3: PIN-LOCKED PARENT ZONE
============================================================= */
renderers.parentGate = () => {
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade"><span class="step-tag">GROWN-UPS ONLY 🔒</span>
    <div class="step-title">Parent Zone</div>
    <div class="step-sub">Enter the 4-digit PIN.</div>
    <div class="card" style="text-align:center">
      <input id="pin" inputmode="numeric" maxlength="4" placeholder="••••"
        style="font-size:34px;text-align:center;letter-spacing:14px;border:3px solid var(--lilac);
        border-radius:14px;padding:10px;width:180px;font-family:'Baloo 2',cursive;color:var(--grape)">
    </div>
    <button class="btn" onclick="checkPin()">Unlock</button>
    <div id="pinmsg" class="skipnote"></div>
  </div>`;
};
function checkPin(){
  if($('pin').value===PIN_STORE.get()) go('parentHome');
  else $('pinmsg').textContent='That PIN is not right. (Default is 1234 until you change it.)';
}
renderers.parentHome = () => {
  const c=state.pointsConfig;
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade"><span class="step-tag">PARENT ZONE 🔒</span>
    <div class="step-title">Adelyn's week</div>
    <div class="card"><h3>Snapshot</h3>
      <p>${state.log.length} moment(s) logged · ${state.points} points to spend ·
      ${state.totalPoints} earned all-time · anger monster ${state.monsterShrink>=6?'calm & tiny':'shrinking'}</p></div>

    <div class="card"><h3>Therapist report</h3>
      <p>Pick a range — it opens a printable report (Save as PDF or Email).</p>
      <div class="chipwrap">
        <button class="chip" onclick="openReport('week')">This Week</button>
        <button class="chip" onclick="openReport('month')">This Month</button>
        <button class="chip" onclick="openReport('since')">Since Last Report</button>
        <button class="chip" onclick="openReport('all')">All Time</button>
      </div>
      <div style="margin-top:14px">
        <label style="font-weight:800;font-size:13px;color:var(--grape-deep)">Therapist's email (saved here)</label>
        <input type="email" id="therapistEmail" value="${escapeAttr(state.therapistEmail||'')}"
          placeholder="therapist@example.com"
          style="display:block;width:100%;margin-top:6px;padding:9px;border:2px solid var(--lilac);border-radius:10px;font-family:'Nunito',sans-serif;font-size:14px;font-weight:600;color:var(--ink)">
        <button class="btn ghost" style="margin-top:8px" onclick="saveTherapistEmail()">Save email</button>
        <p style="font-size:12px;color:var(--ink-soft);font-weight:600;margin-top:8px">
          Tip: when you tap "Email to therapist" in the report, it opens your email app pre-filled.
          Save the report as a PDF first, then attach it before sending.
        </p>
      </div>
    </div>

    <div class="card"><h3>📝 Review &amp; annotate her moments</h3>
      <p>Tap a moment to add your own observations or context. These notes are <b>hidden from Adelyn</b> and only appear in the therapist report.</p>
      <button class="btn" style="margin-top:8px" onclick="go('parentReview')">Open moment review ›</button>
    </div>

    ${(state.pendingClaims && state.pendingClaims.length) ? `
      <div class="card" style="background:#fff3d6">
        <h3>⏳ Pending reward claims (${state.pendingClaims.length})</h3>
        <p>Adelyn has asked for these. Approve = points spent &amp; she gets it. Decline = points go back to her.</p>
        ${state.pendingClaims.map(c=>`
          <div style="background:#fff;border-radius:14px;padding:12px;margin-top:8px;display:flex;gap:10px;align-items:center">
            <div style="flex:1">
              <div style="font-weight:800;font-size:15px">${escapeHtml(c.name)}</div>
              <div style="font-size:12px;color:var(--ink-soft);font-weight:700">${c.cost}⭐ · asked ${escapeHtml(new Date(c.ts).toLocaleString())}</div>
            </div>
            <button class="chip" style="background:#3fd6a8;color:#fff" onclick="approveClaim('${c.claimId}')">Approve ✓</button>
            <button class="chip" onclick="declineClaim('${c.claimId}')">Decline ✗</button>
          </div>`).join('')}
      </div>` : ''}

    <div class="card"><h3>🎁 Real-world rewards</h3>
      <p>Set up what Adelyn can earn. She sees these in her Rewards screen.</p>
      ${(state.rewards||[]).map(r=>`
        <div style="background:#f8f0fb;border-radius:12px;padding:10px;margin-top:8px;display:flex;gap:8px;align-items:center">
          <input type="text" id="rname_${r.id}" value="${escapeAttr(r.name)}"
            style="flex:1;border:2px solid var(--lilac);border-radius:8px;padding:7px;font-family:'Nunito',sans-serif;font-size:14px;font-weight:600;color:var(--ink)">
          <input type="number" id="rcost_${r.id}" value="${r.cost}" min="1"
            style="width:64px;border:2px solid var(--lilac);border-radius:8px;padding:7px;font-family:'Baloo 2',cursive;font-size:15px;color:var(--grape);text-align:center">
          <button class="chip" onclick="saveReward('${r.id}')">Save</button>
          <button class="chip" onclick="deleteReward('${r.id}')" style="background:#fde0e3;color:#d8334a">✕</button>
        </div>`).join('')}
      <button class="btn" style="margin-top:10px" onclick="addReward()">+ Add a reward</button>
    </div>

    <div class="card"><h3>Points — values &amp; live preview</h3>
      ${cfgRow('reflectPts','Reflection (after the fact)')}
      ${cfgRow('duringPts','Used app while angry')}
      ${cfgRow('warningPts','Caught a warning sign')}
      ${cfgRow('bravePts','Brave step')}
      ${cfgRow('reflectBonusPts','Thoughtful-reflection bonus')}
      ${cfgRow('reflectDailyCap','Daily cap on reflection points')}
      ${cfgRow('weeklyMultiplier','Weekly multiplier (raise as she grows)',true)}
      <div id="cfgPreview" style="margin-top:10px;font-weight:800;color:var(--orchid);font-size:13px"></div>
    </div>

    <div class="card"><h3>Send Adelyn a note</h3>
      <textarea id="noteBox" placeholder="A few encouraging words for her..."></textarea>
      <button class="btn" style="margin-top:8px" onclick="sendNote()">Send note 💌</button>
      ${state.parentNotes.length?`<div class="skipnote" style="text-align:left;margin-top:8px">Last note: "${escapeHtml(state.parentNotes[0].text)}"</div>`:''}
    </div>

    <div class="card"><h3>Anger monster name</h3>
      <input id="mname" class="name-input" value="${escapeAttr(state.monsterName)}" style="font-size:18px">
      <button class="btn ghost" style="margin-top:8px" onclick="renameMonster()">Save name</button>
    </div>

    <div class="card tip"><h3>Settings</h3>
      <button class="btn ghost" onclick="go('changePin')">Change PIN</button>
      <button class="btn ghost" onclick="confirmReset()" style="color:#d8334a">Erase all data</button>
    </div>
    <button class="btn" onclick="go('home')">Back to Adelyn's app</button>
  </div>`;
  updateCfgPreview();
};
function cfgRow(key,label,isFloat){
  const v=state.pointsConfig[key];
  return `<div style="display:flex;align-items:center;gap:10px;margin-top:8px">
    <div style="flex:1;font-weight:700;font-size:13.5px;color:var(--ink)">${escapeHtml(label)}</div>
    <input type="number" ${isFloat?'step="0.1"':'step="1"'} min="0" value="${v}"
      onchange="setCfg('${key}',this.value,${!!isFloat})"
      style="width:74px;border:2px solid var(--lilac);border-radius:10px;padding:7px;
      font-family:'Baloo 2',cursive;font-size:16px;color:var(--grape);text-align:center"></div>`;
}
function setCfg(key,val,isFloat){
  const n=isFloat?parseFloat(val):parseInt(val,10);
  if(!isNaN(n) && n>=0){ state.pointsConfig[key]=n; save(); updateCfgPreview(); }
}
function updateCfgPreview(){
  const el=$('cfgPreview'); if(!el) return;
  // live preview: what sample events would score now
  const sample=m=>{ const saved=JSON.stringify(state.reflectCountByDay);
    const p=calcPoints({mode:m,thoughtful:false});
    state.reflectCountByDay=JSON.parse(saved); return p; };
  el.textContent=`Preview — warning sign: ${sample('warning')}⭐ · `
    +`during anger: ${sample('during')}⭐ · `
    +`brave step: ${sample('brave')}⭐ · `
    +`reflection: ${sample('reflect')}⭐`;
}
function sendNote(){
  const b=$('noteBox'); if(!b||!b.value.trim()) return;
  state.parentNotes.unshift({ts:Date.now(),text:b.value.trim()});
  save(); go('parentHome');
}
function renameMonster(){
  const b=$('mname'); if(b&&b.value.trim()){ state.monsterName=b.value.trim(); save(); go('parentHome'); }
}
function saveTherapistEmail(){
  const b=$('therapistEmail');
  if(!b) return;
  const v = b.value.trim();
  state.therapistEmail = v;
  save();
  // Tiny feedback
  b.style.borderColor = '#3fd6a8';
  setTimeout(()=>{ b.style.borderColor = ''; }, 1200);
}

/* =============================================================
   PARENT MOMENT REVIEW — read her logs, add private notes
   Notes are saved on each log entry under `parentNotes: []`.
   Adelyn never sees them in her app.
============================================================= */
renderers.parentReview = () => {
  const log = state.log || [];
  const emojis={before:'🌤️',during:'🔥',after:'📖',brave:'🦁',people:'🧩'};
  screen.innerHTML=`${topbar('parentHome')}
  <div class="pad fade">
    <span class="step-tag">REVIEW MOMENTS 📝</span>
    <div class="step-title">Adelyn's moments</div>
    <div class="step-sub">Tap any moment to add private context. Notes are hidden from her.</div>
    ${log.length ? log.map((e,i)=>{
      const when = new Date(e.ts).toLocaleString();
      const noteCount = (e.parentNotes||[]).length;
      const ba = (e.rateBefore!=null&&e.rateAfter!=null) ? `${e.rateBefore}→${e.rateAfter}` : '';
      return `<button class="choice" onclick="go('parentNoteEdit',{idx:${i}})" style="display:flex;align-items:flex-start">
        <span class="ce">${emojis[e.door]||'⭐'}</span>
        <span style="flex:1">
          <div style="font-weight:800;font-size:14.5px">${escapeHtml(e.title||'Moment')}</div>
          <div style="font-size:12px;color:var(--ink-soft);font-weight:600;margin-top:2px">${escapeHtml(when)}${ba?' · '+ba:''}${e.tool?' · '+escapeHtml(e.tool):''}</div>
          ${noteCount?`<div style="font-size:11.5px;color:var(--orchid);font-weight:800;margin-top:3px">📝 ${noteCount} parent note${noteCount===1?'':'s'}</div>`:''}
        </span>
      </button>`;
    }).join('') : `<div class="card"><p>No moments logged yet.</p></div>`}
    <button class="btn" onclick="go('parentHome')">Back to parent zone</button>
  </div>`;
};
renderers.parentNoteEdit = (d) => {
  const idx = d.idx;
  const e = state.log[idx];
  if(!e){ go('parentReview'); return; }
  const emojis={before:'🌤️',during:'🔥',after:'📖',brave:'🦁',people:'🧩'};
  const ba = (e.rateBefore!=null&&e.rateAfter!=null) ? `Feeling ${e.rateBefore} → ${e.rateAfter}` : '';
  const chipFrom = a => (a && a.chips ? a.chips.join(', ') : '');
  const where = chipFrom(e.answers && e.answers[0]);   // legacy: not always present
  const who   = chipFrom(e.answers && e.answers[1]);
  const did   = chipFrom(e.answers && e.answers[2]);
  // ^ these only populate if a future enhancement keeps answers in the log;
  // for now we show what fields the entry has.
  screen.innerHTML=`${topbar('parentReview')}
  <div class="pad fade">
    <span class="step-tag">MOMENT DETAILS</span>
    <div class="step-title">${emojis[e.door]||'⭐'} ${escapeHtml(e.title||'Moment')}</div>
    <div class="step-sub">${escapeHtml(new Date(e.ts).toLocaleString())}</div>

    <div class="card"><h3>What she logged</h3>
      ${e.setoff?`<p><b>Trigger:</b> ${escapeHtml(e.setoff)}</p>`:''}
      ${e.thought?`<p><b>What ${escapeHtml(state.monsterName||'Grumble')} said:</b> "${escapeHtml(e.thought)}"</p>`:''}
      ${e.tool?`<p><b>Tool(s) used:</b> ${escapeHtml(e.tool)}</p>`:''}
      ${e.nextTimeTool?`<p><b>Next-time plan:</b> ${escapeHtml(e.nextTimeTool)}</p>`:''}
      ${e.doover?`<p><b>Thoughtful do-over she imagined:</b> ${escapeHtml(e.doover)}</p>`:''}
      ${ba?`<p><b>${ba}</b></p>`:''}
      ${e.notes?`<p style="margin-top:8px;padding:8px 12px;background:#fff3d6;border-radius:10px"><b>Adelyn wrote:</b><br>${escapeHtml(e.notes)}</p>`:''}
    </div>

    ${(e.parentNotes&&e.parentNotes.length)?`
      <div class="card"><h3>Your previous notes</h3>
        ${e.parentNotes.map((n,ni)=>`
          <div style="padding:10px;background:#eef3ff;border-radius:10px;margin-top:6px;display:flex;gap:8px;align-items:flex-start">
            <div style="flex:1"><div style="font-size:11px;color:var(--ink-soft);font-weight:800">${escapeHtml(new Date(n.ts).toLocaleString())}</div>
            <div style="font-size:14px;font-weight:600;margin-top:3px">${escapeHtml(n.text)}</div></div>
            <button onclick="deleteParentNote(${idx},${ni})" style="background:none;border:none;color:var(--ink-soft);font-weight:800;cursor:pointer">✕</button>
          </div>`).join('')}
      </div>`:''}

    <div class="card"><h3>Add a parent note</h3>
      <p style="font-size:13px;color:var(--ink-soft);font-weight:600">Hidden from Adelyn. Visible to you and in the therapist report.</p>
      <textarea id="pnote" placeholder="What you observed, context she might not have included, what helped or hurt..." style="margin-top:8px"></textarea>
      <button class="btn" style="margin-top:8px" onclick="addParentNote(${idx})">Save note 📝</button>
    </div>
    <button class="btn ghost" onclick="go('parentReview')">Back to moment list</button>
  </div>`;
};
function addParentNote(idx){
  const b=$('pnote'); if(!b || !b.value.trim()) return;
  const e = state.log[idx]; if(!e) return;
  if(!e.parentNotes) e.parentNotes = [];
  e.parentNotes.unshift({ ts: Date.now(), text: b.value.trim() });
  save();
  go('parentNoteEdit',{idx});
}
function deleteParentNote(idx, noteIdx){
  if(!confirm('Delete this note?')) return;
  const e = state.log[idx]; if(!e || !e.parentNotes) return;
  e.parentNotes.splice(noteIdx,1);
  save();
  go('parentNoteEdit',{idx});
}

/* ---------- REWARDS — parent management & claim approval ---------- */
function approveClaim(claimId){
  if(!state.pendingClaims) return;
  const idx = state.pendingClaims.findIndex(c=>c.claimId===claimId);
  if(idx<0) return;
  const c = state.pendingClaims[idx];
  if(state.points < c.cost){
    alert('Adelyn no longer has enough points for this reward. Decline it instead.');
    return;
  }
  // Deduct points and mark earned. Lifetime totalPoints stays untouched (Lesson 1).
  state.points -= c.cost;
  if(!state.earnedRewards) state.earnedRewards = [];
  state.earnedRewards.unshift({ rewardId: c.rewardId, name: c.name, cost: c.cost, ts: Date.now() });
  state.pendingClaims.splice(idx,1);
  save();
  go('parentHome');
}
function declineClaim(claimId){
  if(!state.pendingClaims) return;
  const idx = state.pendingClaims.findIndex(c=>c.claimId===claimId);
  if(idx<0) return;
  if(!confirm('Decline this reward? Her points will go back to her.')) return;
  state.pendingClaims.splice(idx,1);
  save();
  go('parentHome');
}
function addReward(){
  if(!state.rewards) state.rewards = [];
  state.rewards.push({
    id: 'r'+Date.now()+'_'+Math.floor(Math.random()*1000),
    name: 'New reward',
    cost: 20,
  });
  save();
  go('parentHome');
}
function saveReward(id){
  const r = (state.rewards||[]).find(x=>x.id===id); if(!r) return;
  const nb = $('rname_'+id), cb = $('rcost_'+id);
  if(nb && nb.value.trim()) r.name = nb.value.trim();
  if(cb){
    const n = parseInt(cb.value,10);
    if(!isNaN(n) && n>0) r.cost = n;
  }
  save();
  go('parentHome');
}
function deleteReward(id){
  if(!confirm('Delete this reward? Any pending claim for it will also be removed.')) return;
  state.rewards = (state.rewards||[]).filter(x=>x.id!==id);
  state.pendingClaims = (state.pendingClaims||[]).filter(c=>c.rewardId!==id);
  save();
  go('parentHome');
}
renderers.changePin = () => {
  screen.innerHTML=`${topbar('parentHome')}
  <div class="pad fade"><span class="step-tag">CHANGE PIN 🔑</span>
    <div class="step-title">Set a new 4-digit PIN</div>
    <div class="card" style="text-align:center">
      <input id="newpin" inputmode="numeric" maxlength="4" placeholder="••••"
        style="font-size:30px;text-align:center;letter-spacing:12px;border:3px solid var(--lilac);
        border-radius:14px;padding:10px;width:170px;font-family:'Baloo 2',cursive;color:var(--grape)">
    </div>
    <button class="btn" onclick="savePin()">Save PIN</button>
    <div id="pinset" class="skipnote"></div>
    <div class="skipnote">The PIN is stored only on this device and survives data resets.</div>
  </div>`;
};
function savePin(){
  const v=$('newpin').value;
  if(/^\d{4}$/.test(v)){ PIN_STORE.set(v); go('parentHome'); }   // Lesson 10: own key
  else $('pinset').textContent='PIN must be exactly 4 digits.';
}
/* Lesson 11: reset preserves the PIN */
function confirmReset(){
  if(!confirm('Erase all of Adelyn\u2019s data? This cannot be undone.')) return;
  const pin=PIN_STORE.get();
  localStorage.removeItem(DATA_KEY);
  if(pin) PIN_STORE.set(pin);          // restore
  location.reload();
}

/* ---------- start the app ---------- */
boot();
