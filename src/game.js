(function(){
'use strict';
/* ================= constants ================= */
const W = 800, H = 620;                 // board
const CW = 960, CH = 680;               // full canvas (logical)
const BX = 80, BY = 52;                 // board offset in canvas
const LX = 400, LY = 36;                // launcher pivot
const BALL_R = 8, PEG_R = 9, BRICK_HALF = 9, BRICK_R = 5;
const DT = 1/240;
const LAUNCH_SPEED = 560;
const REST = 0.74;
const MAXV = 1100;
const BOAT_Y = 598;
const A_MIN = 0.06, A_MAX = Math.PI - 0.06;

const AUD = () => window.LanternAudio || null;
function sfx(name, ...a){ try{ const A = AUD(); if(A && typeof A[name]==='function') A[name](...a); }catch(e){} }
function music(name, ...a){ try{ const A = AUD(); if(A && A.music && typeof A.music[name]==='function') A.music[name](...a); }catch(e){} }

/* ================= powers ================= */
const POWERS = [
  {id:'destiny',  name:'Destiny Shot', kind:'charge', base:1, desc:'Your next shot nudges itself to the angle that lights the most lanterns.'},
  {id:'foresight',name:'Long Sight',  kind:'charge', base:3, desc:'Shows the full bouncing path for the next three shots.'},
  {id:'multiball',name:'Twin Moons',  kind:'now',    base:1, desc:'Splits off a second moonstone on the spot.'},
  {id:'blast',    name:'Firework',    kind:'now',    base:1, desc:'Bursts open, lighting every lantern nearby.'},
  {id:'spark',    name:'Chain Spark', kind:'now',    base:1, desc:'Arcs to the five closest unlit lanterns, amber first.'},
  {id:'flame',    name:'Ember Stone', kind:'charge', base:1, desc:'Next shot burns straight through lanterns without bouncing.'},
  {id:'magnet',   name:'Moth Light',  kind:'charge', base:2, desc:'Next two shots curve toward the closest amber lantern.'},
  {id:'float',    name:'Feather Fall',kind:'charge', base:2, desc:'Next two shots fall slowly and bounce for longer.'},
  {id:'wide',     name:'Wide Boat',   kind:'charge', base:3, desc:'The catching boat is twice as wide for three turns.'},
  {id:'bridge',   name:'Moon Bridge', kind:'now',    base:1, desc:'The river bounces this shot back up once instead of swallowing it.'},
  {id:'secondwind',name:'Second Wind',kind:'now',    base:1, desc:'If this shot falls out, it drops back in from the top once.'},
];
const PMAP = Object.fromEntries(POWERS.map(p=>[p.id,p]));

/* ================= settings ================= */
const CLASSIC = {
  balls:10, infinite:false, targets:25, greens:2, purple:true,
  pool:['destiny','foresight','multiball','blast','spark','flame','magnet','float','wide','bridge','secondwind'],
  strength:1, startPower:'none',
  guide:'short', boatSpeed:'normal', boatSize:'normal', gravity:'normal', scoreBalls:true,
  cheatDestiny:false, cheatFlame:false, cheatBridge:false,
  music:0.6, sfx:0.8, speed:1
};
let S = load('ld.settings', CLASSIC);
S = Object.assign({}, CLASSIC, S);
if(!Array.isArray(S.pool)) S.pool = CLASSIC.pool.slice();
let progress = load('ld.progress', {best:{}, cleared:{}, last:0});
function load(k, def){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : JSON.parse(JSON.stringify(def)); }catch(e){ return JSON.parse(JSON.stringify(def)); } }
function save(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }

const GRAV = {feather:250, normal:420, heavy:600};
const BOAT_SPD = {still:0, slow:0.35, normal:0.6, fast:1.0};
const BOAT_SZ = {normal:52, wide:80, huge:120};

/* ================= canvas ================= */
const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
let scale = 1, dpr = 1, cssW = CW, cssH = CH;
function resize(){
  const st = document.getElementById('stage').getBoundingClientRect();
  const s = Math.min(st.width / CW, st.height / CH);
  scale = s; cssW = Math.floor(CW*s); cssH = Math.floor(CH*s);
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.style.width = cssW+'px'; cv.style.height = cssH+'px';
  cv.width = Math.floor(cssW*dpr); cv.height = Math.floor(cssH*dpr);
  const rot = document.getElementById('rotate');
  rot.classList.toggle('show', st.width < st.height && st.width < 600);
}
window.addEventListener('resize', resize);

/* ================= sprites ================= */
const PAL = {
  blue:  {body:'#2f6fcf', edge:'#173a7a', lit:'#bfe6ff', glow:'rgba(120,200,255,'},
  orange:{body:'#e0701f', edge:'#7a330c', lit:'#ffe3a0', glow:'rgba(255,170,60,'},
  green: {body:'#25a865', edge:'#0f5532', lit:'#c8ffe0', glow:'rgba(90,255,160,'},
  purple:{body:'#8d4fd6', edge:'#45216e', lit:'#efd8ff', glow:'rgba(200,140,255,'},
};
const SPR = {};
function mkCanvas(w,h){ const c = document.createElement('canvas'); c.width=w; c.height=h; return c; }
function buildSprites(){
  const K = 3; // supersample
  for(const type of Object.keys(PAL)){
    for(const lit of [0,1]){
      // round lantern
      { const sz = 40*K, c = mkCanvas(sz,sz), g = c.getContext('2d'); const P = PAL[type];
        g.translate(sz/2, sz/2); g.scale(K,K);
        if(lit){ const gl = g.createRadialGradient(0,0,4,0,0,19); gl.addColorStop(0,P.glow+'.75)'); gl.addColorStop(1,P.glow+'0)'); g.fillStyle=gl; g.beginPath(); g.arc(0,0,19,0,7); g.fill(); }
        else { const gl = g.createRadialGradient(0,0,6,0,0,15); gl.addColorStop(0,P.glow+'.25)'); gl.addColorStop(1,P.glow+'0)'); g.fillStyle=gl; g.beginPath(); g.arc(0,0,15,0,7); g.fill(); }
        // body: slightly squashed sphere
        g.save(); g.scale(1, 0.92);
        const bg = g.createRadialGradient(-2.5,-3,1, 0,0,9.5);
        if(lit){ bg.addColorStop(0,'#fffef6'); bg.addColorStop(.45,P.lit); bg.addColorStop(1,P.body); }
        else { bg.addColorStop(0,lighten(P.body,.35)); bg.addColorStop(.6,P.body); bg.addColorStop(1,P.edge); }
        g.fillStyle = bg; g.beginPath(); g.arc(0,0,PEG_R,0,7); g.fill();
        // ribs
        g.strokeStyle = lit ? 'rgba(120,60,10,.25)' : 'rgba(0,0,0,.28)'; g.lineWidth = .7;
        for(const k of [-5.5,-2,2,5.5]){ g.beginPath(); const hw = Math.sqrt(Math.max(0,PEG_R*PEG_R-k*k)); g.moveTo(-hw,k); g.quadraticCurveTo(0,k+ (k<0?-1.5:1.5), hw,k); g.stroke(); }
        g.restore();
        // caps
        g.fillStyle = lit ? '#5a3a14' : '#22180e';
        g.fillRect(-3.5,-9.6,7,2.2); g.fillRect(-3.5,7.4,7,2.2);
        if(lit){ g.fillStyle='rgba(255,255,240,.9)'; g.beginPath(); g.ellipse(-2.6,-3.2,1.8,1.2,-.5,0,7); g.fill(); }
        SPR[type+'_r_'+lit] = c;
      }
      // brick lantern panel
      { const w = 50*K, h = 30*K, c = mkCanvas(w,h), g = c.getContext('2d'); const P = PAL[type];
        g.translate(w/2,h/2); g.scale(K,K);
        const L = BRICK_HALF + BRICK_R, T = BRICK_R;
        if(lit){ g.shadowColor = P.glow+'.9)'; g.shadowBlur = 10; }
        const bg = g.createLinearGradient(0,-T,0,T);
        if(lit){ bg.addColorStop(0,'#fffef0'); bg.addColorStop(.5,P.lit); bg.addColorStop(1,P.body); }
        else { bg.addColorStop(0,lighten(P.body,.3)); bg.addColorStop(.55,P.body); bg.addColorStop(1,P.edge); }
        g.fillStyle = bg; roundRect(g,-L,-T,L*2,T*2,T); g.fill(); g.shadowBlur=0;
        g.strokeStyle = lit ? 'rgba(120,60,10,.3)' : 'rgba(0,0,0,.3)'; g.lineWidth=.7;
        for(let x=-L+5; x<L-2; x+=4.6){ g.beginPath(); g.moveTo(x,-T+1); g.lineTo(x,T-1); g.stroke(); }
        g.fillStyle = lit ? '#5a3a14' : '#22180e';
        g.fillRect(-L-.6,-T+1.5,2.2,T*2-3); g.fillRect(L-1.6,-T+1.5,2.2,T*2-3);
        SPR[type+'_b_'+lit] = c;
      }
    }
  }
  // moonstone ball
  { const sz = 30*K, c = mkCanvas(sz,sz), g = c.getContext('2d');
    g.translate(sz/2,sz/2); g.scale(K,K);
    const gl = g.createRadialGradient(0,0,6,0,0,14); gl.addColorStop(0,'rgba(220,235,255,.5)'); gl.addColorStop(1,'rgba(220,235,255,0)');
    g.fillStyle = gl; g.beginPath(); g.arc(0,0,14,0,7); g.fill();
    const bg = g.createRadialGradient(-2.5,-3,1,0,0,BALL_R);
    bg.addColorStop(0,'#ffffff'); bg.addColorStop(.5,'#d9e2f2'); bg.addColorStop(1,'#7f8fb0');
    g.fillStyle = bg; g.beginPath(); g.arc(0,0,BALL_R,0,7); g.fill();
    g.fillStyle='rgba(120,135,170,.35)'; g.beginPath(); g.arc(2.5,2,2,0,7); g.fill(); g.beginPath(); g.arc(-1,3.5,1.2,0,7); g.fill();
    SPR.ball = c;
  }
  SPR.K = K;
}
function lighten(hex, a){ const n = parseInt(hex.slice(1),16); let r=n>>16,g=(n>>8)&255,b=n&255; r=Math.round(r+(255-r)*a); g=Math.round(g+(255-g)*a); b=Math.round(b+(255-b)*a); return `rgb(${r},${g},${b})`; }
function roundRect(g,x,y,w,h,r){ g.beginPath(); g.moveTo(x+r,y); g.arcTo(x+w,y,x+w,y+h,r); g.arcTo(x+w,y+h,x,y+h,r); g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath(); }

/* background: sky, moon, hills, river (static layer) */
let BG = null;
function buildBG(){
  const K = 2, c = mkCanvas(CW*K, CH*K), g = c.getContext('2d'); g.scale(K,K);
  const sky = g.createLinearGradient(0,0,0,CH);
  sky.addColorStop(0,'#070b22'); sky.addColorStop(.45,'#111a44'); sky.addColorStop(.78,'#1d2c5e'); sky.addColorStop(1,'#0c1636');
  g.fillStyle = sky; g.fillRect(0,0,CW,CH);
  // stars (seeded)
  let s = 1337; const rnd = ()=> (s = (s*16807)%2147483647)/2147483647;
  for(let i=0;i<220;i++){ const x=rnd()*CW, y=rnd()*CH*.7, r=rnd()*1.1+.2; g.fillStyle=`rgba(255,248,230,${.25+rnd()*.6})`; g.beginPath(); g.arc(x,y,r,0,7); g.fill(); }
  // moon
  const mx = BX+690, my = BY+120;
  const mg = g.createRadialGradient(mx,my,10,mx,my,140); mg.addColorStop(0,'rgba(255,240,200,.28)'); mg.addColorStop(1,'rgba(255,240,200,0)');
  g.fillStyle = mg; g.beginPath(); g.arc(mx,my,140,0,7); g.fill();
  g.fillStyle = '#f7ecd0'; g.beginPath(); g.arc(mx,my,34,0,7); g.fill();
  g.fillStyle = 'rgba(200,185,150,.35)'; g.beginPath(); g.arc(mx-10,my-6,7,0,7); g.fill(); g.beginPath(); g.arc(mx+9,my+10,5,0,7); g.fill(); g.beginPath(); g.arc(mx+12,my-12,3.5,0,7); g.fill();
  // far hills
  const hill = (base, amp, col, seed)=>{ g.fillStyle=col; g.beginPath(); g.moveTo(0,CH); for(let x=0;x<=CW;x+=8){ const y = base - amp*(Math.sin(x*.006+seed)*.6 + Math.sin(x*.017+seed*2)*.3 + Math.sin(x*.041+seed*3)*.1); g.lineTo(x,y); } g.lineTo(CW,CH); g.fill(); };
  hill(BY+500, 46, '#16224d', 1.3);
  hill(BY+530, 34, '#111a3d', 4.1);
  // distant shore lights
  for(let i=0;i<40;i++){ const x=rnd()*CW, y=BY+528+rnd()*16; g.fillStyle=`rgba(255,${170+rnd()*60|0},90,${.35+rnd()*.4})`; g.beginPath(); g.arc(x,y,.9+rnd()*.8,0,7); g.fill(); }
  // river
  const rv = g.createLinearGradient(0,BY+552,0,CH); rv.addColorStop(0,'#13234f'); rv.addColorStop(1,'#08102b');
  g.fillStyle = rv; g.fillRect(0,BY+552,CW,CH-(BY+552));
  // moon reflection
  for(let i=0;i<14;i++){ const y = BY+560+i*5; const w = 28 - i*1.4 + rnd()*8; g.fillStyle=`rgba(255,240,200,${.22 - i*.012})`; g.fillRect(mx - w/2 + (rnd()-.5)*8, y, w, 1.4); }
  // side panels: dark lacquer frames
  g.fillStyle = 'rgba(6,9,26,.55)';
  g.fillRect(0,0,BX,CH); g.fillRect(BX+W,0,CW-BX-W,CH); g.fillRect(BX,0,W,BY);
  // board frame
  g.strokeStyle = 'rgba(242,169,59,.35)'; g.lineWidth = 2; g.strokeRect(BX-1,BY-1,W+2,H+2);
  g.strokeStyle = 'rgba(242,169,59,.12)'; g.lineWidth = 6; g.strokeRect(BX-5,BY-5,W+10,H+10);
  BG = c;
}

/* ================= level state ================= */
let L = null;   // current level runtime
let G = {       // game state
  mode:'title', levelIndex:0, score:0, balls:10, aim:Math.PI/2, state:'aim',
  t:0, shotScore:0, hitCount:0, charges:{}, ballsArr:[], fx:[], texts:[], banner:null,
  slow:1, tension:0, fever:false, feverPhase:0, freeBallThisShot:false, thresholdsHit:0,
  clearQueue:[], clearTimer:0, purpleIdx:-1, totalShots:0, flags:{}, shake:0, guide:null, guideKey:'',
  pendingResult:null, finaleCaught:false
};

function levels(){ return (window.LANTERN_LEVELS && window.LANTERN_LEVELS.length) ? window.LANTERN_LEVELS : FALLBACK_LEVELS; }
const FALLBACK_LEVELS = [(function(){ const pegs=[]; for(let r=0;r<6;r++) for(let c=0;c<14;c++){ pegs.push({x:70+c*51+(r%2)*25, y:170+r*62, shape: (c+r)%4===0?'brick':'round', angle:0}); } return {name:'Practice Pond', hint:'Aim for the middle.', pegs}; })()];

function startLevel(i){
  const LV = levels();
  i = ((i % LV.length) + LV.length) % LV.length;
  G.levelIndex = i; progress.last = i; save('ld.progress', progress);
  const def = LV[i];
  const pegs = def.pegs.map(p => ({
    x:p.x, y:p.y, x0:p.x, y0:p.y, shape:p.shape==='brick'?'brick':'round', angle:p.angle||0,
    ca:Math.cos(p.angle||0), sa:Math.sin(p.angle||0), move:p.move||null, vx:0, vy:0,
    type:'blue', hit:false, removed:false, hitOrder:0, flash:0, wob:Math.random()*6.28
  }));
  // assign colours
  const idx = pegs.map((_,k)=>k); shuffle(idx);
  const nT = Math.min(S.targets, Math.max(1, pegs.length-1));
  const nG = Math.min(S.greens, Math.max(0, pegs.length - nT));
  for(let k=0;k<nT;k++) pegs[idx[k]].type='orange';
  for(let k=nT;k<nT+nG;k++) pegs[idx[k]].type='green';
  L = { def, pegs, totalOrange:nT, name:def.name, hint:def.hint||'' };
  G.score = 0; G.balls = S.balls; G.state='aim'; G.t = 0; G.aim = Math.PI/2;
  G.ballsArr=[]; G.fx=[]; G.texts=[]; G.fever=false; G.feverPhase=0; G.slow=1; G.tension=0;
  G.charges = {}; G.thresholdsHit=0; G.purpleIdx=-1; G.totalShots=0; G.pendingResult=null; G.finaleCaught=false;
  G.lastMulti = 1;
  if(S.startPower && S.startPower!=='none' && PMAP[S.startPower] && PMAP[S.startPower].kind==='charge') addCharge(S.startPower);
  updatePegPositions(0);
  assignPurple();
  G.banner = {text:def.name, sub:L.hint, t:0, dur:2.8};
  G.mode = 'play';
  music('start', i);
  sfx('setMusicVolume', S.music); sfx('setSfxVolume', S.sfx);
  showOverlay(null);
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.random()*(i+1)|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

function orangeLeft(){ let n=0; for(const p of L.pegs) if(p.type==='orange' && !p.hit && !p.removed) n++; return n; }
function orangeHitFrac(){ let lit=0; for(const p of L.pegs) if(p.type==='orange' && (p.hit||p.removed)) lit++; return lit / Math.max(1,L.totalOrange); }
function multiplier(){ const f = orangeHitFrac(); return f>=.88?10 : f>=.76?5 : f>=.6?3 : f>=.4?2 : 1; }

function assignPurple(){
  if(G.purpleIdx>=0){ const p = L.pegs[G.purpleIdx]; if(p && p.type==='purple' && !p.hit && !p.removed) p.type='blue'; }
  G.purpleIdx = -1;
  if(!S.purple) return;
  const cand = []; L.pegs.forEach((p,k)=>{ if(p.type==='blue' && !p.removed && !p.hit) cand.push(k); });
  if(!cand.length) return;
  G.purpleIdx = cand[Math.random()*cand.length|0];
  L.pegs[G.purpleIdx].type = 'purple';
}

/* ================= peg motion ================= */
function movePos(m, t, out){
  if(m.type==='circle'){ const a = m.phase + m.speed*t; out.x = m.cx + m.r*Math.cos(a); out.y = m.cy + m.r*Math.sin(a); }
  else { let u = ((m.phase||0) + m.speed*t) % 1; if(u<0) u+=1; const s = u<.5 ? u*2 : 2-u*2; out.x = m.ax+(m.bx-m.ax)*s; out.y = m.ay+(m.by-m.ay)*s; }
  return out;
}
const tmpA = {x:0,y:0}, tmpB = {x:0,y:0};
function updatePegPositions(t){
  for(const p of L.pegs){ if(!p.move) continue; movePos(p.move,t,tmpA); movePos(p.move,t-DT,tmpB); p.x=tmpA.x; p.y=tmpA.y; p.vx=(tmpA.x-tmpB.x)/DT; p.vy=(tmpA.y-tmpB.y)/DT; }
}

/* ================= boat ================= */
function boatHalf(){ let h = BOAT_SZ[S.boatSize]||52; if((G.charges.wide||0)>0) h*=2; return Math.min(h, 330); }
function boatX(t){ const hw = boatHalf(); const amp = W/2 - hw - 14; return W/2 + amp*Math.sin(t*(BOAT_SPD[S.boatSpeed]??.6)); }
const POTS = [{v:10000},{v:50000},{v:100000},{v:50000},{v:10000}];
const POT_W = W/5;

/* ================= physics core (shared by play + prediction) ================= */
// world W: {t, grav, flame, magnet, bridge, pegs, hit(i)->bool alreadyHit, removed(i), onHit(i,ball)->bounce?, boat:true/false, fever}
function stepBall(b, Wd){
  const g = Wd.grav;
  b.vy += g*DT;
  if(Wd.magnet){
    let best=-1, bd=1e9;
    for(let i=0;i<Wd.pegs.length;i++){ const p=Wd.pegs[i]; if(p.type!=='orange'||Wd.removed(i)||Wd.isHit(i)) continue; const dx=p.x-b.x, dy=p.y-b.y, d=dx*dx+dy*dy; if(d<bd){bd=d;best=i;} }
    if(best>=0){ const p=Wd.pegs[best]; const d=Math.sqrt(bd)||1; const f = 520*Math.min(1, 160/d); b.vx += (p.x-b.x)/d*f*DT; b.vy += (p.y-b.y)/d*f*DT; }
  }
  b.x += b.vx*DT; b.y += b.vy*DT;
  let ev = 0;
  if(b.x < BALL_R){ b.x = BALL_R; if(b.vx<0){ b.vx = -b.vx*.9; ev|=1; } }
  else if(b.x > W-BALL_R){ b.x = W-BALL_R; if(b.vx>0){ b.vx = -b.vx*.9; ev|=1; } }
  if(b.y < BALL_R && b.vy<0){ b.y = BALL_R; b.vy = -b.vy*.9; }
  const pegs = Wd.pegs;
  for(let i=0;i<pegs.length;i++){
    if(Wd.removed(i)) continue;
    const p = pegs[i];
    const dx0 = b.x-p.x, dy0 = b.y-p.y;
    if(dx0>26||dx0<-26||dy0>26||dy0<-26) continue;
    let nx, ny, dist, rad;
    if(p.shape==='round'){ dist = Math.sqrt(dx0*dx0+dy0*dy0); rad = PEG_R+BALL_R; if(dist>=rad) continue; if(dist<1e-6){nx=0;ny=-1;} else {nx=dx0/dist; ny=dy0/dist;} }
    else {
      // capsule: segment along (ca,sa) half length BRICK_HALF
      let u = dx0*p.ca + dy0*p.sa; if(u>BRICK_HALF) u=BRICK_HALF; else if(u<-BRICK_HALF) u=-BRICK_HALF;
      const qx = p.x + p.ca*u, qy = p.y + p.sa*u;
      const ex = b.x-qx, ey = b.y-qy; dist = Math.sqrt(ex*ex+ey*ey); rad = BRICK_R+BALL_R; if(dist>=rad) continue;
      if(dist<1e-6){ nx=-p.sa; ny=p.ca; } else { nx=ex/dist; ny=ey/dist; }
    }
    const bounce = Wd.onHit(i, b);
    if(!bounce) continue;
    b.x += nx*(rad-dist); b.y += ny*(rad-dist);
    const rvx = b.vx - p.vx, rvy = b.vy - p.vy;
    const vn = rvx*nx + rvy*ny;
    if(vn < 0){ b.vx -= (1+REST)*vn*nx; b.vy -= (1+REST)*vn*ny; b.vx *= .995; }
    b.touching = i;
  }
  // boat rims / finale dividers
  if(Wd.fever){
    for(let k=0;k<=5;k++){ rimCollide(b, k*POT_W, BOAT_Y-4, 6); }
  } else if(Wd.boat){
    const bx = boatX(Wd.t), hw = boatHalf();
    rimCollide(b, bx-hw, BOAT_Y, 7); rimCollide(b, bx+hw, BOAT_Y, 7);
  }
  const sp = b.vx*b.vx+b.vy*b.vy; if(sp>MAXV*MAXV){ const k=MAXV/Math.sqrt(sp); b.vx*=k; b.vy*=k; }
  return ev;
}
function rimCollide(b, x, y, r){
  const dx=b.x-x, dy=b.y-y, d=Math.sqrt(dx*dx+dy*dy), rad=r+BALL_R;
  if(d<rad && d>1e-6){ const nx=dx/d, ny=dy/d; b.x+=nx*(rad-d); b.y+=ny*(rad-d); const vn=b.vx*nx+b.vy*ny; if(vn<0){ b.vx-=(1.6)*vn*nx; b.vy-=(1.6)*vn*ny; } }
}
function launchVec(a){ return {x: LX + Math.cos(a)*30, y: LY + Math.sin(a)*30, vx: Math.cos(a)*LAUNCH_SPEED, vy: Math.sin(a)*LAUNCH_SPEED}; }

/* --- prediction (Destiny + Long Sight) --- */
function shotFlags(){
  return {
    flame: S.cheatFlame || (G.charges.flame||0)>0,
    magnet:(G.charges.magnet||0)>0,
    float: (G.charges.float||0)>0,
    bridge: S.cheatBridge ? 1 : 0,
  };
}
function gravityFor(fl){ return (GRAV[S.gravity]||420) * (fl.float ? .55 : 1); }
const simHit = new Uint8Array(512);
function simulate(angle, fl, opts){
  const pegs = L.pegs; const n = pegs.length; simHit.fill(0,0,n);
  const v = launchVec(angle); const b = {x:v.x,y:v.y,vx:v.vx,vy:v.vy};
  const path = opts && opts.path ? [] : null;
  let score = 0, firstHitAt = -1, bridges = fl.bridge;
  // moving pegs: positions at sim time → use a shadow array
  const shadow = (opts && opts.shadow) || makeShadow();
  const movers = shadow.movers;
  const Wd = { t:G.t, grav:gravityFor(fl), magnet:fl.magnet, pegs:shadow, boat:true, fever:false,
    removed:i=>pegs[i].removed, isHit:i=>simHit[i]===1 || pegs[i].hit,
    onHit:(i)=>{ if(!simHit[i] && !pegs[i].hit){ simHit[i]=1; const ty=shadow[i].type; score += ty==='orange'?100 : ty==='purple'?60 : ty==='green'?40 : 10; if(firstHitAt<0) firstHitAt = steps; } return !fl.flame; } };
  const maxSteps = (opts && opts.maxSteps) || 2400;
  let steps = 0;
  for(; steps<maxSteps; steps++){
    Wd.t = G.t + steps*DT;
    for(let j=0;j<movers.length;j++){ const s = shadow[movers[j]]; movePos(s.move, Wd.t, tmpA); movePos(s.move, Wd.t-DT, tmpB); s.x=tmpA.x; s.y=tmpA.y; s.vx=(tmpA.x-tmpB.x)/DT; s.vy=(tmpA.y-tmpB.y)/DT; }
    stepBall(b, Wd);
    if(path && steps%6===0) path.push(b.x, b.y);
    if(opts && opts.stopAtHits && firstHitAt>=0 && steps - firstHitAt > (opts.stopAtHits)) break;
    if(b.y > BOAT_Y-4 && b.vy>0){
      const bx = boatX(Wd.t), hw = boatHalf();
      if(Math.abs(b.x-bx) < hw-4){ score += 150; break; }
    }
    if(b.y > H + 20){ if(bridges>0){ bridges--; b.y = H-2; b.vy = -Math.abs(b.vy)*.95 - 120; } else break; }
  }
  if(path) path.push(b.x, b.y);
  return {score, path};
}
function makeShadow(){
  const sh = L.pegs.map(p=>({x:p.x,y:p.y,vx:p.vx,vy:p.vy,shape:p.shape,ca:p.ca,sa:p.sa,type:p.type,move:p.move}));
  sh.movers = []; sh.forEach((p,i)=>{ if(p.move) sh.movers.push(i); });
  return sh;
}
function destinyAngle(base){
  const fl = shotFlags();
  const shadow = makeShadow();
  let best = base, bs = -1;
  const span = 0.24, N = 48;
  const cands = [base];
  for(let k=1;k<=N/2;k++){ cands.push(base + span*k/(N/2), base - span*k/(N/2)); }
  for(const a of cands){
    if(a<A_MIN||a>A_MAX) continue;
    const r = simulate(a, fl, {maxSteps:2000, shadow});
    const sc = r.score - Math.abs(a-base)*20;
    if(sc > bs){ bs = sc; best = a; }
  }
  return best;
}

/* ================= shooting ================= */
function canFire(){ return G.mode==='play' && G.state==='aim' && !G.banner?.block && (S.infinite || G.balls>0); }
function fire(){
  if(!canFire()) return;
  let a = G.aim;
  G.flags = shotFlags();
  let destinyUsed = false;
  if(S.cheatDestiny || (G.charges.destiny||0)>0){
    a = destinyAngle(a); destinyUsed = true;
    if(!S.cheatDestiny) useCharge('destiny');
    G.fx.push({k:'beam', a, t:0, dur:.6});
    sfx('powerReady','destiny');
    G.aim = a;
  }
  if((G.charges.flame||0)>0) useCharge('flame');
  if((G.charges.magnet||0)>0) useCharge('magnet');
  if((G.charges.float||0)>0) useCharge('float');
  if((G.charges.foresight||0)>0) useCharge('foresight');
  if(!S.infinite) G.balls--;
  G.totalShots++;
  const v = launchVec(a);
  G.ballsArr = [mkBall(v)];
  G.state = 'fly'; G.shotScore = 0; G.hitCount = 0; G.freeBallThisShot = false; G.stuck = 0;
  G.bridges = G.flags.bridge; G.secondWind = 0;
  G.recoil = 1;
  sfx('launch');
  if(G.flags.flame) sfx('fire');
}
function mkBall(v){ return {x:v.x,y:v.y,vx:v.vx,vy:v.vy, trail:[], touching:-1, stuckT:0, alive:true, caught:false, lastX:v.x, lastY:v.y}; }
function addCharge(id){ const P = PMAP[id]; G.charges[id] = (G.charges[id]||0) + P.base*S.strength; }
function useCharge(id){ G.charges[id] = Math.max(0,(G.charges[id]||0)-1); }

/* ================= hits & powers ================= */
function onPegHit(i, ball){
  const p = L.pegs[i];
  if(p.hit) { return !G.flags.flame; }
  lightPeg(i, ball);
  return !G.flags.flame;
}
function lightPeg(i, ball, quiet){
  const p = L.pegs[i]; if(p.hit||p.removed) return;
  p.hit = true; p.flash = 1; G.hitCount++; p.hitOrder = G.hitCount;
  const m = multiplier();
  const base = p.type==='orange'?100 : p.type==='purple'?500 : 10;
  const pts = base * m;
  G.shotScore += pts; addScore(pts);
  if(p.type==='orange' || p.type==='purple' || m>1) G.texts.push({x:p.x, y:p.y-14, s: '+'+pts.toLocaleString(), t:0, col: p.type==='purple'?'#e7c4ff':p.type==='orange'?'#ffd27a':'#bfe6ff'});
  if(p.shape==='brick') sfx('brickHit', G.hitCount, p.type); else sfx('pegHit', G.hitCount, p.type);
  for(let k=0;k<6;k++) G.fx.push({k:'spark', x:p.x, y:p.y, vx:(Math.random()-.5)*160, vy:(Math.random()-.5)*160-40, t:0, dur:.45+Math.random()*.3, col:PAL[p.type].lit});
  const newM = multiplier();
  if(newM > (G.lastMulti||1)){ G.lastMulti = newM; G.texts.push({x:W/2, y:H/2-40, s:'×'+newM+' multiplier', t:0, big:true, col:'#ffd27a'}); sfx('powerReady','mult'+newM); }
  if(p.type==='green') triggerPower(p, ball);
  if(p.type==='orange' && orangeLeft()===0 && !G.fever) startFever(p);
}
function addScore(pts){
  const before = G.score; G.score += pts;
}
function pickPower(){
  const pool = S.pool.filter(id=>PMAP[id]);
  if(!pool.length) return null;
  return pool[Math.random()*pool.length|0];
}
function triggerPower(p, ball){
  const id = pickPower(); if(!id) return;
  const P = PMAP[id];
  G.banner = {text:P.name, sub:P.desc, t:0, dur:1.8, power:true};
  sfx('powerReady', id);
  G.fx.push({k:'ring', x:p.x, y:p.y, t:0, dur:.7, col:'rgba(120,255,180,'});
  const s = S.strength;
  switch(id){
    case 'multiball': {
      for(let k=0;k<s;k++){ const b = ball || G.ballsArr[0]; const nb = mkBall({x:p.x, y:p.y-18, vx: -(b?b.vx:0) + (k%2?60:-60)*(k+1), vy: -Math.abs(b?b.vy:200)*.6 - 80}); G.ballsArr.push(nb); }
      sfx('extraBall'); break; }
    case 'blast': {
      const R = 95 + 25*(s-1);
      G.fx.push({k:'boom', x:p.x, y:p.y, r:R, t:0, dur:.8});
      G.shake = .5; sfx('explosion');
      const list = [];
      L.pegs.forEach((q,k)=>{ if(!q.hit && !q.removed){ const d = Math.hypot(q.x-p.x, q.y-p.y); if(d<=R) list.push([d,k]); } });
      list.sort((a,b)=>a[0]-b[0]);
      list.forEach(([d,k],n)=> setTimeoutGame(()=>lightPeg(k, ball), n*0.025));
      break; }
    case 'spark': {
      sfx('zap');
      const n = 5*s;
      const cand = []; L.pegs.forEach((q,k)=>{ if(!q.hit && !q.removed) cand.push(k); });
      let from = {x:p.x, y:p.y};
      const chosen = [];
      for(let c=0;c<n && cand.length;c++){
        let bi=-1, bd=1e18;
        for(let j=0;j<cand.length;j++){ const q = L.pegs[cand[j]]; let d = (q.x-from.x)**2+(q.y-from.y)**2; if(q.type==='orange') d *= .35; if(d<bd){bd=d;bi=j;} }
        const k = cand.splice(bi,1)[0]; const q = L.pegs[k];
        chosen.push({k, fx:from.x, fy:from.y, tx:q.x, ty:q.y}); from = {x:q.x,y:q.y};
      }
      chosen.forEach((c,n2)=> setTimeoutGame(()=>{ G.fx.push({k:'bolt', x1:c.fx,y1:c.fy,x2:c.tx,y2:c.ty,t:0,dur:.35}); sfx('zap'); lightPeg(c.k, ball); }, n2*0.09));
      break; }
    case 'bridge': G.bridges = (G.bridges||0) + s; break;
    case 'secondwind': G.secondWind = (G.secondWind||0) + s; break;
    default: addCharge(id);
  }
}
let gameTimers = [];
function setTimeoutGame(fn, delay){ gameTimers.push({at:G.t+delay, fn}); }

function startFever(p){
  G.fever = true; G.feverPhase = 1; G.slow = .25; G.slowHold = 1.6;
  G.banner = {text:'Grand Finale', sub:'Drop it into a prize lantern', t:0, dur:2.6, finale:true};
  sfx('stopTension'); sfx('feverStart'); sfx('feverMusic'); music('duck', true);
  for(let k=0;k<40;k++){ const a=Math.random()*6.28, sp=60+Math.random()*260; G.fx.push({k:'spark', x:p.x,y:p.y,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp,t:0,dur:.8+Math.random()*.8,col:['#ffd27a','#ffe9c4','#ff9a4a','#fff'][k%4]}); }
  G.fx.push({k:'boom', x:p.x, y:p.y, r:140, t:0, dur:1});
}

/* ================= update ================= */
let fastForward = false;
function update(realDt){
  if(G.mode!=='play') return;
  realDt = Math.min(realDt, 1/20);
  // banner timing
  if(G.banner){ G.banner.t += realDt; if(G.banner.t > G.banner.dur) G.banner = null; }
  // slowmo
  let ts = S.speed * (fastForward && G.state!=='aim' ? 3 : 1);
  if(G.slowHold>0){ G.slowHold -= realDt; if(G.slowHold<=0) G.slow = 1; }
  else if(G.slow < 1) G.slow = Math.min(1, G.slow + realDt*1.5);
  ts *= G.slow;
  G.acc = (G.acc||0) + realDt*ts;
  let steps = 0;
  while(G.acc >= DT && steps < 240){ G.acc -= DT; steps++; fixedStep(); }
  // fx (real time-ish but scaled with slowmo for drama)
  const fdt = realDt * Math.max(.35, G.slow);
  for(const f of G.fx){ f.t += fdt; if(f.k==='spark'){ f.x+=f.vx*fdt; f.y+=f.vy*fdt; f.vy+=300*fdt; } }
  G.fx = G.fx.filter(f=>f.t<f.dur);
  for(const t of G.texts){ t.t += realDt; t.y -= (t.big?14:28)*realDt; }
  G.texts = G.texts.filter(t=>t.t < (t.big?1.6:1.0));
  if(G.shake>0) G.shake = Math.max(0, G.shake - realDt);
  if(G.recoil>0) G.recoil = Math.max(0, G.recoil - realDt*4);
  for(const p of L.pegs){ if(p.flash>0) p.flash = Math.max(0, p.flash - realDt*3); }
  // clearing phase
  if(G.state==='clear'){
    G.clearTimer -= realDt*(fastForward?3:1);
    while(G.clearTimer<=0 && G.clearQueue.length){
      const k = G.clearQueue.shift(); const p = L.pegs[k]; p.removed = true;
      for(let j=0;j<5;j++) G.fx.push({k:'spark', x:p.x,y:p.y,vx:(Math.random()-.5)*120,vy:-Math.random()*140,t:0,dur:.5,col:PAL[p.type].lit});
      G.fx.push({k:'pop', x:p.x,y:p.y,t:0,dur:.25,col:PAL[p.type].lit});
      G.clearTimer += 0.045;
    }
    if(!G.clearQueue.length && G.clearTimer<=0) endTurn();
  }
  if(G.state==='finaleWait'){
    G.finaleT -= realDt; if(G.finaleT<=0) finishLevel(true);
  }
}
function fixedStep(){
  G.t += DT;
  updatePegPositions(G.t);
  // game timers
  if(gameTimers.length){ const due = gameTimers.filter(x=>x.at<=G.t); gameTimers = gameTimers.filter(x=>x.at>G.t); due.forEach(x=>{ try{x.fn();}catch(e){} }); }
  if(G.state!=='fly') return;
  const Wd = { t:G.t, grav:gravityFor(G.flags), magnet:G.flags.magnet, pegs:L.pegs, boat:!G.fever, fever:G.fever && G.feverPhase>=1,
    removed:i=>L.pegs[i].removed, isHit:i=>L.pegs[i].hit, onHit:onPegHit };
  let anyAlive = false;
  for(const b of G.ballsArr){
    if(!b.alive) continue;
    b.touching = -1;
    const ev = stepBall(b, Wd);
    if(ev&1) sfx('bounceWall');
    // trail
    if(((G.t/DT)|0)%3===0){ b.trail.push(b.x,b.y); if(b.trail.length>36) b.trail.splice(0,2); }
    // stuck detection: slow & touching a lit peg
    // stuck detection: the ball has barely moved over the last second
    b.stuckT += DT;
    if(b.stuckT >= 1){
      const moved = Math.hypot(b.x-b.lastX, b.y-b.lastY);
      b.lastX = b.x; b.lastY = b.y; b.stuckT = 0;
      if(moved < 14){
        let bi=-1, bd=34*34;
        L.pegs.forEach((p,k)=>{ if(p.removed||!p.hit) return; const d=(p.x-b.x)**2+(p.y-b.y)**2; if(d<bd){bd=d;bi=k;} });
        if(bi>=0){ const p=L.pegs[bi]; p.removed = true; G.fx.push({k:'pop',x:p.x,y:p.y,t:0,dur:.3,col:PAL[p.type].lit}); }
        else { b.vx += (Math.random()-.5)*160; b.vy -= 60; }
      }
    }
    b.age = (b.age||0) + DT;
    if(b.age > 45){ b.alive = false; continue; }
    // tension near last orange
    if(!G.fever){
      const left = []; for(const p of L.pegs) if(p.type==='orange' && !p.hit && !p.removed) left.push(p);
      if(left.length===1){ const p = left[0]; const d = Math.hypot(p.x-b.x, p.y-b.y); const approaching = ((p.x-b.x)*b.vx + (p.y-b.y)*b.vy) > 0;
        if(d < 75 && approaching && !G.tensionOn){ G.tensionOn = true; G.slow = .3; G.slowHold = .55; sfx('tension'); }
        if(d > 140 && G.tensionOn){ G.tensionOn = false; } }
    }
    // catches
    if(G.fever){
      if(b.y > BOAT_Y + 2 && !b.caught){ const k = Math.max(0, Math.min(4, (b.x/POT_W)|0)); b.caught = true; b.alive = false; finaleCatch(k); }
    } else if(b.y > BOAT_Y-4 && b.vy>0 && !b.caught){
      const bx = boatX(G.t), hw = boatHalf();
      if(Math.abs(b.x-bx) < hw-4){ b.caught = true; b.alive = false; if(!G.freeBallThisShot){ G.freeBallThisShot = true; if(!S.infinite) G.balls++; G.texts.push({x:bx, y:BOAT_Y-30, s:'Free ball', t:0, col:'#c8ffe0', big:true}); sfx('bucket'); } }
    }
    if(b.alive && b.y > H + 20){
      if((G.bridges||0)>0){ G.bridges--; b.y = H-2; b.vy = -Math.abs(b.vy)*.95 - 120; G.fx.push({k:'ring',x:b.x,y:H-6,t:0,dur:.6,col:'rgba(255,240,200,'}); sfx('powerReady','bridge'); }
      else if((G.secondWind||0)>0){ G.secondWind--; b.x = 120 + Math.random()*560; b.y = 4; b.vx = (Math.random()-.5)*120; b.vy = 40; b.trail.length=0; sfx('magnet'); G.texts.push({x:b.x,y:40,s:'Second Wind',t:0,col:'#c8ffe0'}); }
      else { b.alive = false; sfx('ballLost'); }
    }
    if(b.alive) anyAlive = true;
  }
  if(!anyAlive) endShot();
}
function endShot(){
  G.ballsArr = []; G.tensionOn = false; sfx('stopTension');
  if(G.fever){ return; } // finaleCatch handles it
  // score-based extra balls
  if(S.scoreBalls){
    const th = [25000, 75000, 125000];
    let gained = 0; for(const v of th) if(G.shotScore >= v) gained++;
    if(gained){ if(!S.infinite) G.balls += gained; G.texts.push({x:W/2, y:H/2, s: gained>1 ? `+${gained} balls` : '+1 ball', t:0, big:true, col:'#c8ffe0'}); sfx('extraBall'); }
  }
  // queue clearing by hit order
  const q = []; L.pegs.forEach((p,k)=>{ if(p.hit && !p.removed) q.push(k); });
  q.sort((a,b)=>L.pegs[a].hitOrder - L.pegs[b].hitOrder);
  G.clearQueue = q; G.clearTimer = 0.25; G.state = 'clear';
  if(G.shotScore>0) G.texts.push({x:W/2, y:96, s:G.shotScore.toLocaleString(), t:0, big:true, col:'#f4e7c8'});
}
function endTurn(){
  if((G.charges.wide||0)>0) useCharge('wide');
  if(orangeLeft()===0){ finishLevel(true); return; }
  if(!S.infinite && G.balls<=0){ finishLevel(false); return; }
  assignPurple();
  G.state = 'aim';
}
function finaleCatch(k){
  const v = POTS[k].v; addScore(v); G.finaleCaught = true;
  G.texts.push({x:k*POT_W+POT_W/2, y:BOAT_Y-40, s:'+'+v.toLocaleString(), t:0, big:true, col:'#ffd27a'});
  for(let j=0;j<60;j++){ const a=Math.random()*6.28, sp=80+Math.random()*320; G.fx.push({k:'spark',x:k*POT_W+POT_W/2,y:BOAT_Y-10,vx:Math.cos(a)*sp,vy:Math.sin(a)*sp-120,t:0,dur:1+Math.random(),col:['#ffd27a','#fff','#ff9a4a','#c8ffe0','#e7c4ff'][j%5]}); }
  sfx('levelClear');
  // other balls in multiball finish too
  G.state = 'finaleWait'; G.finaleT = 2.2; G.ballsArr = [];
}
function finishLevel(won){
  G.state = 'done';
  sfx('stopFever'); music('duck', false);
  let bonus = 0;
  if(won && !S.infinite){ bonus = G.balls*10000; G.score += bonus; }
  const key = String(G.levelIndex);
  if(won){ progress.cleared[key] = true; if(!progress.best[key] || G.score > progress.best[key]) progress.best[key] = G.score; save('ld.progress', progress); }
  if(!won) sfx('fail');
  setTimeout(()=>showResult(won, bonus), won?400:700);
}

/* ================= aim guide ================= */
function computeGuide(){
  const full = S.guide==='full' || (G.charges.foresight||0)>0;
  const key = G.aim.toFixed(4)+'|'+full+'|'+S.guide+'|'+(G.t*4|0)*(L.pegs.some(p=>p.move)?1:0)+'|'+L.pegs.filter(p=>p.removed).length+'|'+JSON.stringify(G.charges)+S.gravity+S.boatSize;
  if(key===G.guideKey) return G.guide;
  G.guideKey = key;
  const fl = shotFlags();
  let r;
  if(full) r = simulate(G.aim, fl, {path:true, maxSteps:1500});
  else if(S.guide==='long') r = simulate(G.aim, fl, {path:true, maxSteps:1500, stopAtHits:70});
  else r = simulate(G.aim, fl, {path:true, maxSteps:1500, stopAtHits:1});
  G.guide = {path:r.path, full};
  return G.guide;
}

/* ================= render ================= */
let lastFrame = performance.now(), lanternsSky = [];
function initSkyLanterns(){ lanternsSky = []; for(let i=0;i<14;i++) lanternsSky.push({x:Math.random()*CW, y:Math.random()*CH, s:.5+Math.random()*.8, v:6+Math.random()*12, ph:Math.random()*6}); }
function render(now){
  const g = ctx;
  g.setTransform(1,0,0,1,0,0);
  g.clearRect(0,0,cv.width,cv.height);
  const k = scale*dpr;
  g.setTransform(k,0,0,k,0,0);
  if(BG) g.drawImage(BG,0,0,CW,CH);
  // drifting sky lanterns (ambient)
  const tt = now/1000;
  for(const s of lanternsSky){
    s.y -= s.v*(1/60); if(s.y < -20){ s.y = CH+20; s.x = Math.random()*CW; }
    const x = s.x + Math.sin(tt*.5+s.ph)*6;
    const gl = g.createRadialGradient(x,s.y,0,x,s.y,10*s.s); gl.addColorStop(0,'rgba(255,190,90,.55)'); gl.addColorStop(1,'rgba(255,190,90,0)');
    g.fillStyle = gl; g.fillRect(x-10*s.s, s.y-10*s.s, 20*s.s, 20*s.s);
    g.fillStyle = 'rgba(255,200,110,.75)'; g.fillRect(x-2*s.s, s.y-3*s.s, 4*s.s, 5*s.s);
  }
  if(G.mode==='play' || G.mode==='paused' || G.mode==='result'){ if(L) drawGame(g, tt); }
}
function drawGame(g, tt){
  g.save();
  let sx=0, sy=0; if(G.shake>0){ sx=(Math.random()-.5)*10*G.shake; sy=(Math.random()-.5)*10*G.shake; }
  g.translate(BX+sx, BY+sy);
  g.save(); g.beginPath(); g.rect(-4,-4,W+8,H+40); g.clip();
  // river shimmer
  g.globalAlpha = .5;
  for(let i=0;i<6;i++){ const y = 572 + i*8; const off = Math.sin(tt*.8+i)*30; g.strokeStyle='rgba(160,190,255,.12)'; g.lineWidth=1; g.beginPath(); for(let x=-20;x<=W+20;x+=40){ g.moveTo(x+off+i*13, y); g.lineTo(x+off+i*13+18, y);} g.stroke(); }
  g.globalAlpha = 1;
  // aim guide
  if(G.state==='aim' && G.mode==='play'){
    const gd = computeGuide();
    if(gd && gd.path){
      const P = gd.path; const n = P.length/2;
      for(let i=0;i<n;i++){ const a = gd.full ? Math.max(.15, 1 - i/n) : Math.max(.2, 1 - i/(n+4)); g.fillStyle = gd.full ? `rgba(200,255,220,${a*.85})` : `rgba(255,236,200,${a*.8})`; g.beginPath(); g.arc(P[i*2],P[i*2+1], gd.full?2.2:2.6, 0, 7); g.fill(); }
    }
  }
  // pegs
  const K = SPR.K;
  for(const p of L.pegs){
    if(p.removed) continue;
    const lit = p.hit ? 1 : 0;
    if(p.shape==='round'){
      const spr = SPR[p.type+'_r_'+lit]; const sz = 40;
      const bob = lit ? 0 : Math.sin(tt*1.4+p.wob)*.6;
      const s = 1 + p.flash*.35;
      g.drawImage(spr, p.x - sz/2*s, p.y - sz/2*s + bob, sz*s, sz*s);
    } else {
      const spr = SPR[p.type+'_b_'+lit];
      g.save(); g.translate(p.x,p.y); g.rotate(p.angle); const s = 1+p.flash*.25; g.scale(s,s); g.drawImage(spr, -25, -15, 50, 30); g.restore();
    }
  }
  // boat or finale lanterns
  if(G.fever) drawPots(g, tt); else drawBoat(g, tt);
  // balls
  for(const b of G.ballsArr){
    if(!b.alive) continue;
    const T = b.trail;
    for(let i=0;i<T.length;i+=2){ const a = (i/T.length); g.fillStyle = G.flags.flame ? `rgba(255,${120+a*100|0},40,${a*.7})` : `rgba(210,225,255,${a*.35})`; g.beginPath(); g.arc(T[i],T[i+1], BALL_R*(.3+a*.6), 0, 7); g.fill(); }
    if(G.flags.flame){ const gl = g.createRadialGradient(b.x,b.y,2,b.x,b.y,20); gl.addColorStop(0,'rgba(255,200,80,.9)'); gl.addColorStop(1,'rgba(255,80,20,0)'); g.fillStyle=gl; g.beginPath(); g.arc(b.x,b.y,20,0,7); g.fill(); }
    if(G.flags.magnet){ g.strokeStyle='rgba(255,220,140,.5)'; g.lineWidth=1; g.beginPath(); g.arc(b.x,b.y,13+Math.sin(tt*12)*2,0,7); g.stroke(); }
    g.drawImage(SPR.ball, b.x-15, b.y-15, 30, 30);
  }
  // fx
  for(const f of G.fx){
    const u = f.t/f.dur;
    if(f.k==='spark'){ g.globalAlpha = 1-u; g.fillStyle = f.col; g.fillRect(f.x-1.5,f.y-1.5,3,3); g.globalAlpha=1; }
    else if(f.k==='pop'){ g.strokeStyle = f.col; g.globalAlpha = 1-u; g.lineWidth = 2; g.beginPath(); g.arc(f.x,f.y, 8+u*16, 0, 7); g.stroke(); g.globalAlpha=1; }
    else if(f.k==='ring'){ g.strokeStyle = f.col+(1-u)+')'; g.lineWidth = 3*(1-u)+1; g.beginPath(); g.arc(f.x,f.y, 10+u*70, 0, 7); g.stroke(); }
    else if(f.k==='boom'){ const r = f.r*Math.min(1,u*2.5); const gl = g.createRadialGradient(f.x,f.y,0,f.x,f.y,r||1); gl.addColorStop(0,`rgba(255,240,200,${.6*(1-u)})`); gl.addColorStop(.6,`rgba(255,150,60,${.35*(1-u)})`); gl.addColorStop(1,'rgba(255,120,40,0)'); g.fillStyle=gl; g.beginPath(); g.arc(f.x,f.y,r||1,0,7); g.fill(); }
    else if(f.k==='bolt'){ g.strokeStyle = `rgba(200,240,255,${1-u})`; g.lineWidth = 2.5; g.beginPath(); g.moveTo(f.x1,f.y1); const segs=6; for(let s=1;s<segs;s++){ const t=s/segs; g.lineTo(f.x1+(f.x2-f.x1)*t+(Math.random()-.5)*14, f.y1+(f.y2-f.y1)*t+(Math.random()-.5)*14); } g.lineTo(f.x2,f.y2); g.stroke(); }
    else if(f.k==='beam'){ g.strokeStyle = `rgba(255,220,120,${.8*(1-u)})`; g.lineWidth = 6*(1-u)+1; g.beginPath(); g.moveTo(LX,LY); g.lineTo(LX+Math.cos(f.a)*700, LY+Math.sin(f.a)*700); g.stroke(); }
  }
  // launcher
  drawLauncher(g, tt);
  g.restore(); // clip
  // texts
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for(const t of G.texts){
    const life = t.big?1.6:1.0; const a = Math.min(1, (life - t.t)*3);
    g.globalAlpha = Math.max(0,a);
    g.font = t.big ? '800 26px "M PLUS Rounded 1c", sans-serif' : '800 15px "M PLUS Rounded 1c", sans-serif';
    g.lineWidth = 4; g.strokeStyle = 'rgba(8,12,32,.85)'; g.strokeText(t.s, t.x, t.y);
    g.fillStyle = t.col; g.fillText(t.s, t.x, t.y);
  }
  g.globalAlpha = 1;
  // banner
  if(G.banner){
    const b = G.banner; const u = b.t/b.dur; const a = u<.12 ? u/.12 : u>.8 ? (1-u)/.2 : 1;
    g.globalAlpha = Math.max(0,a);
    const y = b.finale ? H*.38 : b.power ? H*.42 : H*.4;
    g.fillStyle = 'rgba(8,12,32,.6)'; g.fillRect(0, y-44, W, b.sub?86:64);
    g.font = `800 ${b.finale?50:38}px "Shippori Mincho B1", serif`;
    g.fillStyle = b.power ? '#c8ffe0' : '#ffe3a0'; g.shadowColor = b.power?'rgba(90,255,160,.8)':'rgba(255,170,60,.8)'; g.shadowBlur = 18;
    g.fillText(b.text, W/2, y-8); g.shadowBlur = 0;
    if(b.sub){ g.font = '500 15px "M PLUS Rounded 1c", sans-serif'; g.fillStyle = '#f4e7c8'; g.fillText(b.sub, W/2, y+26); }
    g.globalAlpha = 1;
  }
  g.restore();
  drawHUD(g, tt);
}
function drawBoat(g, tt){
  const bx = boatX(G.t), hw = boatHalf(), y = BOAT_Y + Math.sin(tt*2)*1.2;
  // reflection glow
  const gl = g.createRadialGradient(bx, y+8, 4, bx, y+8, hw+30); gl.addColorStop(0,'rgba(255,190,90,.25)'); gl.addColorStop(1,'rgba(255,190,90,0)'); g.fillStyle = gl; g.fillRect(bx-hw-30, y-20, hw*2+60, 60);
  // hull
  g.fillStyle = '#4a2a17'; g.strokeStyle = '#2a170b'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(bx-hw-8, y-6); g.quadraticCurveTo(bx, y+26, bx+hw+8, y-6); g.lineTo(bx+hw-2, y+4); g.quadraticCurveTo(bx, y+20, bx-hw+2, y+4); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#6b4024'; g.beginPath(); g.moveTo(bx-hw-8, y-6); g.quadraticCurveTo(bx, y+12, bx+hw+8, y-6); g.quadraticCurveTo(bx, y+6, bx-hw-8,y-6); g.fill();
  // rim posts with small lanterns
  for(const sgn of [-1,1]){ const x = bx+sgn*hw; g.fillStyle='#2a170b'; g.fillRect(x-1.5, y-16, 3, 14); g.fillStyle='#ffcf7a'; g.shadowColor='rgba(255,180,80,.9)'; g.shadowBlur=10; g.beginPath(); g.ellipse(x, y-19, 4, 5, 0, 0, 7); g.fill(); g.shadowBlur=0; }
}
function drawPots(g, tt){
  for(let k=0;k<5;k++){
    const x0 = k*POT_W, cx = x0+POT_W/2, v = POTS[k].v;
    const hue = v===100000 ? 'rgba(255,200,90,' : v===50000 ? 'rgba(255,150,80,' : 'rgba(200,140,255,';
    const pulse = .5+.5*Math.sin(tt*4+k);
    const gl = g.createLinearGradient(0, BOAT_Y-30, 0, H); gl.addColorStop(0, hue+'0)'); gl.addColorStop(1, hue+(.35+pulse*.2)+')');
    g.fillStyle = gl; g.fillRect(x0+4, BOAT_Y-30, POT_W-8, H-BOAT_Y+30);
    g.font = '800 17px "M PLUS Rounded 1c", sans-serif'; g.textAlign='center'; g.textBaseline='middle';
    g.fillStyle = '#fff4dc'; g.fillText(v.toLocaleString(), cx, BOAT_Y+8);
  }
  for(let k=0;k<=5;k++){ g.fillStyle='#ffcf7a'; g.shadowColor='rgba(255,180,80,.9)'; g.shadowBlur=10; g.beginPath(); g.arc(k*POT_W, BOAT_Y-4, 6, 0, 7); g.fill(); g.shadowBlur=0; }
}
function drawLauncher(g, tt){
  const a = G.aim;
  g.save(); g.translate(LX, LY);
  const gl = g.createRadialGradient(0,0,4,0,0,46); gl.addColorStop(0,'rgba(255,200,110,.35)'); gl.addColorStop(1,'rgba(255,200,110,0)');
  g.fillStyle = gl; g.beginPath(); g.arc(0,0,46,0,7); g.fill();
  for(let i=0;i<8;i++){ g.save(); g.rotate(i*Math.PI/4 + Math.sin(tt*.6)*.05); g.fillStyle = i%2 ? '#c46a3a' : '#e38b4e'; g.beginPath(); g.ellipse(0,-15,6,12,0,0,7); g.fill(); g.restore(); }
  g.save(); g.rotate(a - Math.PI/2);
  const rec = G.recoil*6;
  g.fillStyle = '#8a5a26'; g.strokeStyle='#3b230c'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(-9, 0-rec); g.lineTo(-7, 32-rec); g.quadraticCurveTo(0, 38-rec, 7, 32-rec); g.lineTo(9, 0-rec); g.closePath(); g.fill(); g.stroke();
  g.fillStyle = '#d39b4a'; g.fillRect(-8, 26-rec, 16, 4);
  g.restore();
  g.fillStyle = '#f6d38a'; g.beginPath(); g.arc(0,0,10,0,7); g.fill();
  if(G.state==='aim'){ g.drawImage(SPR.ball, -11, -11, 22, 22); }
  g.restore();
}
function drawHUD(g, tt){
  g.textBaseline = 'middle';
  // top strip
  g.textAlign = 'left'; g.fillStyle = '#f2a93b'; g.font = '800 11px "M PLUS Rounded 1c", sans-serif';
  g.fillText('SCORE', BX, 18);
  g.fillStyle = '#f4e7c8'; g.font = '800 22px "M PLUS Rounded 1c", sans-serif';
  g.fillText(G.score.toLocaleString(), BX, 38);
  g.textAlign = 'center'; g.font = '800 20px "Shippori Mincho B1", serif'; g.fillStyle = '#f4e7c8';
  const LV = levels();
  g.fillText(L.name, BX+W/2, 24);
  g.font = '500 11px "M PLUS Rounded 1c", sans-serif'; g.fillStyle = '#b9ad93';
  g.fillText(`Level ${G.levelIndex+1} of ${LV.length}`, BX+W/2, 42);
  g.textAlign = 'right'; g.font = '800 11px "M PLUS Rounded 1c", sans-serif'; g.fillStyle = '#f2a93b';
  g.fillText('AMBER LEFT', BX+W-110, 18);
  g.fillStyle = '#ffd27a'; g.font = '800 22px "M PLUS Rounded 1c", sans-serif';
  g.fillText(String(orangeLeft()), BX+W-110, 38);
  // left: balls tube
  const cx = BX/2;
  g.textAlign='center'; g.fillStyle = '#f2a93b'; g.font = '800 10px "M PLUS Rounded 1c", sans-serif';
  g.fillText('BALLS', cx, BY+12);
  g.fillStyle = 'rgba(8,12,32,.7)'; roundRect(g, cx-16, BY+24, 32, H-40, 16); g.fill();
  g.strokeStyle = 'rgba(242,169,59,.3)'; g.lineWidth=1; roundRect(g, cx-16, BY+24, 32, H-40, 16); g.stroke();
  if(S.infinite){ g.fillStyle = '#f4e7c8'; g.font = '800 30px "M PLUS Rounded 1c", sans-serif'; g.fillText('∞', cx, BY+H/2); }
  else {
    const maxShow = 22; const n = Math.min(G.balls, maxShow);
    for(let i=0;i<n;i++){ const y = BY+H-34 - i*25; g.drawImage(SPR.ball, cx-13, y-13, 26, 26); }
    g.fillStyle = '#f4e7c8'; g.font = '800 15px "M PLUS Rounded 1c", sans-serif'; g.fillText(String(G.balls), cx, BY+H+2 > CH-8 ? CH-10 : BY+H+2);
  }
  // right: amber meter + powers
  const rx = BX+W+40, top = BY+24, hh = 360;
  g.fillStyle = '#f2a93b'; g.font = '800 10px "M PLUS Rounded 1c", sans-serif'; g.fillText('BONUS', rx, BY+12);
  g.fillStyle = 'rgba(8,12,32,.7)'; roundRect(g, rx-12, top, 24, hh, 12); g.fill();
  const f = orangeHitFrac();
  const grd = g.createLinearGradient(0, top+hh, 0, top); grd.addColorStop(0,'#c9701f'); grd.addColorStop(1,'#ffe3a0');
  g.fillStyle = grd; const fh = (hh-6)*f; roundRect(g, rx-9, top+hh-3-fh, 18, Math.max(fh, 0.01), 9); if(fh>1) g.fill();
  for(const [fr, m] of [[.4,2],[.6,3],[.76,5],[.88,10]]){ const y = top+hh-3-(hh-6)*fr; g.strokeStyle = f>=fr ? '#fff4dc' : 'rgba(244,231,200,.35)'; g.beginPath(); g.moveTo(rx-14,y); g.lineTo(rx+14,y); g.stroke(); g.fillStyle = f>=fr ? '#ffd27a' : '#b9ad93'; g.font = '800 11px "M PLUS Rounded 1c", sans-serif'; g.textAlign='right'; g.fillText('×'+m, rx-16, y); g.textAlign='center'; }
  // powers list
  let py = top + hh + 26;
  g.fillStyle = '#4fcf8e'; g.font = '800 10px "M PLUS Rounded 1c", sans-serif'; g.fillText('POWERS', rx, py); py += 18;
  const active = [];
  for(const id of Object.keys(G.charges)) if(G.charges[id]>0) active.push([PMAP[id].name, G.charges[id]]);
  if(S.cheatDestiny) active.push(['Destiny Shot','∞']);
  if(S.cheatFlame) active.push(['Ember Stone','∞']);
  if(S.cheatBridge) active.push(['Moon Bridge','∞']);
  if(G.state==='fly' && (G.bridges||0)>0 && !S.cheatBridge) active.push(['Moon Bridge', G.bridges]);
  if(G.state==='fly' && (G.secondWind||0)>0) active.push(['Second Wind', G.secondWind]);
  g.font = '700 10px "M PLUS Rounded 1c", sans-serif';
  if(!active.length){ g.fillStyle = 'rgba(244,231,200,.45)'; g.fillText('none', rx, py); }
  for(const [n, c] of active.slice(0,6)){
    g.fillStyle = '#c8ffe0'; const words = n.split(' ');
    g.fillText(words[0], rx, py); if(words[1]){ g.fillText(words[1], rx, py+12); py+=12; }
    g.fillStyle = '#4fcf8e'; g.font = '800 12px "M PLUS Rounded 1c", sans-serif'; g.fillText('×'+c, rx, py+13); g.font = '700 10px "M PLUS Rounded 1c", sans-serif';
    py += 32;
  }
}

/* ================= input ================= */
function toBoard(e){ const r = cv.getBoundingClientRect(); return {x:(e.clientX - r.left)/r.width*CW - BX, y:(e.clientY - r.top)/r.height*CH - BY}; }
function aimAt(pt){ let a = Math.atan2(pt.y-LY, pt.x-LX); if(a < -Math.PI/2) a += Math.PI*2; G.aim = Math.max(A_MIN, Math.min(A_MAX, a)); }
let touchAiming = false;
cv.addEventListener('pointermove', e=>{ if(G.mode!=='play'||G.state!=='aim') return; if(e.pointerType==='mouse' || touchAiming) aimAt(toBoard(e)); });
cv.addEventListener('pointerdown', e=>{ unlockAudio(); if(G.mode!=='play') return;
  if(e.pointerType==='mouse'){ if(e.button===0){ aimAt(toBoard(e)); fire(); } else if(e.button===2){ fastForward = true; } }
  else { touchAiming = true; if(G.state==='aim') aimAt(toBoard(e)); else fastForward = true; cv.setPointerCapture?.(e.pointerId); } });
cv.addEventListener('pointerup', e=>{ if(e.pointerType==='mouse'){ if(e.button===2) fastForward=false; return; }
  fastForward = false;
  if(touchAiming && G.mode==='play' && G.state==='aim'){ const pt = toBoard(e); if(pt.y > LY+10) { aimAt(pt); fire(); } }
  touchAiming = false; });
cv.addEventListener('pointercancel', ()=>{ touchAiming=false; fastForward=false; });
cv.addEventListener('contextmenu', e=>e.preventDefault());

const keys = {};
window.addEventListener('keydown', e=>{
  unlockAudio();
  keys[e.key] = true;
  if(G.mode==='play'){
    if(e.key===' '||e.key==='Enter'){ e.preventDefault(); fire(); }
    if(e.key==='Escape'||e.key==='p'||e.key==='P'){ pauseGame(); }
    if(e.key==='f'||e.key==='F') fastForward = true;
    if(e.key.startsWith('Arrow')) e.preventDefault();
  } else if(e.key==='Escape'){ backAction(); }
});
window.addEventListener('keyup', e=>{ keys[e.key] = false; if(e.key==='f'||e.key==='F') fastForward=false; });
function keyboardAim(dt){
  if(G.mode!=='play'||G.state!=='aim') return;
  const fine = keys.Shift; const rate = fine ? .12 : .9;
  if(keys.ArrowLeft) G.aim = Math.min(A_MAX, G.aim + rate*dt);
  if(keys.ArrowRight) G.aim = Math.max(A_MIN, G.aim - rate*dt);
}

/* --- gamepad --- */
const padPrev = {};
let navRepeat = {dir:0, t:0};
function pollPad(dt){
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let p = null; for(const q of pads){ if(q && q.connected){ p = q; break; } }
  if(!p) return;
  const btn = i => !!(p.buttons[i] && (p.buttons[i].pressed || p.buttons[i].value > .5));
  const pressed = i => { const b = btn(i); const was = padPrev[i]; padPrev[i] = b; return b && !was; };
  const ax = p.axes[0]||0, ay = p.axes[1]||0, rx = p.axes[2]||0;
  const dz = v => Math.abs(v) < .14 ? 0 : v;
  if(G.mode==='play'){
    if(G.state==='aim'){
      const lx = dz(ax), r2 = dz(rx);
      // stick to the left rotates the barrel toward the left of the screen (angle grows)
      G.aim -= (Math.sign(lx)*Math.pow(Math.abs(lx), 2.2))*1.5*dt;
      G.aim -= r2*.18*dt;
      if(btn(14)) G.aim += .08*dt; if(btn(15)) G.aim -= .08*dt;
      if(pressed(4)) G.aim += .004; else if(btn(4)) G.aim += .05*dt;
      if(pressed(5)) G.aim -= .004; else if(btn(5)) G.aim -= .05*dt;
      G.aim = Math.max(A_MIN, Math.min(A_MAX, G.aim));
    } else { pressed(4); pressed(5); }
    if(pressed(0)){ unlockAudio(); fire(); }
    fastForward = btn(3) || keys.f || keys.F;
    if(pressed(9) || pressed(1)) pauseGame();
    pressed(12); pressed(13); pressed(8);
  } else {
    // menu navigation
    const up = btn(12) || ay < -.5, down = btn(13) || ay > .5, left = btn(14) || ax < -.5, right = btn(15) || ax > .5;
    const dir = up?1: down?2: left?3: right?4: 0;
    if(dir && dir!==navRepeat.dir){ navRepeat = {dir, t:.38}; navMove(dir); }
    else if(dir){ navRepeat.t -= dt; if(navRepeat.t<=0){ navRepeat.t = .11; navMove(dir); } }
    else navRepeat.dir = 0;
    if(pressed(0)){ unlockAudio(); navActivate(); }
    if(pressed(1)) backAction();
    if(pressed(9)){ if(G.mode==='paused') resumeGame(); }
    pressed(3); pressed(4); pressed(5); pressed(8);
  }
}
window.addEventListener('gamepadconnected', ()=>{ document.body.classList.add('pad'); });

/* --- DOM menu navigation (controller + keyboard) --- */
let navIndex = 0;
function navItems(){
  const ov = currentOverlay(); if(!ov) return [];
  return [...ov.querySelectorAll('.nav, .seg button, input.toggle, input[type=range], .pw, .lvl, select')].filter(el => el.offsetParent !== null && !el.disabled);
}
function navFocus(i){ const it = navItems(); if(!it.length) return; navIndex = (i + it.length) % it.length; const el = it[navIndex]; el.focus({preventScroll:false}); el.scrollIntoView({block:'nearest'}); }
function navMove(dir){
  const it = navItems(); if(!it.length) return;
  const cur = document.activeElement; let i = it.indexOf(cur);
  if(i<0){ navFocus(0); return; }
  if(dir===3||dir===4){
    const d = dir===4 ? 1 : -1;
    if(cur.type==='range'){ const st = +cur.step||1; cur.value = Math.max(+cur.min, Math.min(+cur.max, +cur.value + st*d)); cur.dispatchEvent(new Event('input',{bubbles:true})); return; }
    if(cur.closest('.seg')){ const bs = [...cur.closest('.seg').querySelectorAll('button')]; const j = bs.indexOf(cur)+d; if(bs[j]){ bs[j].click(); bs[j].focus(); } return; }
    if(cur.classList.contains('toggle')){ cur.click(); return; }
    // grids: move by one
    navFocus(i + d); return;
  }
  // up/down: for grid-like containers, jump to nearest element vertically
  const r0 = cur.getBoundingClientRect(); const cy0 = r0.top + r0.height/2, cx0 = r0.left + r0.width/2;
  let best = -1, bd = 1e9;
  it.forEach((el,k)=>{ if(el===cur) return; const r = el.getBoundingClientRect(); const cy = r.top + r.height/2, cx = r.left + r.width/2;
    const dy = cy - cy0; if(dir===2 && dy <= 4) return; if(dir===1 && dy >= -4) return;
    const score = Math.abs(dy) + Math.abs(cx - cx0)*.6; if(score < bd){ bd = score; best = k; } });
  if(best>=0) navFocus(best);
}
function navActivate(){ const el = document.activeElement; if(!el || el===document.body){ navFocus(0); return; } if(el.type==='range') return; el.click(); sfx('ui'); }

/* ================= overlays ================= */
const OV = ['title','levels','how','settings','pause','result'].reduce((o,id)=>(o[id]=document.getElementById(id),o),{});
let overlayStack = [];
function currentOverlay(){ for(const id of Object.keys(OV)) if(!OV[id].hidden && id===overlayStack[overlayStack.length-1]) return OV[id]; return null; }
function showOverlay(id, push){
  if(!push){ overlayStack = id ? [id] : []; } else overlayStack.push(id);
  for(const k of Object.keys(OV)) OV[k].hidden = !(k === overlayStack[overlayStack.length-1]);
  document.getElementById('corner').hidden = !(G.mode==='play' && !id);
  setTimeout(()=>{ const it = navItems(); if(it.length){ const pri = it.find(e=>e.classList.contains('primary')) || it[0]; pri.focus({preventScroll:true}); } }, 30);
}
function popOverlay(){ overlayStack.pop(); const top = overlayStack[overlayStack.length-1]; for(const k of Object.keys(OV)) OV[k].hidden = (k!==top); if(!top && G.mode==='paused'){ resumeGame(); } else setTimeout(()=>{ const it=navItems(); if(it[0]) it[0].focus({preventScroll:true}); },30); }
function backAction(){
  const top = overlayStack[overlayStack.length-1];
  if(!top) return;
  if(top==='pause'){ resumeGame(); return; }
  if(top==='title') return;
  if(top==='result'){ toTitle(); return; }
  popOverlay(); sfx('ui');
}
function pauseGame(){ if(G.mode!=='play') return; G.mode='paused'; sfx('setPaused', true); fastForward=false; showOverlay('pause'); }
function resumeGame(){ G.mode='play'; sfx('setPaused', false); showOverlay(null); lastFrame = performance.now(); }
function toTitle(){ G.mode='title'; sfx('stopFever'); music('stop'); sfx('setPaused', false); showOverlay('title'); }

document.getElementById('btnPlay').onclick = ()=>{ unlockAudio(); startLevel(progress.last||0); };
document.getElementById('btnLevels').onclick = ()=>{ buildLevelGrid(); showOverlay('levels', true); };
document.getElementById('btnSettings').onclick = ()=>{ buildSettings(); showOverlay('settings', true); };
document.getElementById('btnHow').onclick = ()=>{ showOverlay('how', true); };
document.getElementById('btnPause').onclick = pauseGame;
document.getElementById('btnResume').onclick = resumeGame;
document.getElementById('btnPauseSettings').onclick = ()=>{ buildSettings(); showOverlay('settings', true); };
document.getElementById('btnRestart').onclick = ()=>{ sfx('setPaused', false); sfx('stopFever'); startLevel(G.levelIndex); };
document.getElementById('btnQuit').onclick = toTitle;
document.getElementById('btnNext').onclick = ()=>{ startLevel(G.levelIndex+1); };
document.getElementById('btnRetry').onclick = ()=>{ startLevel(G.levelIndex); };
document.getElementById('btnResTitle').onclick = toTitle;
document.getElementById('btnClassic').onclick = ()=>{ const keep = {music:S.music, sfx:S.sfx}; S = Object.assign({}, JSON.parse(JSON.stringify(CLASSIC)), keep); save('ld.settings', S); buildSettings(); sfx('ui'); };
document.querySelectorAll('[data-back]').forEach(b=> b.onclick = ()=>{ save('ld.settings', S); popOverlay(); sfx('ui'); });

function buildLevelGrid(){
  const grid = document.getElementById('levelGrid'); grid.innerHTML = '';
  levels().forEach((lv, i)=>{
    const b = document.createElement('button'); b.type='button'; b.className = 'lvl' + (progress.cleared[i] ? ' done':'');
    const best = progress.best[i];
    b.innerHTML = `<span class="n">Level ${i+1}</span><b></b><span class="s">${best ? 'Best '+best.toLocaleString() : (progress.cleared[i]?'Cleared':'Not cleared yet')}</span>`;
    b.querySelector('b').textContent = lv.name;
    b.onclick = ()=>{ unlockAudio(); startLevel(i); };
    grid.appendChild(b);
  });
}

function showResult(won, bonus){
  G.mode = 'result';
  document.getElementById('resTitle').textContent = won ? 'River cleared' : 'Out of moonstones';
  document.getElementById('resScore').textContent = G.score.toLocaleString();
  const st = document.getElementById('resStats'); st.innerHTML = '';
  const rows = [['Level', `${G.levelIndex+1}. ${L.name}`], ['Shots fired', G.totalShots]];
  if(won && !S.infinite) rows.push(['Unused ball bonus', bonus.toLocaleString()]);
  if(!won) rows.push(['Amber still unlit', orangeLeft()]);
  const best = progress.best[G.levelIndex]; if(best) rows.push(['Best on this level', best.toLocaleString()]);
  for(const [a,b] of rows){ const dt = document.createElement('dt'); dt.textContent=a; const dd = document.createElement('dd'); dd.textContent=b; st.append(dt,dd); }
  document.getElementById('btnNext').hidden = !won;
  showOverlay('result');
  if(won) sfx('levelClear');
}

/* ================= settings UI ================= */
function buildSettings(){
  const body = document.getElementById('settingsBody'); body.innerHTML = '';
  const sec = (title)=>{ const d = document.createElement('div'); d.className='group'; const h = document.createElement('h3'); h.textContent = title; d.appendChild(h); body.appendChild(d); return d; };
  const row = (parent, label, help, control)=>{ const r = document.createElement('div'); r.className='row'; const l = document.createElement('div'); l.className='lbl'; l.innerHTML = `<span></span>${help?'<small></small>':''}`; l.firstChild.textContent = label; if(help) l.querySelector('small').textContent = help; r.append(l, control); parent.appendChild(r); return r; };
  const range = (key, min, max, step, fmt)=>{ const w = document.createElement('div'); w.className='range'; const i = document.createElement('input'); i.type='range'; i.id='s-'+key; i.min=min; i.max=max; i.step=step; i.value=S[key]; const o = document.createElement('output'); const f = fmt || (v=>v); o.textContent = f(+i.value); i.oninput = ()=>{ S[key] = +i.value; o.textContent = f(+i.value); save('ld.settings',S); applyLive(key); }; w.append(i,o); return w; };
  const toggle = (key)=>{ const i = document.createElement('input'); i.type='checkbox'; i.className='toggle'; i.id='s-'+key; i.checked = !!S[key]; i.setAttribute('role','switch'); i.onchange = ()=>{ S[key] = i.checked; save('ld.settings',S); sfx('ui'); }; return i; };
  const seg = (key, opts)=>{ const d = document.createElement('div'); d.className='seg'; d.setAttribute('role','radiogroup'); for(const [v,lab] of opts){ const b = document.createElement('button'); b.type='button'; b.setAttribute('role','radio'); b.id = 's-'+key+'-'+v; b.textContent = lab; b.setAttribute('aria-checked', String(S[key]===v)); b.onclick = ()=>{ S[key] = v; d.querySelectorAll('button').forEach(x=>x.setAttribute('aria-checked', String(x===b))); save('ld.settings',S); sfx('ui'); }; d.appendChild(b); } return d; };

  const g1 = sec('Moonstones');
  row(g1, 'Infinite balls', 'Never run out. Play until every amber lantern is lit.', toggle('infinite'));
  row(g1, 'Starting balls', 'Used when infinite balls is off.', range('balls', 3, 30, 1));
  row(g1, 'Free balls from big shots', 'One extra ball at 25,000, 75,000 and 125,000 points in a single shot.', toggle('scoreBalls'));

  const g2 = sec('Lanterns');
  row(g2, 'Amber targets', 'How many lanterns you must light. Classic is 25.', range('targets', 5, 50, 1));
  row(g2, 'Jade power lanterns', 'Each one triggers a power when lit. Classic is 2.', range('greens', 0, 20, 1));
  row(g2, 'Violet bonus lantern', 'One 500-point lantern that moves each turn.', toggle('purple'));

  const g3 = sec('Powers');
  const pp = document.createElement('p'); pp.textContent = 'Lighting a jade lantern picks one of the powers switched on below. Leave just one on to always get that power.'; g3.appendChild(pp);
  const grid = document.createElement('div'); grid.className = 'powers';
  for(const P of POWERS){
    const b = document.createElement('button'); b.type='button'; b.className='pw'; b.id='s-pw-'+P.id; b.setAttribute('role','checkbox');
    b.setAttribute('aria-checked', String(S.pool.includes(P.id)));
    b.innerHTML = '<i class="dot"></i><div><b></b><span></span></div>'; b.querySelector('b').textContent = P.name; b.querySelector('span').textContent = P.desc;
    b.onclick = ()=>{ const on = S.pool.includes(P.id); if(on) S.pool = S.pool.filter(x=>x!==P.id); else S.pool = S.pool.concat(P.id); b.setAttribute('aria-checked', String(!on)); save('ld.settings',S); sfx('ui'); };
    grid.appendChild(b);
  }
  g3.appendChild(grid);
  row(g3, 'Power strength', 'Multiplies charges, blast size, spark chain length and extra balls.', seg('strength', [[1,'×1'],[2,'×2'],[3,'×3']]));
  const startOpts = [['none','None']].concat(POWERS.filter(p=>p.kind==='charge').map(p=>[p.id, p.name]));
  row(g3, 'Start each level with', 'A free charge of this power at the first shot.', seg('startPower', startOpts));

  const g4 = sec('Assists');
  row(g4, 'Aim guide', 'Full shows every bounce, like Long Sight all the time.', seg('guide', [['short','Short'],['long','Long'],['full','Full']]));
  row(g4, 'Boat speed', null, seg('boatSpeed', [['still','Still'],['slow','Slow'],['normal','Normal'],['fast','Fast']]));
  row(g4, 'Boat size', null, seg('boatSize', [['normal','Normal'],['wide','Wide'],['huge','Huge']]));
  row(g4, 'Gravity', 'Lighter gravity means longer, bouncier shots.', seg('gravity', [['feather','Light'],['normal','Normal'],['heavy','Heavy']]));
  row(g4, 'Game speed', null, seg('speed', [[0.75,'Slow'],[1,'Normal'],[1.5,'Fast']]));

  const g5 = sec('Always-on powers');
  row(g5, 'Destiny on every shot', 'Every shot self-corrects to the best nearby angle.', toggle('cheatDestiny'));
  row(g5, 'Ember on every shot', 'The stone always burns through lanterns.', toggle('cheatFlame'));
  row(g5, 'Moon Bridge on every shot', 'The river bounces each shot back up once.', toggle('cheatBridge'));

  const g6 = sec('Sound');
  row(g6, 'Music', null, range('music', 0, 1, 0.05, v=>Math.round(v*100)));
  row(g6, 'Effects', null, range('sfx', 0, 1, 0.05, v=>Math.round(v*100)));
}
function applyLive(key){ if(key==='music') sfx('setMusicVolume', S.music); if(key==='sfx'){ sfx('setSfxVolume', S.sfx); sfx('ui'); } }

/* ================= audio unlock ================= */
let audioUnlocked = false;
function unlockAudio(){ if(audioUnlocked) return; audioUnlocked = true; sfx('unlock'); sfx('setMusicVolume', S.music); sfx('setSfxVolume', S.sfx); if(G.mode==='play') music('start', G.levelIndex); }
document.addEventListener('pointerdown', unlockAudio, {capture:true});
document.addEventListener('visibilitychange', ()=>{ if(document.hidden && G.mode==='play') pauseGame(); });

/* ================= loop ================= */
function frame(now){
  const dt = Math.min(.05, (now - lastFrame)/1000); lastFrame = now;
  try{ pollPad(dt); }catch(e){}
  keyboardAim(dt);
  update(dt);
  render(now);
  requestAnimationFrame(frame);
}

/* ================= boot ================= */
buildSprites(); buildBG(); initSkyLanterns(); resize();
showOverlay('title');
requestAnimationFrame(t=>{ lastFrame = t; frame(t); });
// testing hooks
window.__LD = { G, get L(){return L;}, S:()=>S, startLevel, fire, simulate, destinyAngle, update, setAim:a=>{G.aim=a;} };
})();
