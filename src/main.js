/* nap cat — a petting break.
 * Vanilla JS, fully client-side. Webcam frame-diff motion drives two hidden
 * meters (comfort, irritation). Comfort -> purr. Irritation overflow -> a soft,
 * telegraphed nibble -> warm end card -> (try to) close the tab.
 * See DESIGN.md.
 */
"use strict";

// ----------------------------------------------------------------------------
// Tunables — everything you'd want to dial for "feel" lives here.
// ----------------------------------------------------------------------------
const TUNE = {
  // motion sampling
  gridW: 16, gridH: 12,        // downscaled motion grid
  motionThresh: 18,            // per-pixel diff (0..255) that counts as motion
  motionGain: 2.4,            // how strongly motion moves meters

  // meter dynamics (per second)
  comfortDecay: 0.55,          // comfort bleeds away when not petted
  irritationTimePressure: 0.012, // irritation always creeps up with time
  irritationRelief: 0.10,      // calm good-petting sheds a little irritation
  overstimRate: 0.6,          // staying on one spot ramps irritation
  overstimDecay: 0.4,

  // purr
  purrBase: 0.10,              // always-on baseline purr (idle) — quiet, so the swell reads
  purrFloor: 0.07,             // (legacy; baseline above replaces it)

  // ending
  biteThreshMin: 0.78,         // hidden bite threshold randomized in this range
  biteThreshMax: 0.95,
  softCapSeconds: 210,         // timed capsule: gentle wind-down after this
  idleSleepSeconds: 90,        // no interaction this long -> drift to sleep
  closeDelayMs: 9000,          // linger on the end card (chance to "pet again") before closing the tab
};

// Cat regions as normalized ellipses (cx,cy,rx,ry in 0..1 over the cat-wrap box)
// with base (comfort, irritation) weights. Jittered per session below.
// Coordinates are normalized (0..1) over the cat video frame and tuned to THIS
// footage: cat lying on its side — face/cheek on the RIGHT, ears upper-right
// edge, fluffy chest/belly left-center (the trap), front paws center
// (real cats hate paw touches), flank along the far left.
const REGIONS = [
  { id: "cheek",   cx: 0.72, cy: 0.44, rx: 0.13, ry: 0.14, comfort: 1.0,  irrit: 0.05 },
  { id: "head",    cx: 0.82, cy: 0.24, rx: 0.13, ry: 0.13, comfort: 0.85, irrit: 0.12 },
  { id: "ears",    cx: 0.94, cy: 0.30, rx: 0.08, ry: 0.16, comfort: 0.55, irrit: 0.30 },
  { id: "shoulder",cx: 0.40, cy: 0.24, rx: 0.15, ry: 0.13, comfort: 0.7,  irrit: 0.18 },
  { id: "belly",   cx: 0.22, cy: 0.40, rx: 0.20, ry: 0.22, comfort: 0.95, irrit: 0.9  },
  { id: "paws",    cx: 0.48, cy: 0.52, rx: 0.16, ry: 0.16, comfort: 0.25, irrit: 0.85 },
  { id: "flank",   cx: 0.06, cy: 0.38, rx: 0.09, ry: 0.26, comfort: 0.6,  irrit: 0.22 },
];

// ----------------------------------------------------------------------------
// DOM
// ----------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const cam = $("cam"), scene = $("scene"), catEl = $("cat"), catWrap = $("catWrap");
const catInner = $("catInner"), catVid = $("catvid"), touchEl = $("touch");
const gate = $("gate"), endCard = $("end"), hud = $("hud"), hint = $("hint");

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------
const state = {
  running: false,
  comfort: 0,
  irritation: 0.05,
  biteThreshold: rand(TUNE.biteThreshMin, TUNE.biteThreshMax),
  lastRegion: null,
  overstim: 0,
  lastInteraction: performance.now(),
  startedAt: performance.now(),
  ended: false,
  lastMotionCell: { x: 0.5, y: 0.5 },
  lean: 0,       // 0..1 how much the cat is pressing into the petting
  leanX: 0,      // -1..1 horizontal lean toward the hand
  prevHand: { x: 0.5, y: 0.5 },
  handVel: { x: 0, y: 0 },   // smoothed hand motion vector = comb direction
  glow: { x: 0.5, y: 0.5, a: 0 },  // camera-mode "touch glow" position + opacity
};

// jitter region weights ±20% so the "map" isn't learnable across sessions
const regions = REGIONS.map((r) => ({
  ...r,
  comfort: clamp01(r.comfort * rand(0.8, 1.2)),
  irrit: clamp01(r.irrit * rand(0.8, 1.2)),
}));

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

// ----------------------------------------------------------------------------
// Motion: downscale the webcam to a tiny grid, diff against the previous frame.
// ----------------------------------------------------------------------------
const motion = {
  canvas: document.createElement("canvas"),
  ctx: null,
  prev: null,
  ready: false,
  // per-region accumulated motion this frame
  regionMotion: {},
};

