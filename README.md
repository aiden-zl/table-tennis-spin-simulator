<img src="public/icon.svg" width="64" height="64" alt="">

# Spin Lab — table tennis spin trainer

A browser trainer for **reading spin** and **learning receive angles**. An opponent strikes
the ball; you watch their swing and the ball's spin (arrows, rotation ring and "wind"
streaks), then set your paddle angle and stroke from your end of the table. After every ball,
a coach shows the angle window that would have worked, a ghost of the ideal paddle, the ideal
return path, and tips.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts:

| command | what it does |
| --- | --- |
| `npm test` | physics, solver, coach, engine and UI-logic tests (vitest) |
| `npm run typecheck` | strict TypeScript check |
| `npm run build` | type-check + production build into `dist/` |
| `npm run preview` | serve the production build |
| `node scripts/smoke.mjs <url> <outDir>` | headless-Chrome smoke test with screenshots (needs Chrome installed) |

Desktop browser with WebGL required.

## Modes

- **Custom.** Pick a preset (heavy backspin short serve, pendulum, tomahawk, loop, chop…) or
  shape your own shot: topspin/backspin, sidespin and corkscrew (rps), pace, landing spot and
  where the opponent hits from. A dotted line previews the incoming path. If a combination
  can't land, the solver nudges pace or placement and tells you what it changed.
- **Bot.** Random realistic shots, with the spin hidden. You have to read it from the swing
  and the ball. The *Assist level* setting chooses how much spin visualisation you get:
  arrows plus wind, wind only, or just the spinning ball and its logo. The spin is revealed
  once you've hit.
- **Real-time / Freeze-frame.** In freeze-frame the ball pauses just before contact so you can
  set your angle calmly, then press Space to hit.

## Controls

| input | action |
| --- | --- |
| mouse up / down | close / open the face (pitch) |
| mouse left / right | aim left / right (yaw; 0° = the middle of the opponent's half) |
| W / S, wheel | close / open in small steps (Shift = fine) |
| A / D | aim left / right in small steps |
| 1 · 2 · 3 · 4 | stroke: Block · Push · Drive/Loop · Chop |
| Q / E | swing strength − / + |
| Space / Enter | next ball (in freeze-frame: hit) |
| R | repeat the same ball |
| T | slow motion (cycles speed) |
| C | camera: player / side / opponent view |
| V | spin cam on/off |
| P / Esc | pause |
| H / ? | help |

Aim is measured from the table, not the room: 0° always points the face (and the swing) from
wherever you take the ball at the middle of the opponent's half, the way a player squares up.
The rest — the ball's own sideways travel and its sidespin — is what you have to read.

The settings panel (⚙) also has assist level, speed, camera, auto-next, the ideal-return ghost,
the spin cam, sound and a stats reset. Turning off *Auto-position paddle* gives manual
positioning: the mouse moves the paddle and W/S/A/D/wheel set the angle.

## The physics

Everything you see comes from one deterministic simulation (1 ms fixed steps):

- **Flight:** gravity, quadratic drag (C_d 0.5) and Magnus lift from the spin perpendicular to
  the velocity, plus slow spin decay.
- **Every contact** (table, net, paddles, floor) uses the same rigid-body impulse model: normal
  restitution, Coulomb friction with stick/slip, and a thin-shell ball (I = ⅔mR²). Tests check
  that no contact ever creates energy and that angular momentum about the contact point is
  conserved. The table restitution passes the ITTF drop test (30.5 cm → ~24 cm).
- The **opponent's swing** is solved from the launched spin, so the face angle and brushing
  direction you see really do produce that spin.
- The **coach** finds its window by running the same physics over a grid of paddle angles, so
  its advice matches what the game will actually do. The "spin at your bat" it reports is the
  spin after flight and the bounce, which is usually less than what left the opponent's bat.

Coordinates and sign conventions are documented at the top of `src/physics/constants.ts`.
