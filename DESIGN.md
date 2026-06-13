# Cat Anti-Flow — Design Draft

A half-asleep, purring cat you pet by waving your hand in front of the webcam.
A relaxation / meditation micro-break with a soft, self-limiting end so you
return to work. Inspired by **ranli.me/touch-the-water** — fully static,
client-side, backend-free.

---

## 1. Experience in one paragraph

A curled-up cat breathes and dozes on screen. You wave your hand in front of the
camera as if petting it. Where you pet silently moves two hidden meters —
**comfort** and **irritation**. The more comfortable the cat, the stronger it
purrs (you only ever perceive comfort *through the purr*). Irritation is
invisible and creeps up with time; certain spots (belly, paws, tail) raise it
fast even while they also feel good. If irritation crosses a hidden threshold the
cat gives a short telegraphed warning, then a *playful* nibble at your hand — the
scene gently fades and the tab closes. The session is a **timed capsule**: even a
perfect session winds down on its own, easing you back to your routine.

---

## 2. Tech stack (mirrors the reference, backend-lite → backend-zero)

- **Vanilla JS, single page, static files.** No framework, no build step.
- **Webcam** via `getUserMedia` (works on `localhost` without HTTPS).
- **Petting detection = frame-difference motion** on a downscaled video, summed
  per region cell. Lighter and gentler than MediaPipe (no 10 MB model, no model
  load latency), and it directly answers the only question we care about: *how
  much motion, over which part of the cat.* MediaPipe fingertip tracking is left
  as an optional future upgrade.
- **Cat visuals = SVG + CSS transforms** (breathing, ear/tail twitch, purr
  vibration). Asset-free so it runs immediately; a real cat photo/video can be
  dropped in later behind the same region map.
- **Purr = synthesized with Web Audio** (filtered noise amplitude-modulated at
  ~25 Hz, depth & gain scaled by comfort). Zero audio assets; a real purr sample
  loop can replace it via one swap point.
- **Backend = none.** No analytics ping. Serve with `python3 -m http.server`.
- **Touch fallback** (like the reference) when no camera is available.

---

## 3. Hidden model (invisible to the user)

Two meters in `[0,1]`, updated each frame (`dt` seconds):

```
comfort      += goodPet  - comfortDecay*comfort
irritation   += badPet   + timePressure*dt  - irritationRelief*calmPet
```

- **They are loosely inverse-correlated but independent** — a spot can raise
  both (the belly: feels great *and* winds the cat up).
- **comfort** decays toward 0 when you stop petting, so the purr fades naturally.
- **irritation** always drifts up with time (`timePressure`) and never fully
  releases — this is what makes the capsule self-limiting.
- **Over-stimulation:** petting the *same* region too long yields diminishing
  comfort and rising irritation.

### Region → (comfort, irritation) weights

Regions are normalized ellipses over the cat. Per-session the weights are
jittered ±20% so the "map" isn't learnable.

| Region | comfort | irritation | note |
|---|---|---|---|
| Cheeks / chin | high | very low | the safe sweet spot |
| Forehead / between ears | high | low | |
| Back / shoulders | medium | low–med | |
| Base of tail | medium-high | medium | feels good, risky |
| **Belly** | **high** | **high** | the classic trap |
| Paws / tail tip | low | high | do not touch |

### Purr strength

`purr = f(comfort)`: below a floor the cat only breathes; above it, gain, AM
depth, and a second harmonic rise smoothly with comfort. Comfort is *only* ever
expressed through the purr — never a number or bar.

---

## 4. The end — careful UX (NOT a jump scare)

The reference site's whole register is **calm**; the bite must stay inside that
register. Two ways a session ends, both gentle:

**A. The nibble (irritation overflow).** Hidden threshold randomized per session.
On crossing:
1. **Telegraph (~400 ms):** ears flick, eyes crack open, purr stutters and
   stops, a tiny "mrrp?". This reads as *the cat reacting*, giving the body a
   half-second to expect it — the opposite of a jump scare.
2. **Nibble (~300 ms):** a soft, slow lunge toward your hand region with a
   *quiet, low* chomp/"mrrp!" — never a loud or sharp sound, never a scary face.
3. **Fade (~1.5–2 s):** scene eases to a warm end card. No black flash, no
   silence cliff — the purr's reverb tail lingers.

**B. Natural wind-down (timed capsule).** If you stop interacting, or after a
soft time cap (~3–4 min), the cat simply falls fully asleep and the same warm end
card appears. Nobody is forced to trigger a bite.

Design guards: max audio level capped; no frequency content above a soft ceiling;
telegraph is mandatory before any bite; fade is never instant.

---

## 5. Closing the tab + easy reopen (the hooks)

- The end card shows **"🐾 see you next break"** with a big **Pet again** button
  (restarts in place) before anything closes.
- We then attempt `window.close()`. Browsers only honor it for
  script-opened tabs, so **if it's blocked the calm end card simply stays** —
  the user is never stuck on a blank/broken page.
- **Reopen hooks (make returning one click):**
  - **PWA manifest** → installable as an app icon ("Add to Home Screen"),
    so reopening is a single tap and `window.close()` reliably works.
  - A clear **bookmark / "open again anytime"** hint on the end card.
  - A documented shell alias / `.desktop` launcher for local use.

---

## 6. File layout

```
cat_anti_flow/
  index.html        # shell, canvas, overlays, end card
  styles.css        # calm palette, animations, end card
  manifest.webmanifest
  src/main.js       # camera + frame-diff motion, meters, purr synth, end seq
  DESIGN.md
  serve.sh          # python3 -m http.server 8000
```

## 7. Tunables (top of main.js)

Threshold range, time-pressure, decay rates, region weights, purr floor, soft
time cap, telegraph/fade durations — all constants so feel is easy to dial in.