// ----------------------------------------------------------------------------
// Fur-ruffle FX: a soft brush mark follows where you pet, then fades — so
// touching the cat visibly disturbs the fur. Canvas overlays the photo and
// uses soft-light blending so dabs ruffle the fur instead of painting over it.
// ----------------------------------------------------------------------------
const fx = { canvas: null, ctx: null, w: 0, h: 0 };
function initFx() {
  fx.canvas = document.getElementById("petfx");
  if (!fx.canvas) return;
  fx.ctx = fx.canvas.getContext("2d");
  resizeFx();
  window.addEventListener("resize", resizeFx);
}
function resizeFx() {
  if (!fx.canvas) return;
  const r = catWrap.getBoundingClientRect();
  fx.w = fx.canvas.width = Math.max(2, Math.round(r.width));
  fx.h = fx.canvas.height = Math.max(2, Math.round(r.height));
}
function fxDab(nx, ny, intensity) {
  if (!fx.ctx) return;
  const x = nx * fx.w, y = ny * fx.h;
  const rad = fx.w * 0.05 * (0.7 + intensity);
  const g = fx.ctx.createRadialGradient(x, y, 0, x, y, rad);
  g.addColorStop(0, `rgba(255,244,225,${0.12 + 0.22 * intensity})`);
  g.addColorStop(0.6, `rgba(120,80,50,${0.05 + 0.08 * intensity})`); // slight shadow edge
  g.addColorStop(1, "rgba(255,244,225,0)");
  fx.ctx.fillStyle = g;
  fx.ctx.beginPath(); fx.ctx.arc(x, y, rad, 0, Math.PI * 2); fx.ctx.fill();
}
function fxFade() {
  if (!fx.ctx) return;
  fx.ctx.globalCompositeOperation = "destination-out";
  fx.ctx.fillStyle = "rgba(0,0,0,0.08)";           // trail decay rate
  fx.ctx.fillRect(0, 0, fx.w, fx.h);
  fx.ctx.globalCompositeOperation = "source-over";
}

// ----------------------------------------------------------------------------
// Pettable fur (WebGL): the cat photo becomes a texture; your hand is "wind"
// that pushes a springy height field, and the render shader bends + lights the
// fur along that field — so petting locally deforms the fur and it springs
// back, like the water demo but for fur. Falls back silently if WebGL fails.
// ----------------------------------------------------------------------------
const fur = { ok: false, gl: null, hand: [0.5, 0.5], press: 0, sim: 0, SW: 220, SH: 140 };

const FUR_VERT = `attribute vec2 p; varying vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.0,1.0); }`;

// Directional COMB field (vec2 in RG): the hand's motion direction is the
// "wind" that combs fur; the field springs back toward the rest lay (0).
const FUR_SIM = `precision highp float; varying vec2 uv;
uniform sampler2D u_prev; uniform vec2 u_texel;
uniform vec2 u_hand; uniform vec2 u_vel; uniform float u_press; uniform float u_active; uniform float u_radius;
vec2 dec(vec2 e){ return e*2.0-1.0; } vec2 enc(vec2 v){ return v*0.5+0.5; }
void main(){
  vec2 c=dec(texture2D(u_prev,uv).rg);
  vec2 l=dec(texture2D(u_prev,uv-vec2(u_texel.x,0.0)).rg);
  vec2 r=dec(texture2D(u_prev,uv+vec2(u_texel.x,0.0)).rg);
  vec2 d=dec(texture2D(u_prev,uv-vec2(0.0,u_texel.y)).rg);
  vec2 u=dec(texture2D(u_prev,uv+vec2(0.0,u_texel.y)).rg);
  vec2 blur=(c*2.0+l+r+d+u)/6.0;
  vec2 v=mix(c,blur,0.20)*0.92;                    // diffuse + slow spring-back (flattened wake lingers)
  float fall=smoothstep(1.0,0.0,clamp(distance(uv,u_hand)/u_radius,0.0,1.0));
  v += u_vel * u_active * u_press * fall;          // comb along the stroke direction
  gl_FragColor=vec4(enc(clamp(v,-1.0,1.0)),0.0,1.0);
}`;

