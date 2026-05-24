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
    customMantras: [],
    customVerses: [],
    parentNotes: [],
    lastReportDate: 0,
    reflectCountByDay: {},    // 'YYYY-MM-DD' -> points earned via reflection that day
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
  const byDoor = {}, byBucket = {}, byTool = {}, bySetoff = {};
  let drops = 0, dropTotal = 0;
  for(const e of events){
    byDoor[e.door] = (byDoor[e.door]||0)+1;
    byBucket[timeBucket(e.ts)] = (byBucket[timeBucket(e.ts)]||0)+1;
    if(e.tool) byTool[e.tool] = (byTool[e.tool]||0)+1;
    if(e.setoff) bySetoff[e.setoff] = (bySetoff[e.setoff]||0)+1;
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
      <td>${escapeHtml(e.tool||'—')}</td><td>${ba}</td></tr>`;
  }).join('');

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

    <h2>Time of day</h2>
    <p>${kv(byBucket)}</p>

    <h2>Full moment log — with trigger thoughts in context</h2>
    <table><tr><th>When</th><th>What she did</th><th>Trigger</th>
      <th>Thought</th><th>Tool</th><th>Feeling 0–10</th></tr>${rows||'<tr><td colspan="6">No moments in this period.</td></tr>'}</table>

    <p class="muted" style="margin-top:20px">This is home-tracked data entered by a child and parent.
       It is meant to support — not replace — clinical assessment. All values are self-reported
       in the moment unless noted as estimated.</p>
    <button onclick="window.print()">Print / Save as PDF</button>
  </body></html>`;
}
function openReport(kind){
  const html = buildReport(kind);
  state.lastReportDate = Date.now();     // System 4: "since last report" tracking
  save();
  const w = window.open('', '_blank');
  if(w){ w.document.write(html); w.document.close(); }
  else { alert('Please allow pop-ups to view the report.'); }
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
  Sync.saveLocal(state);

  // live updates from other devices
  if(Sync.configured()){
    Sync.startPolling(cloud => {
      state = migrate(Sync.merge(state, cloud));
      Sync.saveLocal(state);
      if(currentView === 'home' || currentView === 'progress') go(currentView);
      updateSyncDot();
    });
  }
  updateSyncDot();
  go('home');
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

function go(view, data){
  currentView = view;
  renderers[view](data||{});
  screen.scrollTop = 0;
}
function topbar(backTo){
  return `<div style="display:flex;align-items:center;gap:10px;padding:14px 18px 6px">
    ${backTo?`<button class="back" onclick="go('${backTo}')">‹</button>`
            :'<div style="width:42px"></div>'}
    <div class="pointchip">⭐ ${state.points}</div></div>`;
}

/* ---------- characters (Bubble buddy + anger monster) ---------- */
function buddySVG(s){ s=s||140; return `<svg width="${s}" height="${s}" viewBox="0 0 200 200">
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
  {id:'mantra',e:'💜',name:'Say my mantra',kind:'mantra',desc:'Tell myself something strong.'},
  {id:'faith',e:'🙏',name:'Prayer or verse',kind:'faith',desc:'A calm prayer or a verse I love.'},
  {id:'detective',e:'🔍',name:'Be a thought detective',kind:'detective',desc:'Check if a worried thought is really true.'},
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
   chips:['Home 🏠','School 🏫','In the car 🚗',"A friend's house 🏡",'Outside 🌳','At an activity ⚽','Somewhere else ✨']},
  {tag:'WHO WAS THERE?',q:'Who was with you?',type:'chips',
   chips:['Mom 💗','Dad 💙','Emily 🧒','A neighborhood friend 🏘️','A school friend 🎒','A family member 👪','A teacher 🍎','Just me 🙂']},
  {tag:'WHAT DID YOU DO?',q:'What did you do?',type:'chips',sub:'Just honest — no judging. Tap all that happened.',
   chips:['Yelled 😣','Clenched my fists ✊','Made a mean face 😠','Stomped off 👣','Cried 😢',
     'Said something mean 💢','Slammed a door 🚪','Threw something 🧸','Went quiet 🤐','Walked away 🚶']},
  {tag:'THOUGHTFUL OR IMPULSIVE?',q:'Was that thoughtful or impulsive?',type:'single',
   sub:'Did you stop and think, or did it happen fast?',chips:['Thoughtful 🧠','A bit of both 🤔','Impulsive ⚡']},
  {tag:'WHAT SET IT OFF?',q:'What made you angry?',type:'chips',sub:'Tap what started it.',
   chips:['Someone said no 🚫','Felt left out 😕','Felt picked on 😠','Something felt unfair ⚖️',
     "Didn't get my way 😤",'Someone took something 🤲','Plans changed 🔄','Too much going on 🌪️']},
  {tag:'WHAT HAPPENED NEXT?',q:'What happened because of that?',type:'chips',sub:'How did it turn out? Tap all that fit.',
   chips:['Got in trouble ⚠️','Someone got upset 😟','We stopped playing 🛑','I felt bad after 💔',
     'We worked it out 🤝','I calmed down 😮‍💨','Nothing really changed 😐']},
  {tag:'DID YOU FEEL IT COMING?',q:'Did you feel it coming?',type:'single',
   sub:'Did you notice warning signs before it got big?',chips:['Yes, I felt it 👀','A little 🤏','No, it surprised me 💥']},
  {tag:'NEXT TIME',q:'What could you try next time?',type:'chips',sub:'Not to feel bad — just a plan. Tap any ideas.',
   chips:['Take a breath 🐉','Walk away to cool off 🚶','Ask for help 🙋','Use a calm-down tool 🧰','Tell a grown-up 🗣️','Catch it earlier 🌤️']},
];
function feelWord(v){
  if(v<=1)return['Calm','#3fd6a8']; if(v<=3)return['A little bugged','#7fce6a'];
  if(v<=5)return['Frustrated','#ffc23f']; if(v<=7)return['Pretty mad','#ff8a3f'];
  if(v<=9)return['Really angry','#ff5b6e']; return['Exploding','#e23a5e'];
}

const renderers = {};

/* ---------- HOME ---------- */
renderers.home = () => {
  screen.innerHTML = `${topbar(null)}
  <div class="pad fade">
    <div style="text-align:center"><div class="hero-name">Adelyn's App</div>
    <div class="hello">Hi, Adelyn! 👋</div></div>
    <div class="duo" style="margin:4px auto 0">${buddy('',128)}</div>
    <div class="speech">Hi! I'm <b>Bubble</b>, your buddy. I help you with big feelings — you're never alone with them. What's going on?</div>
    <div class="door-q">Pick a door 🚪</div>
    <button class="door before" onclick="go('beforePick')"><div class="emoji">🌤️</div>
      <div><div class="dt">I feel it coming</div><div class="ds">I notice a warning sign</div></div></button>
    <button class="door during" onclick="go('duringStart')"><div class="emoji">🔥</div>
      <div><div class="dt">I need help NOW</div><div class="ds">I'm angry or frustrated</div></div></button>
    <button class="door after" onclick="go('afterStart')"><div class="emoji">📖</div>
      <div><div class="dt">Something happened</div><div class="ds">Look back at an angry moment</div></div></button>
    <button class="door brave" onclick="go('bravePick')"><div class="emoji">🦁</div>
      <div><div class="dt">Be brave</div><div class="ds">Something feels scary</div></div></button>
    <div class="minirow">
      <button class="minicard" onclick="go('progress')"><div class="mi">🏆</div><div class="ml">My Wins</div></button>
      <button class="minicard" onclick="go('closet')"><div class="mi">🎩</div><div class="ml">Closet</div></button>
      <button class="minicard" onclick="go('parentGate')"><div class="mi">🔒</div><div class="ml">Grown-Ups</div></button>
    </div>
  </div>`;
};

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
  } else { flow.rateAfter=v; finishFlow(); }
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
renderers.duringStart=()=>{ flow={door:'during'}; go('rate',{when:'now'}); };
renderers.afterStart =()=>{ flow={door:'after'};  go('rate',{when:'then'}); };

/* ---------- THOUGHT ---------- */
renderers.thought = () => {
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">NAME THE THOUGHT</span>
    <div class="step-title">What is your brain telling you?</div>
    <div class="step-sub">Naming the thought helps us look at it. Tap the closest one.</div>
    ${THOUGHTS.map((t,i)=>`<button class="choice" onclick="pickThought(this,${i})">
      <span class="ce">💭</span>${escapeHtml(t)}</button>`).join('')}
    <button class="moretoggle" onclick="showThoughtBox()" id="moreBtn">+ say it in my own words</button>
    <div id="morebox" style="display:none">
      <textarea id="ownthought" placeholder="Type the thought in your own words..."></textarea></div>
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
  go('toolPick');
}

/* ---------- TOOL PICK ---------- */
renderers.toolPick = () => {
  const th=(flow.thought||'').toLowerCase();
  const targeted=/me|purpose|fair|want me|my way/.test(th);
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">PICK A TOOL</span>
    <div class="step-title">What will help right now?</div>
    <div class="step-sub">${targeted?'That thought sounds like a worry — "thought detective" could really help. Movement is great too!':'These all work. Moving your body is a great one for you!'}</div>
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
function afterTool(){ Timer.stop(); go('rate',{when:'after'}); }

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
renderers.detective = () => {
  const th=flow.thought||'that thought';
  screen.innerHTML=`${topbar(null)}
  <div class="pad fade"><span class="step-tag">THOUGHT DETECTIVE 🔍</span>
    <div class="step-title">Let's check that thought</div>
    <div class="card"><h3>Your thought:</h3><p>"${escapeHtml(th)}"</p></div>
    <div class="card tip"><p>🕵️ <b>Do you KNOW that for sure?</b><br>Our brain sometimes guesses the worst. A detective looks for more clues.</p></div>
    <div class="step-sub" style="margin-top:14px">Find a clue — could one of these also be true?</div>
    ${DETECTIVE.map(t=>`<button class="choice" onclick="pickOne(this)">
      <span class="ce">💡</span>${escapeHtml(t)}</button>`).join('')}
    <button class="btn go" onclick="afterTool()">I found another idea ✅</button>
  </div>`;
};
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
    go('rate',{when:'after'}); return;
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
  showAfterQ(i+1);
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

/* ---------- FINISH FLOW — uses calcPoints/awardPoints ---------- */
function finishFlow(){
  const mode = flow.door==='before'?'warning'
             : flow.door==='during'?'during'
             : flow.door==='brave'?'brave':'reflect';
  const session = { mode, thoughtful: !!flow.reflectDone };
  const pts = awardPoints(session);
  if(state.monsterShrink<6) state.monsterShrink++;

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
    tool: flow.tool ? flow.tool.name : '',
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
  const labels={before:'You caught a warning sign early!',during:'You used the app while angry!',
    after: d.entry.result&&/thought/i.test(d.entry.result)?'Thoughtful reflection! 🌟':'You looked back and reflected!',
    brave:'You took a brave step!'};
  const emojis={before:'🌤️',during:'🔥',after:'📖',brave:'🦁'};
  screen.innerHTML=`<div class="celebrate" id="celeb">
    <div style="font-size:26px">${emojis[e.door]} 🎉 ${emojis[e.door]}</div>
    <h2>Way to go!</h2><div class="big">${escapeHtml(labels[e.door]||'Great job!')}</div>
    <div class="duo" style="margin:6px 0">${buddy('happy',92)}${monster('',monsterSize()-16,monsterMad())}</div>
    ${hasPair?`<div class="ratepair">
      <div class="ratebubble" style="background:${feelWord(e.rateBefore)[1]}">${e.rateBefore}</div>
      <span class="arrow">➜</span>
      <div class="ratebubble" style="background:${feelWord(e.rateAfter)[1]}">${e.rateAfter}</div></div>
      <div class="big" style="${dropped?'color:var(--mint)':''}">
        ${dropped?'Your feeling got smaller! 📉':'You showed up and did the work. That is the win. 💜'}</div>`:''}
    <div class="pointpop">+${d.pts} ⭐</div>
    <div class="big" style="margin-top:10px;font-size:13px">${escapeHtml(state.monsterName)} the anger monster got smaller — you and Bubble are helping it calm down!</div>
    <button class="btn" style="max-width:260px" onclick="go('home')">Back home</button>
    <button class="btn ghost" style="max-width:260px" onclick="go('progress')">See my wins 🏆</button>
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
      const emoji={before:'🌤️',during:'🔥',after:'📖',brave:'🦁'}[l.door]||'⭐';
      return `<div class="logitem"><span class="lemoji">${emoji}</span>
        <div style="flex:1"><div class="lt">${escapeHtml(l.title)}</div><div class="ls">${sub}</div></div>
        <span class="badge">+${l.pts}⭐</span></div>`;
    }).join('')
      :`<div class="card"><p>No moments yet. Try a door on the home screen — every try is a win! 💜</p></div>`}
    <button class="btn" onclick="go('home')">Back home</button>
  </div>`;
};

/* ---------- CLOSET ---------- */
const ITEMS=[{e:'🎩',n:'Top Hat',c:5},{e:'👑',n:'Crown',c:10},{e:'🎀',n:'Big Bow',c:8},
  {e:'🕶️',n:'Cool Shades',c:6},{e:'⭐',n:'Star Pal',c:7},{e:'🌈',n:'Rainbow Trail',c:12}];
renderers.closet = () => {
  screen.innerHTML=`${topbar('home')}
  <div class="pad fade"><span class="step-tag">BUBBLE'S CLOSET 🎩</span>
    <div class="step-title">Dress up Bubble</div>
    <div class="step-sub">Spend your points on fun stuff for your buddy!</div>
    <div class="shrinkbox" style="text-align:center">${buddy('',120)}</div>
    <div class="minirow" style="flex-wrap:wrap">
    ${ITEMS.map((it,i)=>{const owned=state.owned[i],can=state.points>=it.c;
      return `<button class="minicard" style="flex:0 0 30%" onclick="buyItem(${i})">
        <div class="mi">${it.e}</div><div class="ml">${escapeHtml(it.n)}</div>
        <div style="font-size:11px;font-weight:800;margin-top:3px;color:${owned?'var(--mint)':can?'var(--tangerine)':'var(--ink-soft)'}">
          ${owned?'Got it ✓':it.c+' ⭐'}</div></button>`;}).join('')}
    </div>
    <div class="skipnote">Earn points by using the doors on the home screen.</div>
    <button class="btn" onclick="go('home')">Back home</button>
  </div>`;
};
function buyItem(i){
  if(state.owned[i]) return;
  const it=ITEMS[i];
  if(state.points>=it.c){
    state.points-=it.c; state.owned[i]=true; save(); go('closet');  // totalPoints untouched
  } else {
    const card=document.querySelectorAll('.minicard')[i];
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
      <p>Pick a range — it opens a printable report (Save as PDF).</p>
      <div class="chipwrap">
        <button class="chip" onclick="openReport('week')">This Week</button>
        <button class="chip" onclick="openReport('month')">This Month</button>
        <button class="chip" onclick="openReport('since')">Since Last Report</button>
        <button class="chip" onclick="openReport('all')">All Time</button>
      </div></div>

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
