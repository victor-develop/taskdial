# taskdial

**English** · [中文](README.zh-CN.md)

A task rotator built on fixed time slices. One circle, N wedges, each wedge a task you're actively pushing on. When the slice runs out the dial turns to the next wedge and waits — nothing is counted until you confirm.

- The current task name sits at the very top, with a colour-coded wedge number and total time on it
- A pixel critter runs left to right along the bottom, tracking progress through the current slice, then sits down when the slice ends — and spins its goal object at the finish line, faster as the slice runs out. 111 runner/goal pairs in the pool, one picked at random each fresh round (pause/resume keeps the same one)
- Every task carries **its own slice length** — 5 minutes for inbox triage, 50 for deep work

## Install

Grab the latest `.app` from [Releases](https://github.com/victor-develop/taskdial/releases). Apple Silicon only — Intel Macs need to build from source.

The app is **not signed or notarised**, so Gatekeeper will block it the first time. Right-click the icon → Open → Open again. Or:

```bash
xattr -dr com.apple.quarantine /Applications/taskdial.app
```

## Run from source

### Desktop app (Tauri, recommended)

```bash
npm run tauri dev
```

Package it:

```bash
npm run tauri build
```

Output lands in `src-tauri/target/release/bundle/`. The window is borderless, always on top and not resizable — drag it by the status strip along the top.

### Browser + PiP (fallback if you don't want to install anything)

```bash
npm run dev
```

Open http://localhost:5183 and hit **⧉** in the top right to move the dial into a Document Picture-in-Picture window, which floats above other windows at the OS level. Chromium only — in Safari and Firefox the ⧉ button doesn't appear and the page works normally otherwise.

## Local HTTP API

The app runs a small server on `127.0.0.1:7717` so an agent can read state and edit slices.

```
GET    /                      landing page
GET    /insights              pause report — HTML, or ?format=md for markdown, ?format=json for the raw aggregate
GET    /health                {ok, version, phase, uptime, window}
GET    /skills                capability manifest (JSON, ?format=md for markdown)
GET    /control/state         full current state
POST   /control/slices        add a slice        {name, lenMin}
PATCH  /control/slices/:id    rename / change length
DELETE /control/slices/:id    remove a slice
POST   /control/pause         {reason?}
POST   /control/resume
```

**There is one state machine.** Writes are not reimplemented in Rust — they're forwarded to the window as an intent and run through the same `model.reducer`, so the limits match the app exactly (a 9th slice gets 422, `lenMin: 9999` clamps to 180). The cost is that writes need the window alive; otherwise 503. Read endpoints work regardless.

`?format=md` on `/insights` exists for feeding the report to an AI: pre-aggregated, non-zero hour buckets only, no JSON noise. The aggregation lives in `src-tauri/src/insights.rs` and is the single source for all three formats — the page used to compute it again in the browser, which is exactly how two views of the same report drift apart.

### Security

Loopback only by default. The `Host` header is checked to block DNS rebinding (any web page can point a domain at 127.0.0.1 and hit the write endpoints), writes carrying an `Origin` are rejected outright, and no CORS headers are ever sent. A taken port is a hard error, not a silent move to the next one — a moved port means the agent talks to nothing.

Config lives in `server.json` in the app config directory:

```json
{ "enabled": true, "bind": "127.0.0.1", "port": 7717 }
```

Opening `bind` up works, and there is no token — so **anyone on the network could change your state, not just read it**. That's why the default stays loopback and opening up has to be your explicit edit.

## Storage

State lives in the webview's localStorage. Under Tauri it's keyed by the app identifier, so it has nothing to do with ports and survives any restart. In browser mode it's independent of the dev server process — kill it, reopen, the data is still there.

In browser mode the port is pinned to 5183 with `strictPort` in `vite.config.ts`. **Don't change it**: localStorage is bucketed by origin, so a different port is a different, empty bucket and looks exactly like data loss. With `strictPort`, Vite fails loudly when the port is taken instead of silently moving to the next one. (Tauri doesn't have this problem — the frontend is served over an internal protocol, no port involved.)

There's exactly one way to lose time: a slice that was running but never confirmed, picked up more than two slice-lengths later. That round is discarded rather than credited.

Settings has **Export / Import** — the save file is plain JSON. Use it when moving between origins, machines, or after clearing browser data. Import always lands in the idle state; it will not resume a half-finished round from somewhere else.

<details>
<summary>Tried numa, shelved it (notes for later)</summary>