// Render: fur FLATTENS under the stroke. The comb vector both (a) compresses
// the texture along the lay (fur folds over) and (b) shades it like slicked
// fur — the pressed undercoat darkens, then a glossy highlight runs along the
// lay where it faces the light. That dark-base + one-sided gloss is what reads
// as "flattened" rather than a symmetric ripple.
const FUR_RENDER = `precision highp float; varying vec2 uv;
uniform sampler2D u_field; uniform sampler2D u_cat; uniform vec2 u_texel;
vec2 dec(vec2 e){ return e*2.0-1.0; }
void main(){
  vec2 bend=dec(texture2D(u_field,uv).rg);
  float mag=length(bend);
  vec2 dir=bend/(mag+1e-4);
  vec2 lay=vec2(dir.x,-dir.y);                     // comb dir in image space
  // compress the texture along the lay -> fur tips fold over and pack down
  // (kept gentle so detailed areas like the face don't visibly twist)
  vec2 catUv=vec2(uv.x,1.0-uv.y)+lay*mag*0.045;
  vec4 col=texture2D(u_cat,clamp(catUv,0.001,0.999));
  // pressed-flat shading carries most of the "petted" read now
  vec2 lightDir=normalize(vec2(-0.45,1.0));
  float gloss=max(dot(dir,lightDir),0.0);          // one-sided slick
  col.rgb -= mag*0.20*col.a;                        // matte undercoat (pressed down)
  col.rgb += gloss*mag*1.05*col.a;                  // glossy slick along the lay
  gl_FragColor=col;
}`;

function furCompile(gl, type, src) {
  const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function furProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, furCompile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, furCompile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
function furTarget(gl, w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb };
}

function initFur() {
  try {
    // prefer the live video (real breathing) as the texture; fall back to the still
    let src = null;
    if (catVid && catVid.readyState >= 2 && catVid.videoWidth) src = catVid;
    else if (catEl.complete && catEl.naturalWidth) src = catEl;
    if (!src) return false;                                  // no texture ready yet
    const canvas = document.getElementById("furgl");
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false, antialias: false });
    if (!gl) return false;

    // render canvas at the source's aspect ratio
    const sw = src.videoWidth || src.naturalWidth;
    const sh = src.videoHeight || src.naturalHeight;
    canvas.width = 1000; canvas.height = Math.round(1000 * sh / sw);
    canvas.style.aspectRatio = `${sw} / ${sh}`;

    const progSim = furProgram(gl, FUR_VERT, FUR_SIM);
    const progRender = furProgram(gl, FUR_VERT, FUR_RENDER);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);

    const A = furTarget(gl, fur.SW, fur.SH), B = furTarget(gl, fur.SW, fur.SH);
    // clear both comb fields to the rest lay (enc(0,0) = (0.5, 0.5))
    for (const t of [A, B]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.viewport(0, 0, fur.SW, fur.SH);
      gl.clearColor(0.5, 0.5, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // cat texture (re-uploaded from the video every frame in furFrame)
    const catTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, catTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    Object.assign(fur, { ok: true, gl, canvas, progSim, progRender, quad, A, B, catTex, sim: 0, srcEl: src });
    catInner.classList.add("gl");
    return true;
  } catch (e) {
    return false;   // any failure -> keep the video/img + soft-light fallback
  }
}

function furBind(gl, prog) {
  gl.useProgram(prog);
  const loc = gl.getAttribLocation(prog, "p");
  gl.bindBuffer(gl.ARRAY_BUFFER, fur.quad);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
}

// advance the sim one step and render. hand in image space (y down); vel is
// the hand's motion vector this frame (the comb/wind direction), image space.
function furFrame(handX, handY, press, velX, velY) {
  if (!fur.ok) return;
  const gl = fur.gl;
  const src = fur.sim === 0 ? fur.A : fur.B;
  const dst = fur.sim === 0 ? fur.B : fur.A;

  // --- sim step ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
  gl.viewport(0, 0, fur.SW, fur.SH);
  furBind(gl, fur.progSim);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
  gl.uniform1i(gl.getUniformLocation(fur.progSim, "u_prev"), 0);
  gl.uniform2f(gl.getUniformLocation(fur.progSim, "u_texel"), 1 / fur.SW, 1 / fur.SH);
  gl.uniform2f(gl.getUniformLocation(fur.progSim, "u_hand"), handX, 1 - handY);
  // flip vel.y to field space (y up) and amplify so a stroke combs visibly
  gl.uniform2f(gl.getUniformLocation(fur.progSim, "u_vel"), velX * 14, -velY * 14);
  gl.uniform1f(gl.getUniformLocation(fur.progSim, "u_press"), press);
  gl.uniform1f(gl.getUniformLocation(fur.progSim, "u_active"), press > 0 ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(fur.progSim, "u_radius"), 0.13);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // --- refresh the cat texture from the live video (real breathing) ---
  if (fur.srcEl === catVid && catVid.readyState >= 2) {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fur.catTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, catVid);
  }

  // --- render to screen ---
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, fur.canvas.width, fur.canvas.height);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  furBind(gl, fur.progRender);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dst.tex);
  gl.uniform1i(gl.getUniformLocation(fur.progRender, "u_field"), 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, fur.catTex);
  gl.uniform1i(gl.getUniformLocation(fur.progRender, "u_cat"), 1);
  gl.uniform2f(gl.getUniformLocation(fur.progRender, "u_texel"), 1 / fur.SW, 1 / fur.SH);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  fur.sim ^= 1;
}
motion.canvas.width = TUNE.gridW;
motion.canvas.height = TUNE.gridH;
motion.ctx = motion.canvas.getContext("2d", { willReadFrequently: true });

