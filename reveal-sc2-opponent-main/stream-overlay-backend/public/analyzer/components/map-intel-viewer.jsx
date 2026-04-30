/**
 * Map Intel — MapIntelViewer (canvas replay overlay).
 * Extracted from index.html. IIFE wrapper isolates scope and attaches
 * MapIntelViewer to window so the inline block resolves it at render time.
 * DO NOT keep both this file AND the original section in index.html.
 */
(function () {
  "use strict";
  const React = window.React;
  const { useState, useEffect, useMemo, useCallback, useRef, Fragment } = React;


      function MapIntelViewer({ replayPath, playerName, onBack }) {
        const [data, setData] = useState(null);
        const [err, setErr] = useState(null);
        const [loading, setLoading] = useState(true);

        const [time, setTime] = useState(0);
        const [playing, setPlaying] = useState(false);
        const [speed, setSpeed] = useState(1.0);

        const canvasRef = React.useRef(null);
        const containerRef = React.useRef(null);
        const animRef = React.useRef(null);

        // Pan/Zoom state
        const [zoom, setZoom] = useState(1.0);
        const [pan, setPan] = useState({ x: 0, y: 0 });
        const dragRef = React.useRef(null);

        // Bumper to force a redraw when an async icon finishes loading.
        // The cache lives on `window` but is shared across the app; one
        // setter is enough to nudge the drawing useEffect.
        const [iconTick, setIconTick] = useState(0);
        useEffect(() => {
          window._iconBumper = () => setIconTick(t => t + 1);
          return () => { if (window._iconBumper === setIconTick) window._iconBumper = null; };
        }, []);

        // Real map image (lazy-loaded from /api/analyzer/map-image, then drawn
        // as the canvas background under the projected SC2 coords).
        const [mapImage, setMapImage] = useState(null);
        useEffect(() => {
          if (!data || !data.map_name) { setMapImage(null); return; }
          let cancelled = false;
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.onload = () => { if (!cancelled) setMapImage(img); };
          img.onerror = () => { if (!cancelled) setMapImage(null); };
          img.src = `${API}/map-image?name=${encodeURIComponent(data.map_name)}`;
          return () => { cancelled = true; };
        }, [data && data.map_name]);

        // Fetch playback data
        useEffect(() => {
          let cancelled = false;
          setLoading(true);
          setErr(null);
          setData(null);
          fetch(`${API}/playback?replay=${encodeURIComponent(replayPath)}`)
            .then(r => r.json())
            .then(j => {
              if (cancelled) return;
              if (j && j.ok) {
                // The /playback endpoint wraps the spatial-CLI output as
                // `{ ok, result: records }`. The CLI emits one NDJSON record
                // per frame plus a header record that carries map_name,
                // me_name, opp_name, game_length, bounds, etc. Older CLI
                // builds returned the playback object directly. Be tolerant
                // of both shapes and only treat the result as usable when
                // it has the required header fields.
                const raw = j.result;
                let payload = null;
                if (Array.isArray(raw)) {
                  // Prefer a record that looks like the playback header.
                  payload = raw.find(r => r && (r.map_name || r.bounds || r.game_length)) || raw[0] || null;
                } else if (raw && typeof raw === 'object') {
                  payload = raw;
                }
                if (payload && (payload.map_name || payload.bounds || payload.game_length)) {
                  setData(payload);
                  setTime(0);
                } else {
                  setErr("Replay parsed but did not return playback data. The CLI may have emitted an unexpected format.");
                }
              } else {
                setErr(j?.error || "Failed to parse replay.");
              }
              setLoading(false);
            })
            .catch(e => {
              if (!cancelled) {
                setErr(String(e));
                setLoading(false);
              }
            });
          return () => { cancelled = true; };
        }, [replayPath]);

        // Animation Loop
        useEffect(() => {
          if (!playing || !data) return;
          let lastTick = performance.now();
          const tick = (now) => {
            const dt = (now - lastTick) / 1000.0;
            lastTick = now;
            setTime(prev => {
              const next = prev + dt * speed;
              if (next >= data.game_length) {
                setPlaying(false);
                return data.game_length;
              }
              return next;
            });
            animRef.current = requestAnimationFrame(tick);
          };
          animRef.current = requestAnimationFrame(tick);
          return () => cancelAnimationFrame(animRef.current);
        }, [playing, speed, data]);

        // Drawing
        useEffect(() => {
          if (!data || !canvasRef.current || !containerRef.current) return;
          const canvas = canvasRef.current;
          const ctx = canvas.getContext('2d');

          const CW = canvas.width;
          const CH = canvas.height;

          ctx.clearRect(0, 0, CW, CH);

          // Render background
          ctx.fillStyle = "#1a1f29";
          ctx.fillRect(0, 0, CW, CH);

          const b = data.bounds;
          if (!b) return;

          const PAD = 20;
          const mapW = b.x_max - b.x_min || 1;
          const mapH = b.y_max - b.y_min || 1;

          // Compute scale
          const scaleX = (CW - 2 * PAD) / mapW;
          const scaleY = (CH - 2 * PAD) / mapH;
          const baseScale = Math.min(scaleX, scaleY);

          // Project SC2 coordinates to Canvas
          const project = (sc2_x, sc2_y) => {
             // In SC2, y grows upwards. In canvas, y grows downwards.
             let px = PAD + (sc2_x - b.x_min) * baseScale;
             let py = CH - PAD - (sc2_y - b.y_min) * baseScale;

             // Apply pan/zoom relative to center
             px = (px - CW/2) * zoom + pan.x + CW/2;
             py = (py - CH/2) * zoom + pan.y + CH/2;

             return { x: px, y: py };
          };

          // Draw bounds box
          const pMin = project(b.x_min, b.y_min);
          const pMax = project(b.x_max, b.y_max);

          // Draw real map image inside the playable bounds rectangle,
          // BEFORE the grid/events/icons so they paint on top of it.
          if (mapImage && mapImage.complete && mapImage.naturalWidth > 0) {
             const dx = pMin.x;
             const dy = pMax.y;
             const dw = pMax.x - pMin.x;
             const dh = pMin.y - pMax.y;
             ctx.save();
             ctx.globalAlpha = 0.85;
             try { ctx.drawImage(mapImage, dx, dy, dw, dh); } catch (_) {}
             ctx.restore();
          }

          ctx.strokeStyle = "#2b3445";
          ctx.lineWidth = 2;
          ctx.strokeRect(pMin.x, pMax.y, pMax.x - pMin.x, pMin.y - pMax.y);

          // Draw grid
          ctx.strokeStyle = "#242c3b";
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let x = Math.ceil(b.x_min); x <= b.x_max; x += 16) {
             const p0 = project(x, b.y_min);
             const p1 = project(x, b.y_max);
             ctx.moveTo(p0.x, p0.y);
             ctx.lineTo(p1.x, p1.y);
          }
          for (let y = Math.ceil(b.y_min); y <= b.y_max; y += 16) {
             const p0 = project(b.x_min, y);
             const p1 = project(b.x_max, y);
             ctx.moveTo(p0.x, p0.y);
             ctx.lineTo(p1.x, p1.y);
          }
          ctx.stroke();

          // Create cache for icons. Buildings live under /static/icons/buildings/
          // and units under /static/icons/units/. Unit names from sc2reader carry
          // a few variants (SiegeTankSieged, WarpPrismPhasing, BanelingBurrowed,
          // Hellion vs HellionTank, etc.) so we map known variants back to their
          // canonical base name before the lookup.
          const _UNIT_NAME_ALIASES = {
            // Hallucinations are clones -- show the same icon as the
            // real unit. The actual gameplay distinction (real vs hallu)
            // doesn't matter for the playback viewer. sc2reader reports
            // them as "HallucinatedX" raw types.
            hallucinatedphoenix: 'phoenix',
            hallucinatedstalker: 'stalker',
            hallucinatedzealot: 'zealot',
            hallucinatedhightemplar: 'hightemplar',
            hallucinatedimmortal: 'immortal',
            hallucinatedvoidray: 'voidray',
            hallucinatedcolossus: 'colossus',
            hallucinatedarchon: 'archon',
            hallucinatedprobe: 'probe',
            hallucinateddisruptor: 'disruptor',
            hallucinatedoracle: 'oracle',
            hallucinatedwarpprism: 'warpprism',
            hallucinatedadept: 'adept',
            hallucinatedsentry: 'sentry',
            siegetanksieged: 'siegetank',
            siegetank: 'siegetank',
            warpprismphasing: 'warpprism',
            warpprism: 'warpprism',
            banelingburrowed: 'baneling',
            roachburrowed: 'roach',
            zerglingburrowed: 'zergling',
            hydraliskburrowed: 'hydralisk',
            infestorburrowed: 'infestor',
            lurkerburrowed: 'lurker',
            lurkermp: 'lurker',
            lurkermpburrowed: 'lurker',
            ravagerburrowed: 'ravager',
            droneburrowed: 'drone',
            queenburrowed: 'queen',
            swarmhostmp: 'swarmhost',
            swarmhostmpburrowed: 'swarmhost',
            hellionhellion: 'hellion',
            helliontank: 'hellbat',
            vikingfighter: 'viking',
            vikingassault: 'viking',
            thoraap: 'thor',
            ling: 'zergling',
            zealotwarp: 'zealot',
            stalkerwarp: 'stalker',
            sentrywarp: 'sentry',
          };
          const getIcon = (name, category) => {
            if (!window._iconCache) window._iconCache = {};
            const raw = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const cleanName = (category === 'unit' && _UNIT_NAME_ALIASES[raw]) || raw;
            const cacheKey = (category || 'auto') + '|' + cleanName;
            if (window._iconCache[cacheKey]) return window._iconCache[cacheKey];

            let iconPath;
            if (category === 'unit') {
              iconPath = `/static/icons/units/${cleanName}.png`;
            } else {
              iconPath = `/static/icons/buildings/${cleanName}.png`;
              if (window.TimingCatalog && window.TimingCatalog.TOKENS) {
                 const tok = window.TimingCatalog.TOKENS.find(t => t.id.toLowerCase() === cleanName || t.name.toLowerCase() === cleanName);
                 if (tok) iconPath = `/static/icons/buildings/${tok.icon}`;
              }
            }

            const img = new Image();
            // Trigger a single re-render when this icon loads so the unit/
            // building isn't stuck on its fallback dot. We don't want every
            // icon to re-render individually, so we coalesce with rAF.
            img.onload = () => {
              if (!window._iconRedrawScheduled) {
                window._iconRedrawScheduled = true;
                requestAnimationFrame(() => {
                  window._iconRedrawScheduled = false;
                  // Bump the iconBumper so the drawing useEffect re-fires.
                  if (window._iconBumper) window._iconBumper();
                });
              }
            };
            img.onerror = () => { /* leave as broken; fallback dot will draw */ };
            img.src = iconPath;
            window._iconCache[cacheKey] = img;
            return img;
          };

          // Draw Events
          const drawEvent = (ev, colorStr, isMe) => {
            if (ev.time > time) return;
            if (!ev.x || !ev.y) return;
            const p = project(ev.x, ev.y);

            if (ev.type === "building") {
              const img = getIcon(ev.name, 'building');
              const sz = Math.max(18, 22 * zoom);

              if (img.complete && img.naturalWidth > 0) {
                 // Draw backing for visibility
                 ctx.fillStyle = colorStr;
                 ctx.globalAlpha = 0.6;
                 ctx.beginPath();
                 ctx.arc(p.x, p.y, sz/2 + 2, 0, 2*Math.PI);
                 ctx.fill();
                 ctx.globalAlpha = 1.0;

                 ctx.drawImage(img, p.x - sz/2, p.y - sz/2, sz, sz);
              } else {
                 ctx.fillStyle = colorStr;
                 ctx.beginPath();
                 ctx.rect(p.x - 6*zoom, p.y - 6*zoom, 12*zoom, 12*zoom);
                 ctx.fill();
                 ctx.strokeStyle = "#000";
                 ctx.lineWidth = 1;
                 ctx.stroke();
              }
            } else {
              ctx.fillStyle = colorStr;
              ctx.beginPath();
              ctx.arc(p.x, p.y, Math.max(3, 5*zoom), 0, 2*Math.PI);
              ctx.fill();
            }
          };

          // ---- Spawn-location markers ---------------------------------------
          // Drawn BEFORE buildings/units so the actual building icons stack
          // on top. Each player's spawn is the first town hall placement
          // detected by the Python extractor; the marker is a labeled ring
          // sized large enough that you can visually confirm the alignment
          // between SC2 coords and the underlying minimap.
          if (Array.isArray(data.spawn_locations)) {
            for (const s of data.spawn_locations) {
              if (typeof s.x !== 'number' || typeof s.y !== 'number') continue;
              const sp = project(s.x, s.y);
              const isMe = s.owner === 'me';
              const ring = isMe ? '#66BB6A' : '#EF5350';
              const label = isMe ? (data.me_name || 'You') : (data.opp_name || 'Opp');
              const r1 = Math.max(22, 30 * zoom);
              const r2 = r1 + Math.max(4, 5 * zoom);
              ctx.save();
              ctx.lineWidth = Math.max(2, 2.5 * Math.sqrt(zoom));
              ctx.strokeStyle = ring;
              ctx.globalAlpha = 0.9;
              ctx.beginPath(); ctx.arc(sp.x, sp.y, r1, 0, 2 * Math.PI); ctx.stroke();
              ctx.globalAlpha = 0.45;
              ctx.beginPath(); ctx.arc(sp.x, sp.y, r2, 0, 2 * Math.PI); ctx.stroke();
              ctx.globalAlpha = 1;
              ctx.font = Math.max(13, Math.floor(14 * zoom)) + 'px sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              const ty = sp.y + r2 + 4;
              const tw = ctx.measureText(label).width;
              ctx.fillStyle = 'rgba(20,24,32,0.85)';
              ctx.fillRect(sp.x - tw/2 - 4, ty - 1, tw + 8, Math.max(14, 13 * zoom));
              ctx.fillStyle = ring;
              ctx.fillText(label, sp.x, ty + 1);
              ctx.restore();
            }
          }

          if (data.my_events) data.my_events.forEach(e => drawEvent(e, "#66BB6A", true));
          if (data.opp_events) data.opp_events.forEach(e => drawEvent(e, "#EF5350", false));

          // ---- Moving units --------------------------------------------------
          // Each unit carries a flat [t,x,y, t,x,y, ...] waypoint array. Find
          // the segment surrounding the current `time` and linearly interpolate
          // to get the unit's position. Only render units that have been born
          // and are not yet dead. Each unit gets its own SC2-Overlay PNG icon
          // (so 12 marines render as 12 little marine icons, not 12 dots).
          // How long the death-spot X stays on the canvas after a unit
          // dies, in game-seconds. 2s is long enough to spot which clump
          // of icons died but short enough that a big fight doesn't leave
          // a forest of permanent crosses.
          const DEATH_MARKER_LINGER = 2.0;

          const drawUnit = (u, ringStr) => {
            if (!u || !u.waypoints || u.waypoints.length < 3) return;
            if (typeof u.born === 'number' && time < u.born) return;
            // Death window: in (died, died + DEATH_MARKER_LINGER) we draw
            // a fading X at the last known position. After that we drop
            // the unit completely.
            const isDead = (u.died != null && time > u.died);
            if (isDead && time > u.died + DEATH_MARKER_LINGER) return;
            if (isDead) {
              const wpd = u.waypoints;
              const N = wpd.length / 3;
              const lx = wpd[(N - 1) * 3 + 1];
              const ly = wpd[(N - 1) * 3 + 2];
              if (typeof lx === 'number' && typeof ly === 'number') {
                const pp = project(lx, ly);
                const fade = Math.max(0, 1 - (time - u.died) / DEATH_MARKER_LINGER);
                const r = (u.is_worker
                    ? Math.max(4, 5 * zoom)
                    : Math.max(6, 7 * zoom));
                ctx.save();
                ctx.globalAlpha = 0.35 + 0.55 * fade;
                ctx.strokeStyle = ringStr;
                ctx.lineWidth = Math.max(1.5, 2 * Math.sqrt(zoom));
                ctx.beginPath();
                ctx.moveTo(pp.x - r, pp.y - r);
                ctx.lineTo(pp.x + r, pp.y + r);
                ctx.moveTo(pp.x - r, pp.y + r);
                ctx.lineTo(pp.x + r, pp.y - r);
                ctx.stroke();
                ctx.restore();
              }
              return;
            }
            const wp = u.waypoints; // length is multiple of 3
            const N = wp.length / 3;
            // Binary search for the largest waypoint index whose t <= time.
            let lo = 0, hi = N - 1, idx = 0;
            while (lo <= hi) {
              const mid = (lo + hi) >> 1;
              if (wp[mid * 3] <= time) { idx = mid; lo = mid + 1; }
              else                       { hi = mid - 1; }
            }
            let ux, uy;
            if (idx >= N - 1) {
              ux = wp[idx * 3 + 1];
              uy = wp[idx * 3 + 2];
            } else {
              const t0 = wp[idx * 3],     x0 = wp[idx * 3 + 1],     y0 = wp[idx * 3 + 2];
              const t1 = wp[(idx + 1) * 3], x1 = wp[(idx + 1) * 3 + 1], y1 = wp[(idx + 1) * 3 + 2];
              // sc2reader emits UnitPositionsEvent sparsely for idle /
              // mining units. If two consecutive waypoints are far apart
              // in TIME (>10 game-seconds), the unit was likely doing a
              // mining loop or sitting idle in between -- linear interp
              // shows a fake straight-line drift across the map. Snap to
              // the EARLIER waypoint instead so the unit stays put near
              // its mining patch / idle position until the next real
              // sample arrives.
              const span = t1 - t0;
              const SPARSE_GAP_SEC = 10;
              if (span > SPARSE_GAP_SEC) {
                ux = x0;
                uy = y0;
              } else {
                const safeSpan = Math.max(1e-3, span);
                const f = Math.min(1, Math.max(0, (time - t0) / safeSpan));
                ux = x0 + (x1 - x0) * f;
                uy = y0 + (y1 - y0) * f;
              }
            }
            const p0 = project(ux, uy);
            // Per-unit deterministic offset so units sharing a position
            // (e.g. 20 roaches that just hatched from the same warren)
            // fan out into a small visible cluster instead of drawing 20
            // icons stacked on the same pixel. Spread radius scales with
            // zoom so the cluster stays compact when zoomed out.
            const seed = ((u.id || 0) * 2654435761) >>> 0;
            const angle = (seed % 360) * Math.PI / 180;
            const radius = ((seed >>> 9) & 7) * (1.5 + zoom * 0.6);
            const p = { x: p0.x + Math.cos(angle) * radius, y: p0.y + Math.sin(angle) * radius };

            // Workers (Drone/Probe/SCV/MULE) are rendered smaller and a
            // touch transparent so they don't drown the canvas when 60+
            // workers are alive mid-game. Combat units stay full-sized.
            const isWorker = !!u.is_worker;
            const sz = isWorker
              ? Math.max(10, 14 * zoom)
              : Math.max(16, 22 * zoom);
            const alpha = isWorker ? 0.7 : 1.0;
            const img = getIcon(u.name, 'unit');
            if (img.complete && img.naturalWidth > 0) {
              // Colored team ring behind the icon for friend/foe legibility.
              ctx.save();
              ctx.globalAlpha = alpha;
              ctx.strokeStyle = ringStr;
              ctx.lineWidth = Math.max(1, 1.5 * Math.sqrt(zoom));
              ctx.beginPath();
              ctx.arc(p.x, p.y, sz / 2 + 1, 0, 2 * Math.PI);
              ctx.stroke();
              ctx.drawImage(img, p.x - sz / 2, p.y - sz / 2, sz, sz);
              ctx.restore();
            } else {
              // Icon not yet loaded or missing PNG (e.g. probe/drone/scv
              // don't ship icon files). Draw a bright dot with a high-
              // contrast outline so the unit is unmistakable on the busy
              // map texture. Workers get smaller dots than combat units.
              const dotRadius = isWorker
                ? Math.max(4, 5 * zoom)
                : Math.max(6, 8 * zoom);
              const fillColor = isWorker
                ? (ringStr === "#1B5E20" ? "#7CFC76" : "#FF7B85")
                : (ringStr === "#1B5E20" ? "#A6FF9A" : "#FFA8B0");
              ctx.save();
              ctx.globalAlpha = isWorker ? 0.9 : 1.0;
              ctx.fillStyle = fillColor;
              ctx.beginPath();
              ctx.arc(p.x, p.y, dotRadius, 0, 2 * Math.PI);
              ctx.fill();
              ctx.lineWidth = Math.max(1, 1.5 * Math.sqrt(zoom));
              ctx.strokeStyle = "#0A0E1A";
              ctx.stroke();
              ctx.restore();
            }
          };
          if (data.my_units)  data.my_units.forEach(u  => drawUnit(u, "#1B5E20"));
          if (data.opp_units) data.opp_units.forEach(u => drawUnit(u, "#B71C1C"));

        }, [data, time, zoom, pan, mapImage, iconTick]);

        // Wheel zoom is attached as a NATIVE listener (with passive:false) inside
        // Wheel zoom. We use the JSX onWheel prop directly (React's
        // synthetic event) instead of a native listener -- the native
        // useEffect-based listener wasn't firing reliably across React
        // 18 mount cycles. The page has nothing to scroll inside this
        // fullscreen viewer, so we don't need preventDefault to keep the
        // page anchored.
        const handleWheel = (e) => {
          if (e.deltaY < 0) setZoom((z) => Math.min(8.0, z * 1.2));
          else              setZoom((z) => Math.max(0.25, z / 1.2));
        };

        // (Wheel zoom is now bound via the JSX `onWheel` prop on the
        // canvas container. See `handleWheel` above.)

        // Auto-hide chrome (header + control bar). Show on mouse move/enter,
        // hide after 2.2s of idle.
        const [chromeVisible, setChromeVisible] = useState(true);
        const chromeTimerRef = React.useRef(null);
        useEffect(() => {
          const el = containerRef.current;
          if (!el) return;
          const show = () => {
            setChromeVisible(true);
            if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
            chromeTimerRef.current = setTimeout(() => setChromeVisible(false), 2200);
          };
          el.addEventListener('mousemove', show);
          el.addEventListener('mouseenter', show);
          show();
          return () => {
            el.removeEventListener('mousemove', show);
            el.removeEventListener('mouseenter', show);
            if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current);
          };
        }, []);

        // Make the canvas fill its container so the map is as big as possible.
        useEffect(() => {
          const fit = () => {
            const el = containerRef.current;
            const cv = canvasRef.current;
            if (!el || !cv) return;
            const r = el.getBoundingClientRect();
            const sz = Math.max(400, Math.min(r.width, r.height));
            if (cv.width !== sz)  cv.width  = sz;
            if (cv.height !== sz) cv.height = sz;
            setIconTick(t => t + 1);
          };
          fit();
          window.addEventListener('resize', fit);
          return () => window.removeEventListener('resize', fit);
        }, [data]);

        // Keyboard shortcuts: space=play/pause, arrows=seek 5s, Home/End=ends.
        useEffect(() => {
          const onKey = (e) => {
            if (!data) return;
            if (e.target && (/INPUT|TEXTAREA|SELECT/).test(e.target.tagName)) return;
            if (e.code === 'Space') { e.preventDefault(); setPlaying(p => !p); }
            else if (e.code === 'ArrowLeft')  setTime(t => Math.max(0, t - 5));
            else if (e.code === 'ArrowRight') setTime(t => Math.min(data.game_length, t + 5));
            else if (e.code === 'Home')       setTime(0);
            else if (e.code === 'End')        setTime(data.game_length);
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [data]);

        const handlePointerDown = (e) => {
           // Don't start a pan-drag when the user clicks an interactive
           // child (timeline scrubber, buttons, etc.) -- those events
           // bubble up to the container and would otherwise trigger pan.
           const tag = (e.target && e.target.tagName) || "";
           if (tag === "INPUT" || tag === "BUTTON" || tag === "LABEL"
               || tag === "SELECT" || tag === "TEXTAREA"
               || (e.target && e.target.closest && e.target.closest('button,input,label,select'))) {
             return;
           }
           dragRef.current = { startX: e.clientX, startY: e.clientY, pX: pan.x, pY: pan.y };
        };
        const handlePointerMove = (e) => {
           if (!dragRef.current) return;
           const dx = e.clientX - dragRef.current.startX;
           const dy = e.clientY - dragRef.current.startY;
           setPan({ x: dragRef.current.pX + dx, y: dragRef.current.pY + dy });
        };
        const handlePointerUp = () => {
           dragRef.current = null;
        };

        const formatTime = (secs) => {
          const m = Math.floor(secs / 60);
          const s = Math.floor(secs % 60);
          return `${m}:${s.toString().padStart(2, '0')}`;
        };

        if (loading) {
          return <div className="flex h-full items-center justify-center"><div className="animate-pulse">Loading Replay...</div></div>;
        }

        if (err) {
          return (
            <div className="p-4">
              <button onClick={onBack} className="mb-4 text-accent-500 hover:text-accent-400">← Back</button>
              <div className="text-loss-500">{err}</div>
            </div>
          );
        }

        // Belt-and-suspenders: if the fetch resolved without an error but
        // `data` is still null (race condition during re-fetch, unexpected
        // CLI shape, etc.), bail out cleanly instead of crashing on
        // `data.map_name`.
        if (!data) {
          return (
            <div className="p-4">
              <button onClick={onBack} className="mb-4 text-accent-500 hover:text-accent-400">← Back</button>
              <div className="text-neutral-400 text-sm">No playback data available for this replay.</div>
            </div>
          );
        }

        const mapName = data.map_name || data.map || "Unknown map";
        const meName  = data.me_name  || data.player_name || "You";
        const oppName = data.opp_name || data.opponent || "Opponent";
        const gameLen = Number.isFinite(data.game_length) ? data.game_length : 0;

        return (
          <div className="fixed inset-0 z-30 bg-base-900 flex flex-col">
            {/* Resource HUD sits ABOVE the canvas as a sibling (not an
                overlay) so it never covers the playable map. */}
            <MapIntelResourceBar data={data} time={time} />
            {/* Canvas Area -- fills the viewport. The header & controls are
                overlaid on top with auto-hide so the map gets the full space. */}
            <div
              ref={containerRef}
              className="flex-1 bg-base-900 relative overflow-hidden flex justify-center items-center cursor-move select-none"
              onWheel={handleWheel}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerUp}
            >
              <canvas
                ref={canvasRef}
                width={800}
                height={800}
                className="block"
                style={{ touchAction: 'none' }}
              />

              {/* Top overlay: title + back button (auto-hide) */}
              <div className={"absolute top-0 left-0 right-0 z-20 pointer-events-none transition-opacity duration-200 " + (chromeVisible ? "opacity-100" : "opacity-0")}>
                <div className="bg-gradient-to-b from-base-900/90 via-base-900/60 to-transparent px-4 py-3 flex items-center gap-4 pointer-events-auto">
                  <button
                    onClick={onBack}
                    className="text-neutral-200 hover:text-white px-3 py-1.5 bg-base-700/80 hover:bg-base-600 rounded transition-colors text-sm shadow-lg"
                  >
                    ← Exit
                  </button>
                  <div className="flex flex-col">
                    <span className="font-semibold text-base">{mapName}</span>
                    <span className="text-xs text-neutral-300">
                      <span className="text-win-400">{meName}</span>
                      <span className="text-neutral-400 mx-1">vs</span>
                      <span className="text-loss-400">{oppName}</span>
                    </span>
                  </div>
                  <div className="flex-1" />
                  <div className="tabular-nums font-mono text-xl bg-base-900/70 px-3 py-1 rounded">
                    {formatTime(time)} / {formatTime(gameLen)}
                  </div>
                </div>
              </div>

              {/* Game Over Screen */}
              {time >= data.game_length && (
                <div className="absolute inset-0 bg-base-900/85 backdrop-blur-sm flex items-center justify-center p-8 z-30">
                  <div className="bg-base-800 border border-base-600 rounded-lg shadow-2xl p-6 w-full max-w-2xl">
                    <h2 className="text-3xl font-bold mb-2 text-center">
                      {data.result === 'Victory' ? (
                        <span className="text-win-500">VICTORY</span>
                      ) : data.result === 'Defeat' ? (
                        <span className="text-loss-500">DEFEAT</span>
                      ) : (
                        <span className="text-neutral-300">GAME OVER</span>
                      )}
                    </h2>
                    <p className="text-center text-neutral-400 mb-6">Game finished at {formatTime(data.game_length)}</p>
                    <div className="grid grid-cols-2 gap-4 mb-6">
                      <div className="bg-base-900 p-4 rounded border border-base-700">
                        <h3 className="text-win-400 font-semibold mb-2">{data.me_name} (You)</h3>
                        <ul className="text-sm space-y-1 text-neutral-300 list-disc list-inside">
                           <li>Max Army Val: {Math.max(...data.my_stats.map(s => s.army_val), 0).toLocaleString()}</li>
                           <li>Events Captured: {data.my_events.length}</li>
                        </ul>
                      </div>
                      <div className="bg-base-900 p-4 rounded border border-base-700">
                        <h3 className="text-loss-400 font-semibold mb-2">{data.opp_name} (Opponent)</h3>
                        <ul className="text-sm space-y-1 text-neutral-300 list-disc list-inside">
                           <li>Max Army Val: {Math.max(...data.opp_stats.map(s => s.army_val), 0).toLocaleString()}</li>
                           <li>Events Captured: {data.opp_events.length}</li>
                        </ul>
                      </div>
                    </div>
                    {data.analysis && (
                      <div className="bg-base-900 p-4 rounded border border-base-700 mb-6">
                        <h3 className="font-semibold mb-2 text-neutral-200">Post-Game Analysis</h3>
                        <div className="space-y-3 text-sm">
                          <div><span className="text-win-400 font-semibold">Good: </span><span className="text-neutral-300">{data.analysis.good.join(" ")}</span></div>
                          <div><span className="text-loss-400 font-semibold">To Improve: </span><span className="text-neutral-300">{data.analysis.bad.join(" ")}</span></div>
                          <div><span className="text-gold-400 font-semibold">Tip: </span><span className="text-neutral-300">{data.analysis.tips.join(" ")}</span></div>
                        </div>
                      </div>
                    )}
                    <div className="flex justify-center gap-4">
                       <button
                         className="bg-base-700 hover:bg-base-600 px-4 py-2 rounded font-medium transition-colors"
                         onClick={() => { setTime(0); setPlaying(true); }}
                       >
                         Watch Again
                       </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Bottom overlay: playback controls (auto-hide YouTube-style) */}
              <div className={"absolute bottom-0 left-0 right-0 z-20 pointer-events-none transition-opacity duration-200 " + (chromeVisible ? "opacity-100" : "opacity-0")}>
                <div className="bg-gradient-to-t from-base-900/95 via-base-900/80 to-transparent px-4 pt-8 pb-3 pointer-events-auto">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setTime(t => Math.max(0, t - 10))}
                      title="Back 10s"
                      className="w-9 h-9 rounded-full flex items-center justify-center bg-base-800/80 hover:bg-base-700 text-neutral-200 text-sm transition-colors"
                    >⏪</button>
                    <button
                      onClick={() => setPlaying(!playing)}
                      title="Play / Pause (Space)"
                      className={"w-12 h-12 rounded-full flex items-center justify-center transition-colors shadow-lg text-lg " + (
                        playing ? 'bg-amber-600 hover:bg-amber-500' : 'bg-win-600 hover:bg-win-500'
                      )}
                    >{playing ? '⏸' : '▶'}</button>
                    <button
                      onClick={() => setTime(t => Math.min(data.game_length, t + 10))}
                      title="Forward 10s"
                      className="w-9 h-9 rounded-full flex items-center justify-center bg-base-800/80 hover:bg-base-700 text-neutral-200 text-sm transition-colors"
                    >⏩</button>

                    <span className="tabular-nums font-mono text-xs text-neutral-300 ml-2 w-12 text-right">{formatTime(time)}</span>
                    <input
                      type="range"
                      min="0"
                      max={data.game_length}
                      value={time}
                      step="0.5"
                      onChange={e => setTime(parseFloat(e.target.value))}
                      className="flex-1 accent-accent-500 h-1.5"
                    />
                    <span className="tabular-nums font-mono text-xs text-neutral-400 w-12">{formatTime(gameLen)}</span>

                    <div className="flex bg-base-900/70 rounded overflow-hidden border border-base-700 ml-2">
                      {[0.5, 1, 2, 4, 8].map(s => (
                        <button
                          key={s}
                          onClick={() => setSpeed(s)}
                          className={"px-2.5 py-1 text-xs font-mono border-r border-base-700 last:border-0 " + (
                            speed === s ? 'bg-accent-600 text-white' : 'text-neutral-400 hover:bg-base-700'
                          )}
                        >{s}x</button>
                      ))}
                    </div>

                    <button
                      onClick={() => { setZoom(1); setPan({x:0, y:0}); }}
                      title="Reset zoom & pan"
                      className="px-3 py-1.5 text-xs bg-base-700/80 hover:bg-base-600 text-neutral-300 rounded transition-colors ml-2"
                    >Reset View</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      }

  // Expose to global so inline-block JSX in index.html can render
  // these as bare identifiers.
  Object.assign(window, {
    MapIntelViewer
  });
})();