[numa](https://github.com/razvandimescu/numa) hands out `.numa` domains, which takes the port out of the origin entirely. But on this machine **Cloudflare WARP** holds `127.0.2.2:53` and `127.0.2.3:53`, and numa binds `0.0.0.0:53` by default. On macOS a wildcard bind conflicts with an existing specific-address bind, so the service never starts.

To actually wire it up (all of this needs sudo): put `[server] bind_addr = "127.0.0.1:53"` in `~/.config/numa/numa.toml`, run `sudo numa install --no-system-dns` (**not** the bare version — that takes system DNS away from WARP), then write `/etc/resolver/numa` so only `*.numa` resolves through 127.0.0.1. Vite also needs `dial.numa` in `server.allowedHosts`.

Why it's shelved: `strictPort` already solves the bucket problem, and once you're on Tauri there is no origin to begin with.

</details>

## Decisions that are settled

| Decision | How | Why |
|---|---|---|
| Confirmation doesn't auto-start | On timeout it parks in `awaiting` and waits indefinitely | The number on the timer equals real effort, with no waiting time mixed in |
| Fixed order | Rotates 1→2→3→4 | Forces balance; stops you parking in the comfortable task |
| Pinning is explicit | Double-click the dial, or hit 🔒 in the confirm bar | Going all-in on one task is a decision, not a default |
| Manual end-of-day | Settings → wrap up; no calendar-day rollover | Working until 2am shouldn't be filed as the next day |
| Time from timestamps | Always `Date.now()` deltas, never accumulated `setInterval` ticks | Background tabs get throttled and an accumulator runs slow |
| Wedge angles stay equal | A 50-minute task gets exactly the same wedge as a 5-minute one | Slice length is "how much per sitting", rings are "how much in total". Collapsing both onto one geometry makes rings incomparable — the short-slice task would look starved no matter how much time went in |

Per-task slice length is set in Settings; tap the `5m` chip on a row. The **default** there only seeds newly added tasks — there is no live inheritance, every task carries an explicit number. Whatever is coming next is shown on the confirm bar before you commit to it, because with a fixed rotation the next slice may well be a different length than the one you just finished.

## Tree rings

Rings grow **continuously** — the arc starts moving the moment the timer does, rather than jumping one notch per round. Confirming produces no visible jump, because the in-flight round is already counted into the current wedge in real time.

- **Always growing** → the current ring's arc keeps advancing
- **Every hour** → a full ring closes, with a three-note chime
- **Every 8 hours** (8 rings) → a notch on the outer edge, the ring palette darkens, and growth restarts from the inside

Three laps — 24 hours — to fill a wedge. Feeding one task all day still won't max it out, so there's something left to look at in the evening.

Rings are measured in **actual time invested**, decoupled from slice length: switch to 25-minute slices and a ring still takes an hour.

## Code

- `src/model.ts` — state machine, ring maths, localStorage
- `src/Dial.tsx` — SVG dial, annular sector paths, rotation
- `src/App.tsx` — timer loop, confirm bar, settings, end-of-day summary
- `src/Runner.tsx` — renders whichever critter/goal pair is picked; sprites are string matrices compressed into SVG paths
- `src/zoo/` — the sprite pool, **one file per animal** (`src/zoo/pets-dachshund-sausage.ts`, etc.) plus `index.ts` (barrel + `pickZooSprite`) and `types.ts`. Generated by `pixel-zoo/gen_zoo_ts.py` from `pixel-zoo/sprites.json` — if you're hand-editing one animal, edit its file directly; if you're regenerating the whole batch, edit the generator and rerun it, don't hand-edit all 111
- `src/autosize.ts` — resizes the Tauri window to match content height
- `src/pip.ts` — Document PiP; moves `#root` wholesale into the floating window without remounting
- `src-tauri/` — desktop shell, window config in `tauri.conf.json`

Three things worth knowing before touching this:

**PiP must move the React root container itself.** React attaches its event delegation to the root container, so moving some child into another document leaves every button dead — events in the PiP window never bubble to the container. That's why `index.html` wraps `#root` in a `#home` element to move it back to.

**Pixel art can't be rotated with a transform.** It comes out as blurred jaggies. Every goal object is drawn frame by frame instead: 0° and 45° by hand, the other two transposed from those (`rot90` in `Runner.tsx`). Shapes that are 180°-symmetric (or close enough) read fine across all four frames; anything elongated or single-direction collapses into an unreadable diagonal streak at 45° — known issue, see below.

**A new critter is picked on a genuine fresh start, not on resume.** `Runner` watches the phase transition: `idle`/`awaiting` → `running` picks a new one, but `paused` → `running` keeps the current one — swapping the animal out from under a resumed round would be jarring. This lives entirely inside `Runner.tsx`; no state was added to `model.ts` for it, since which critter is showing is not something worth persisting or testing.

## Next

- Move storage from localStorage to a JSON file (backup-able, git-able)
- Launch at login, menu bar icon
- Make the end-of-day summary something worth looking at
- Redraw the ~30 zoo entries flagged by `pixel-zoo/quality_check.py` — goal objects whose bounding-box fill density collapses at 45° (an elongated shape read as a diagonal streak instead of the intended object). Shipped anyway; not broken, just some are less legible than others. `pixel-zoo/preview.html` (open with the "只看有疑虑的" filter) shows exactly which