function sampleMotion() {
  if (!motion.ready || cam.readyState < 2) return 0;
  const { ctx, canvas } = motion;
  // mirror to match the on-screen mirrored preview
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(cam, -canvas.width, 0, canvas.width, canvas.height);
  ctx.restore();
  const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = frame.data;
  let total = 0;
  for (const r of regions) motion.regionMotion[r.id] = 0;

  if (motion.prev) {
    let hotX = 0, hotY = 0, hotW = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const d = Math.abs(px[i] - motion.prev[i]) +
                  Math.abs(px[i + 1] - motion.prev[i + 1]) +
                  Math.abs(px[i + 2] - motion.prev[i + 2]);
        const m = d / 3;
        if (m > TUNE.motionThresh) {
          const nx = (x + 0.5) / canvas.width;
          const ny = (y + 0.5) / canvas.height;
          total += m;
          hotX += nx * m; hotY += ny * m; hotW += m;
          // attribute to overlapping regions
          for (const r of regions) {
            const dx = (nx - r.cx) / r.rx, dy = (ny - r.cy) / r.ry;
            if (dx * dx + dy * dy <= 1) motion.regionMotion[r.id] += m;
          }
        }
      }
    }
    if (hotW > 0) state.lastMotionCell = { x: hotX / hotW, y: hotY / hotW };
  }
  motion.prev = px.slice(0);
  // normalize against grid size
  return total / (canvas.width * canvas.height * 255);
}

// ----------------------------------------------------------------------------
// Audio: synthesized purr (filtered noise, amplitude-modulated ~25 Hz) +
// a breath bed. One swap point to drop in a real sample loop later.
// ----------------------------------------------------------------------------
const audio = { ctx: null, master: null, purrGain: null, am: null, amGain: null };

function initAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  audio.ctx = ctx;

  // A real purr is a low glottal PULSE TRAIN (~25 Hz) with harmonics, not hiss.
  // Build it from two slightly-detuned sawtooths through a warm resonant
  // lowpass -> a chesty "rrrr" rumble. Add a little breath noise and the
  // ~25 Hz amplitude roll, plus a slow breathing swell so it feels alive.
  const osc1 = ctx.createOscillator(); osc1.type = "sawtooth"; osc1.frequency.value = 25;
  const osc2 = ctx.createOscillator(); osc2.type = "sawtooth"; osc2.frequency.value = 27.5;

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass"; lp.frequency.value = 420; lp.Q.value = 5;   // warm resonant peak

  // faint breath noise for texture
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.06;
  }
  const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
  const noiseLp = ctx.createBiquadFilter(); noiseLp.type = "lowpass"; noiseLp.frequency.value = 900;

  // the ~25 Hz amplitude roll (granular "rr-rr-rr")
  const amGain = ctx.createGain(); amGain.gain.value = 0.7;
  const am = ctx.createOscillator(); am.type = "sine"; am.frequency.value = 25;
  const amDepth = ctx.createGain(); amDepth.gain.value = 0.25;
  am.connect(amDepth).connect(amGain.gain);

  // slow breathing swell (~0.35 Hz)
  const breathGain = ctx.createGain(); breathGain.gain.value = 0.85;
  const breath = ctx.createOscillator(); breath.type = "sine"; breath.frequency.value = 0.35;
  const breathDepth = ctx.createGain(); breathDepth.gain.value = 0.12;
  breath.connect(breathDepth).connect(breathGain.gain);

  const purrGain = ctx.createGain(); purrGain.gain.value = 0.0;   // overall (comfort)
  const master = ctx.createGain(); master.gain.value = 0.9;

  osc1.connect(lp); osc2.connect(lp);
  lp.connect(amGain);
  noise.connect(noiseLp).connect(amGain);
  amGain.connect(breathGain).connect(purrGain).connect(master).connect(ctx.destination);
  osc1.start(); osc2.start(); am.start(); breath.start(); noise.start();

  audio.master = master; audio.purrGain = purrGain;
  audio.osc1 = osc1; audio.osc2 = osc2; audio.am = am; audio.amDepth = amDepth; audio.lp = lp;
  audio.mode = "synth";            // until the real recording loads in
  loadPurrSample();
}

// Prefer a real recorded purr (CC); fall back to the synth if it can't load.
async function loadPurrSample() {
  try {
    const res = await fetch("./assets/sounds/purr.ogg");
    const decoded = await audio.ctx.decodeAudioData(await res.arrayBuffer());
    const src = audio.ctx.createBufferSource();
    src.buffer = decoded; src.loop = true;
    const g = audio.ctx.createGain(); g.gain.value = 0;
    src.connect(g).connect(audio.master);
    src.start();
    audio.sampleSource = src; audio.sampleGain = g;
    audio.mode = "sample";
    audio.purrGain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.2); // mute synth
  } catch (e) {
    audio.mode = "synth";          // keep the synthesized purr
  }
}

