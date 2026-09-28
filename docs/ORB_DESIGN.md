# Orb design v10

A connected three-dimensional particle body—not a wave generator. Stable geometry and sparse precomputed links keep motion predictable. A small turning idle pose is visually distinct from audio-led deformation. Low, mid and high bands from played PCM affect mass, torsion and node highlights. Fast attack and gentle release preserve phrase shape without interpreting phonemes, sentiment or understanding.

The Canvas2D renderer is dependency-free. A quiet inline SVG body is the first-paint/failure fallback. Neither renderer captures a microphone. Pausing, reduced motion, hidden-page suspension and high-density caps remain in the renderer lifecycle.

The controller labels silent previews, prevents preview/live overlap, distinguishes user input from actual playback and removes stale activity states. Pointer movement produces a small bounded orientation change; no camera is involved.


## v11 phrase articulation
The original sculpture is retained. A phrase envelope adds a small coherent lean and twist on actual output energy, bridges short syllabic gaps and releases to quiet between phrases. A speaking label or incoming text alone cannot produce speech motion. Synthetic previews are labelled and separate from a live session. This is an audio visualization, not emotion or sentience inference.

## v12 swarm (2026-09-26, Tony's direction)
The drawing is now a Canvas2D re-implementation of the particle-swarm model in Tony Walteur's JARVIS orb (`frontend/src/orb.ts`), used with the copyright holder's permission. It has free-floating particles with organic drift, proximity links recomputed every frame, state radius (idle wide, speaking/connecting tight), a decaying tumble on state change, depth breathing and slight camera drift. Differences from JARVIS: no Three.js (the HTML stays self-contained); no "thinking" state (electrons only mark real pending work such as connecting or preparing notes, or an explicit `pulse()`); bass push and mid pulse come only from the MotionRig envelope of **played** output; a soft inner cushion keeps long idles filled. Mantu violet by default; the "blue" palette uses the JARVIS colours. Pause, reduced motion, hidden-tab suspension, SVG fallback and quality downgrade are unchanged. Tests: `tests/swarm.test.js`.

## v12.1 life cues (2026-09-26)
Tony asked for the orb to "feel sentient". Each cue is tied to a slow rhythm or a real signal; the UI still makes no sentience claim and has no invented "thinking" state:
- **Breathing:** radius ±4% over a 5.6 s cycle; the luminous nucleus brightens in phase.
- **Glances:** small eye-like re-orientations every 2.4–6 s while nobody is speaking; suppressed while the consultant talks or ATLAS speaks.
- **Attention:** microphone level makes the cloud lean toward the viewer, gather in by up to 7% and fire neural flashes along existing links.
- **Voice:** played-output onsets give a small exhale; the high band fires link flashes; bass and mid are rescaled to the JARVIS analyser range.
- **Rendering:** depth-coloured particles with twinkle and near-particle halos, links graded by length and depth, a breathing nucleus.
- **Safety bounds:** soft outer wall (edge stays ≤ 1.1), clamped perspective. Measured about 60 fps and ~1 ms per frame at 2,000 particles in Chromium.


## Touch layer (2026-09-27)
- Always turning: per-state resting spin (`SWARM[state].rate`, rad/s: idle .18, listening .24, speaking .12, muted .07, connecting/processing .32, error .04) plus a slow JARVIS-like wobble; state changes still add the decaying tumble.
- Wander: the body drifts in slow, bounded loops (about 3.5% x 2.6% of the stage) and breathes in depth.
- Hover: particles near the pointer lean away (model-space repulsion, bounded).
- Click: a flinch - outward scatter, spin kick, a short spark flurry along existing links and a brighter core - then it re-forms. The click still reaches the orb button (start / mute); keyboard activation flinches too.
- Drag: the body turns with the hand (about half a turn per orb width), is pulled along (bounded), keeps the fling speed on release and coasts to a stop, then springs back to centre. A drag never triggers the orb button.
- Honesty rules unchanged: speech motion only from played PCM, no expanding wave or ring, reduced motion / pause disable the whole layer.