// purr 0..1 -> overall level, roll depth, purr rate, and brightness.
// The loop never passes 0 during play (always a soft baseline); setPurr(0)
// only silences at the end.
function setPurr(level) {
  if (!audio.ctx) return;
  const t = audio.ctx.currentTime;
  // real-recording path: wide, low-floored swell so the volume change is
  // obvious — barely-there when idle, full and close when very comfortable.
  if (audio.mode === "sample" && audio.sampleGain) {
    const gain = 0.06 + 0.94 * Math.pow(level, 1.6);
    audio.sampleGain.gain.setTargetAtTime(gain, t, 0.12);
    audio.sampleSource.playbackRate.setTargetAtTime(0.9 + level * 0.3, t, 0.3);
    return;
  }
  // synth fallback
  audio.purrGain.gain.setTargetAtTime(level * 0.6, t, 0.15);       // capped, gentle
  audio.amDepth.gain.setTargetAtTime(0.15 + level * 0.35, t, 0.2); // deeper roll when content
  const rate = 23 + level * 6;                                     // 23..29 Hz
  audio.osc1.frequency.setTargetAtTime(rate, t, 0.3);
  audio.osc2.frequency.setTargetAtTime(rate * 1.1, t, 0.3);
  audio.am.frequency.setTargetAtTime(rate, t, 0.3);
  audio.lp.frequency.setTargetAtTime(360 + level * 320, t, 0.3);   // brighter when content
}

// a short, low, soft "mrrp" — never sharp or loud
function playMrrp(soft) {
  if (!audio.ctx) return;
  const ctx = audio.ctx, t = ctx.currentTime;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(soft ? 320 : 240, t);
  o.frequency.exponentialRampToValueAtTime(soft ? 380 : 160, t + 0.25);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(soft ? 0.12 : 0.22, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, t + (soft ? 0.3 : 0.45));
  o.connect(g).connect(audio.master);
  o.start(t); o.stop(t + 0.5);
}

// ----------------------------------------------------------------------------
// Main loop
// ----------------------------------------------------------------------------
let lastT = performance.now();
function loop(now) {
  if (!state.running) return;
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  const motionAmt = motion.touchMode ? sampleMotionTouch() : sampleMotion();

  // find the most-petted region this frame
  let topRegion = null, topM = 0;
  for (const r of regions) {
    const m = motion.regionMotion[r.id] || 0;
    if (m > topM) { topM = m; topRegion = r; }
  }
  const petting = motionAmt > 0.0008 && topRegion;
  if (petting) state.lastInteraction = now;

  // over-stimulation: same region held -> diminishing comfort, rising irritation
  if (petting && topRegion === state.lastRegion) {
    state.overstim = clamp01(state.overstim + TUNE.overstimRate * dt);
  } else {
    state.overstim = clamp01(state.overstim - TUNE.overstimDecay * dt);
  }
  state.lastRegion = topRegion;

  // ---- update hidden meters ----
  if (petting) {
    const intensity = Math.min(1, motionAmt * TUNE.motionGain);
    const goodPet = topRegion.comfort * intensity * (1 - state.overstim * 0.7);
    const badPet = (topRegion.irrit + state.overstim * 0.5) * intensity;
    state.comfort = clamp01(state.comfort + goodPet * dt * 2.2);
    state.irritation = clamp01(state.irritation + badPet * dt * 0.9
      - (topRegion.comfort > 0.6 ? TUNE.irritationRelief * intensity * dt : 0));
  }
  state.comfort = clamp01(state.comfort - TUNE.comfortDecay * state.comfort * dt);
  state.irritation = clamp01(state.irritation + TUNE.irritationTimePressure * dt);

  // ---- express: purr + visuals ----
  // always-on soft baseline purr (a half-asleep cat purrs even untouched),
  // swelling with comfort.
  const purr = clamp01(TUNE.purrBase + (1 - TUNE.purrBase) * state.comfort);
  setPurr(purr);
  catWrap.style.setProperty("--purr", purr.toFixed(3));
  catWrap.style.setProperty("--breath", (4.6 - purr * 1.4).toFixed(2) + "s");

  // ---- hand velocity = the comb/wind direction ----
  const hx = state.lastMotionCell.x, hy = state.lastMotionCell.y;
  state.handVel.x = lerp(state.handVel.x, hx - state.prevHand.x, 0.5);
  state.handVel.y = lerp(state.handVel.y, hy - state.prevHand.y, 0.5);
  state.prevHand.x = hx; state.prevHand.y = hy;

  // ---- the cat occasionally stirs in response to petting (non-deterministic) ----
  updateSleepAnim(now, petting, Math.hypot(state.handVel.x, state.handVel.y), state.comfort,
                  topRegion ? topRegion.id : null);

  // ---- camera-mode "touch glow": an abstract warm light that tracks the hand
  // so you can see where your motion maps onto the cat (no camera imagery). In
  // mouse mode the OS cursor already anchors, so it stays hidden.
  if (touchEl) {
    if (!motion.touchMode && !state.ended) {
      // anchor on ANY hand motion (not just over a pettable region), so you can
      // always see where your hand maps — even over the bed/edges.
      const moving = motionAmt > 0.0008;
      state.glow.x = lerp(state.glow.x, hx, 0.35);
      state.glow.y = lerp(state.glow.y, hy, 0.35);
      const targetA = moving ? Math.min(0.7, 0.32 + motionAmt * TUNE.motionGain * 5) : 0;
      state.glow.a = lerp(state.glow.a, targetA, 0.28);
      touchEl.style.left = (state.glow.x * 100).toFixed(1) + "%";
      touchEl.style.top = (state.glow.y * 100).toFixed(1) + "%";
      touchEl.style.opacity = state.glow.a.toFixed(3);
    } else if (state.glow.a !== 0) {
      state.glow.a = 0; touchEl.style.opacity = "0";
    }
  }

  // ---- petting feedback: directional fur comb (WebGL) or soft-light dab ----
  const press = petting ? Math.min(0.6, motionAmt * TUNE.motionGain * 0.6) : 0;
  if (fur.ok) {
    furFrame(hx, hy, press, state.handVel.x, state.handVel.y);   // every frame: renders + decays
  } else {
    fxFade();
    if (petting) fxDab(state.lastMotionCell.x, state.lastMotionCell.y, Math.min(1, motionAmt * TUNE.motionGain));
  }

  // ---- gentle lean (kept subtle so the LOCAL fur motion is the star) ----
  const leanTarget = petting ? Math.min(1, motionAmt * TUNE.motionGain + state.comfort * 0.5) : 0;
  const leanXTarget = petting ? (state.lastMotionCell.x - 0.5) * 2 : 0;
  state.lean = lerp(state.lean, leanTarget, petting ? 0.08 : 0.04);
  state.leanX = lerp(state.leanX, leanXTarget, 0.05);
  if (!state.ended) {
    catInner.style.setProperty("--leanScale", (1 + state.lean * 0.02).toFixed(4));
    catInner.style.setProperty("--leanX", (state.leanX * 5).toFixed(1) + "px");
  }

  // ---- end conditions ----
  const idle = (now - state.lastInteraction) / 1000;
  const elapsed = (now - state.startedAt) / 1000;
  if (!state.ended) {
    if (state.irritation >= state.biteThreshold) {
      endSession("nibble");
    } else if (elapsed > TUNE.softCapSeconds || (idle > TUNE.idleSleepSeconds && state.comfort < 0.1)) {
      endSession("sleep");
    }
  }

  if (!hud.hidden) updateHud(motionAmt, topRegion, purr);
  requestAnimationFrame(loop);
}

// ----------------------------------------------------------------------------
// The end — careful, telegraphed, never a jump scare.
// ----------------------------------------------------------------------------
function endSession(kind) {
  if (state.ended) return;
  state.ended = true;
  state.running = false;   // stop the loop so it can't re-assert purr/visuals

  // keep the WebGL canvas rendering the (wake) video through the end sequence;
  // the main loop is stopped, so without this the canvas freezes mid-sleep.
  (function renderTail() {
    if (!endCard.hidden || state.running) return;   // end card up, or restarted
    if (fur.ok) furFrame(0.5, 0.5, 0, 0, 0);
    requestAnimationFrame(renderTail);
  })();

  if (kind === "sleep") {
    // softest path: cat fully sleeps, purr fades, warm card.
    setPurr(0);
    fadeToEnd("see you next break", "the cat curled up and drifted off.", 2200);
    return;
  }

  // kind === "nibble": the REAL ending ceremony (reversed settle footage,
  // ~3.2s): asleep -> stirs/eyes open -> quick nip -> rolls onto its back and
  // licks its paw — the cat's own unbothered dismissal — then a warm fade.
  const hx = state.lastMotionCell.x, hy = state.lastMotionCell.y;
  catInner.style.setProperty("--lungeX", ((hx - 0.5) * 160).toFixed(0) + "px");
  catInner.style.setProperty("--lungeY", ((hy - 0.4) * 140).toFixed(0) + "px");

  setPurr(0);                                 // purr cuts — something changed
  playMrrp(true);                             // soft "mrrp?"
  if (catVid) {                               // 1) the cat actually stirs
    catVid.loop = false;
    catVid.src = "./assets/cat_wake.mp4?v=14";
    catVid.play().catch(() => {});            // plays through roll + groom
  }

  setTimeout(() => {                          // 2) the nip, just as it wakes
    catInner.classList.add("nibbling");
    playMrrp(false);                          // low, quiet chomp
    scene.classList.add("shake");
    setTimeout(() => scene.classList.remove("shake"), 340);
  }, 900);

  setTimeout(() => {                          // 3) clear the lunge; let the
    catInner.classList.remove("nibbling");    //    grooming play out untouched
  }, 1400);

  setTimeout(() => {                          // 4) warm fade as the clip ends
    fadeToEnd("ok, that's enough!",
      "the cat woke up, nipped your hand, and rolled over to groom. break's over.", 1400);
  }, 3000);
}

function fadeToEnd(title, msg, fadeMs) {
  state.running = false;
  hint.classList.add("gone");
  cam.classList.add("hidden");
  // ramp master volume down so audio never cuts off abruptly
  if (audio.ctx) audio.master.gain.setTargetAtTime(0.0001, audio.ctx.currentTime, fadeMs / 4000);
  scene.classList.add("dimming");

  setTimeout(() => {
    $("endTitle").textContent = title;
    $("endMsg").textContent = msg;
    endCard.hidden = false;
    stopCamera();
    // linger so "pet again" is reachable, then try to close (the capsule).
    // if they restart or the browser blocks close(), the card just stays.
    setTimeout(() => { if (!endCard.hidden) { try { window.close(); } catch (e) {} } }, TUNE.closeDelayMs);
  }, fadeMs);
}

// ----------------------------------------------------------------------------
// Camera lifecycle
// ----------------------------------------------------------------------------
let stream = null;
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("no-camera-api");
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } },
    audio: false,
  });
  cam.srcObject = stream;
  await cam.play();
  motion.ready = true;
}
function stopCamera() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  motion.ready = false;
}

// ----------------------------------------------------------------------------
// Touch fallback — pet with pointer/finger when there's no camera.
// Feeds the same regionMotion pipeline the camera path uses.
// ----------------------------------------------------------------------------
function enableTouchFallback() {
  let last = null;
  function move(e) {
    const r = catWrap.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    const nx = (p.clientX - r.left) / r.width;
    const ny = (p.clientY - r.top) / r.height;
    if (last) {
      // accumulate path length across all events within a frame (pointermove
      // fires many times per frame, each a tiny delta — summing is the point).
      motion.touchAmt = (motion.touchAmt || 0) + Math.hypot(nx - last.x, ny - last.y);
      motion.touchPos = { x: nx, y: ny };       // region = where the cursor is
      state.lastMotionCell = { x: clamp01(nx), y: clamp01(ny) };
    }
    last = { x: nx, y: ny };
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("touchmove", move, { passive: true });
}
// read-and-clear the frame's accumulated motion; assign it to whichever region
// the cursor sits over so the loop's argmax picks the right body part.
function sampleMotionTouch() {
  const a = motion.touchAmt || 0;
  motion.touchAmt = 0;
  for (const r of regions) motion.regionMotion[r.id] = 0;
  const p = motion.touchPos;
  if (p && a > 0) {
    for (const r of regions) {
      const dx = (p.x - r.cx) / r.rx, dy = (p.y - r.cy) / r.ry;
      if (dx * dx + dy * dy <= 1) motion.regionMotion[r.id] = a;
    }
  }
  return a;
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
// reset the per-session meters (used by both first start and "pet again")
function resetSession() {
  state.comfort = 0;
  state.irritation = 0.05;
  state.biteThreshold = rand(TUNE.biteThreshMin, TUNE.biteThreshMax);
  state.lastRegion = null;
  state.overstim = 0;
  state.ended = false;
  state.startedAt = state.lastInteraction = lastT = performance.now();
  motion.prev = null;
}

// start (or restart) the real-footage sleep loop and init the fur over it
// The sleep clip is NOT left looping. The cat holds a still (deeply-asleep)
// frame and only "breathes"/shifts on occasional stirs — mostly triggered by
// your petting, with random timing & speed, plus a rare spontaneous stir.
const sleepAnim = { stirring: false, cooldownUntil: 0, stopAt: 1e9 };

function startSleepVideo() {
  if (!catVid) return;
  catVid.loop = false;
  if (!catVid.src.includes("cat_sleep")) catVid.src = "./assets/cat_sleep.mp4?v=14";
  sleepAnim.stirring = true;               // first play primes the texture
  sleepAnim.cooldownUntil = performance.now() + 1500;
  const onPlaying = () => {
    catInner.classList.add("video");       // hide the still image
    if (!fur.ok || fur.srcEl !== catVid) { fur.ok = false; initFur(); }
  };
  catVid.addEventListener("playing", onPlaying, { once: true });
  catVid.currentTime = 0;
  catVid.play().catch(() => {});           // if video can't play, the img stays
}

function triggerStir(now, rate) {
  if (!catVid || sleepAnim.stirring) return;
  catVid.playbackRate = Math.max(0.4, Math.min(1.8, rate));
  try { catVid.currentTime = 0; } catch (e) {}
  catVid.play().catch(() => {});
  sleepAnim.stirring = true;
  // irregular stir LENGTH: sometimes a full shift, sometimes a half-breath
  const dur = isFinite(catVid.duration) ? catVid.duration : 0.8;
  sleepAnim.stopAt = dur * rand(0.35, 1.0);
  sleepAnim.cooldownUntil = now + rand(2500, 8000);   // long, unpredictable stillness
}

function updateSleepAnim(now, petting, speed, comfort, regionId) {
  if (!catVid || fur.srcEl !== catVid || state.ended) return;
  // a stir finished (reached its random stop point or clip end) -> hold still
  if (sleepAnim.stirring && (catVid.ended || catVid.currentTime >= sleepAnim.stopAt)) {
    catVid.pause();
    sleepAnim.stirring = false;
  }
  if (sleepAnim.stirring || now < sleepAnim.cooldownUntil) return;
  // chance to stir THIS frame: mostly from petting (scaled by motion + comfort),
  // rare spontaneous shift otherwise. Kept low so stretches of stillness are long.
  let chance = 0.0003;
  if (petting) {
    chance += 0.0015 + speed * 0.5 + comfort * 0.003;
    // touching the paws makes a cat twitch/shift far more readily
    if (regionId === "paws") chance += 0.012;
  }
  if (Math.random() < chance) {
    triggerStir(now, 0.5 + speed * 9 + Math.random() * 0.6);  // brisker pet -> quicker shift
  }
}

function begin(useCamera) {
  initAudio();
  initFx();
  startSleepVideo();         // real breathing; WebGL fur inits once frames flow
  initFur();                 // (no-op now if video isn't ready; img fallback)
  if (audio.ctx.state === "suspended") audio.ctx.resume();
  resetSession();
  state.running = true;
  gate.classList.add("gone");
  setTimeout(() => { gate.style.display = "none"; }, 800);
  setTimeout(() => hint.classList.add("gone"), 6000);
  requestAnimationFrame(loop);
}

function startTouchMode() {
  motion.touchMode = true;
  enableTouchFallback();
  cam.classList.add("hidden");
  hint.textContent = "move your cursor slowly over the cat, like you're petting";
  begin(false);
}

$("startBtn").addEventListener("click", async () => {
  try {
    await startCamera();
    $("gateNote").textContent = "";
    hint.textContent = "the warm glow follows your hand — pet the cat";
    begin(true);
  } catch (err) {
    // no camera or permission denied -> seamlessly fall back to touch/mouse,
    // never dead-end on the welcome screen.
    $("gateNote").textContent = "No camera — petting with your mouse instead.";
    startTouchMode();
  }
});

$("touchBtn").addEventListener("click", startTouchMode);

// "pet again": restart in place so the cat is right there, no welcome gate.
$("againBtn").addEventListener("click", async () => {
  endCard.hidden = true;
  scene.classList.remove("dimming", "shake");
  catInner.classList.remove("alert", "nibbling", "bolt");
  catInner.style.removeProperty("--leanScale");
  catInner.style.removeProperty("--leanX");
  state.lean = 0; state.leanX = 0;
  startSleepVideo();             // back to the real sleep loop
  hint.classList.remove("gone");
  if (audio.ctx) {
    if (audio.ctx.state === "suspended") audio.ctx.resume();
    audio.master.gain.setTargetAtTime(0.9, audio.ctx.currentTime, 0.2);
  }
  if (!motion.touchMode) {
    cam.classList.remove("hidden");
    try { await startCamera(); } catch (e) { /* keep going; touch still works */ }
  }
  resetSession();
  state.running = true;
  setTimeout(() => hint.classList.add("gone"), 6000);
  requestAnimationFrame(loop);
});

// debug HUD toggle
window.addEventListener("keydown", (e) => {
  if (e.key === "d") hud.hidden = !hud.hidden;
});
function updateHud(m, r, purr) {
  hud.textContent =
    `motion ${(m * 1000).toFixed(1)}\n` +
    `region ${r ? r.id : "-"}\n` +
    `comfort ${state.comfort.toFixed(2)}  purr ${purr.toFixed(2)}\n` +
    `irritat ${state.irritation.toFixed(2)} / thr ${state.biteThreshold.toFixed(2)}\n` +
    `overstim ${state.overstim.toFixed(2)}`;
}

// graceful: stop tracks if the user navigates away
window.addEventListener("pagehide", stopCamera);

// bookmark hint uses the platform's real shortcut (Cmd on Mac, Ctrl elsewhere)
(() => {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const k = $("bmKey");
  if (k && isMac) k.textContent = "⌘";
})();
