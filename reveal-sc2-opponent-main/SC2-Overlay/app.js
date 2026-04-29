/* ============================================================
 * SC2 Stream Overlay — front-end controller
 *
 * Architecture:
 *   - Single socket connection to the local overlay server.
 *   - All transient pop-ups flow through `overlay_event`:
 *     { id, type, payload, durationMs, priority, timestamp }
 *   - Each type is registered with a renderer function below
 *     (EVENT_REGISTRY). The queue serializes events by "slot" so
 *     two widgets that share a screen position can't collide.
 *   - A persistent session widget listens on `session_state` and
 *     just renders; it never queues.
 *   - Legacy channels (`new_match_result`, `opponent_update`)
 *     are forwarded into the registry so older senders still work.
 * ============================================================ */

(function () {
    'use strict';

    // --------------------------------------------------------
    // SINGLE-WIDGET MODE
    // --------------------------------------------------------
    // If the URL has ?w=<name>, this page is being loaded as ONE
    // OBS Browser Source rendering ONLY that widget. The body gets
    // class names "single-widget" and "widget-<name>" so widget-mode.css
    // can override the absolute positioning baked into the all-in-one
    // layout (so the widget fills its OBS source instead of pinning to
    // a fixed corner of the viewport).
    const SINGLE_WIDGET = (() => {
        try {
            const p = new URLSearchParams(window.location.search);
            return p.get('w') || null;
        } catch (_) { return null; }
    })();
    if (SINGLE_WIDGET) {
        document.documentElement.classList.add('single-widget');
        document.body.classList.add('single-widget', 'widget-' + SINGLE_WIDGET);
    }

    // --------------------------------------------------------
    // SETUP
    // --------------------------------------------------------
    const SERVER_URL = 'http://localhost:3000';
    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10000
    });

    let runtimeConfig = { sounds: { enabled: false, volume: 0.5 } };

    socket.on('connect',    () => console.log('[Overlay] Connected to server.'));
    socket.on('disconnect', () => console.log('[Overlay] Disconnected.'));
    socket.on('connect_error', (err) => console.warn('[Overlay] Connect error:', err?.message));

    socket.on('config_snapshot', (cfg) => {
        runtimeConfig = cfg || runtimeConfig;
    });

    // --------------------------------------------------------
    // EVENT QUEUE (per slot)
    // --------------------------------------------------------
    // Slot = which region of the screen the widget occupies.
    // We keep one FIFO per slot so two widgets fighting for the
    // same area stack sequentially instead of overwriting.
    const slotQueues = new Map();   // slot -> [queuedItem]
    const slotBusy   = new Map();   // slot -> bool

    function enqueue(envelope) {
        const def = EVENT_REGISTRY[envelope.type];
        if (!def) {
            console.warn('[Overlay] Unknown event type:', envelope.type);
            return;
        }
        const slot = def.slot || envelope.type;
        if (!slotQueues.has(slot)) slotQueues.set(slot, []);
        const q = slotQueues.get(slot);

        // Higher priority jumps the line (but never interrupts the one playing).
        const insertAt = q.findIndex(e => (e.priority || 0) < (envelope.priority || 0));
        if (insertAt === -1) q.push(envelope);
        else q.splice(insertAt, 0, envelope);

        pumpSlot(slot);
    }

    function pumpSlot(slot) {
        if (slotBusy.get(slot)) return;
        const q = slotQueues.get(slot);
        if (!q || q.length === 0) return;

        const envelope = q.shift();
        slotBusy.set(slot, true);

        const def = EVENT_REGISTRY[envelope.type];
        try {
            def.render(envelope.payload, envelope);
            playSound(envelope.type);
        } catch (err) {
            console.error('[Overlay] Render failure for', envelope.type, err);
            slotBusy.set(slot, false);
            pumpSlot(slot);
            return;
        }

        const duration = Math.max(1000, envelope.durationMs || def.defaultDurationMs || 10000);
        setTimeout(() => {
            try { def.hide?.(); } catch (_) {}
            // Small gap so eye can register the next pop-up.
            setTimeout(() => {
                slotBusy.set(slot, false);
                pumpSlot(slot);
            }, 350);
        }, duration);
    }

    // --------------------------------------------------------
    // SOUND CUES
    // --------------------------------------------------------
    function playSound(type) {
        if (!runtimeConfig?.sounds?.enabled) return;
        const el = document.getElementById(`snd-${type}`);
        if (!el) return;
        // If no audio source was set (no mp3 dropped in /static/sounds), skip quietly.
        if (!el.currentSrc && !el.src) {
            const candidate = `${SERVER_URL}/static/sounds/${type}.mp3`;
            el.src = candidate;
        }
        try {
            el.volume = Math.max(0, Math.min(1, runtimeConfig.sounds.volume ?? 0.5));
            el.currentTime = 0;
            el.play().catch(() => { /* browser/OBS may block autoplay; fine */ });
        } catch (_) { /* ignore */ }
    }

    // --------------------------------------------------------
    // WIDGET HELPERS
    // --------------------------------------------------------
    function show(el) { el?.classList.add('show'); }
    function hide(el) { el?.classList.remove('show'); }

    function safeText(el, value) {
        if (!el) return;
        el.textContent = (value == null || value === '') ? '' : String(value);
    }


    // --------------------------------------------------------
    // SCOUTING — last-N games row helpers
    // --------------------------------------------------------
    // recentGames[i] shape (from buildRecentGamesForOpponent in
    // stream-overlay-backend/index.js):
    //   { lengthText, result, myBuild, oppBuild, myOpener[],
    //     oppOpener[], map, oppRace, date }
    // openers are arrays of { time:"m:ss", name:"BuildingName" }
    // capped at 4 entries each on the backend so the widget never
    // overflows.
    const SCOUT_RESULT_CLASS = {
        Win: 'scout-recent-result-win',
        Victory: 'scout-recent-result-win',
        Loss: 'scout-recent-result-loss',
        Defeat: 'scout-recent-result-loss',
    };
    const SCOUT_RESULT_LETTER = {
        Win: 'W', Victory: 'W',
        Loss: 'L', Defeat: 'L',
    };

    // Build the YOU/OPP line for one game in the scouting "Last games"
    // list. We render only the classification name (e.g. "Protoss - 4
    // Gate Rush" or "(unclassified)") — never the raw build_log
    // milestones with timings. The backend still computes openers and
    // ships them in the payload; the widget intentionally ignores them.
    function _appendScoutLine(parent, sideLabel, sideClass, build, _opener) {
        const line = document.createElement('div');
        line.className = 'scout-recent-line ' + sideClass;
        const lab = document.createElement('span');
        lab.className = 'scout-recent-side';
        lab.textContent = sideLabel;
        const b = document.createElement('span');
        b.className = 'scout-recent-build';
        b.textContent = build || '(unclassified)';
        line.appendChild(lab);
        line.appendChild(b);
        parent.appendChild(line);
    }

    function _buildScoutRecentRow(game) {
        const row = document.createElement('div');
        row.className = 'scout-recent-row';
        const head = document.createElement('div');
        head.className = 'scout-recent-head';
        const result = document.createElement('span');
        const resultKey = game.result || '';
        result.className = 'scout-recent-result ' +
            (SCOUT_RESULT_CLASS[resultKey] || '');
        result.textContent = SCOUT_RESULT_LETTER[resultKey] || '\u00b7';
        const length = document.createElement('span');
        length.className = 'scout-recent-length';
        length.textContent = game.lengthText || '\u2014';
        head.appendChild(result);
        head.appendChild(length);
        if (game.map) {
            const meta = document.createElement('span');
            meta.className = 'scout-recent-meta';
            meta.textContent = game.map;
            head.appendChild(meta);
        }
        row.appendChild(head);
        _appendScoutLine(row, 'YOU', 'scout-recent-line-mine',
            game.myBuild, game.myOpener);
        _appendScoutLine(row, 'OPP', 'scout-recent-line-opp',
            game.oppBuild, game.oppOpener);
        return row;
    }

    function renderScoutRecentGames(listEl, games) {
        if (!listEl) return;
        // The list is small (<= 5) so a fresh rebuild is fine on
        // each scoutingReport event.
        listEl.replaceChildren();
        for (const g of games) listEl.appendChild(_buildScoutRecentRow(g));
    }

    // --------------------------------------------------------
    // SC2 ICON HELPERS
    // --------------------------------------------------------
    // window.SC2Icons is loaded from icon-registry.js. We keep
    // tiny no-op shims here so the overlay still runs even if
    // someone forgets to include that script.
    const Icons = window.SC2Icons || {
        raceIcon: () => '',
        leagueIcon: () => '',
        resultIcon: () => '',
        miscIcon: () => '',
        strategyIcons: () => [],
        makeIconImg: () => null,
        fillIconRow: () => {}
    };

    // Set a single-icon slot by URL. If the URL is empty, clears.
    function setIconSlot(el, url, alt) {
        if (!el) return;
        el.innerHTML = '';
        const img = Icons.makeIconImg(url, alt);
        if (img) el.appendChild(img);
    }

    // --------------------------------------------------------
    // EVENT REGISTRY
    // --------------------------------------------------------
    // Each type declares:
    //   slot: visual slot (so two types that share one stack on the queue)
    //   render(payload, envelope): push payload into its DOM and show
    //   hide():   reverse the show
    // --------------------------------------------------------

    // Caches
    const els = {
        matchResult: {
            root:     document.getElementById('match-result-widget'),
            matchup:  document.getElementById('mr-matchup'),
            result:   document.getElementById('mr-result'),
            map:      document.getElementById('mr-map'),
            duration: document.getElementById('mr-duration'),
            iconMe:   document.getElementById('mr-icon-me'),
            iconOpp:  document.getElementById('mr-icon-opp')
        },
        opponent: {
            root:    document.getElementById('opponent-widget'),
            details: document.getElementById('opp-details'),
            icon:    document.getElementById('opp-icon'),
            mmr:     document.getElementById('opp-mmr'),
            race:    document.getElementById('opp-race'),
            record:  document.getElementById('opp-record'),
            winrate: document.getElementById('opp-winrate')
        },
        rematch: {
            root:   document.getElementById('rematch-widget'),
            name:   document.getElementById('rematch-name'),
            record: document.getElementById('rematch-record'),
            wr:     document.getElementById('rematch-wr'),
            icon:   document.getElementById('rematch-icon')
        },
        cheese: {
            root:    document.getElementById('cheese-widget'),
            title:   document.getElementById('cheese-title'),
            icon:    document.getElementById('cheese-icon'),
            iconImg: document.getElementById('cheese-icon-img'),
            msg:     document.getElementById('cheese-msg')
        },
        favOpen: {
            root:     document.getElementById('favopen-widget'),
            strategy: document.getElementById('favopen-strategy'),
            name:     document.getElementById('favopen-name'),
            share:    document.getElementById('favopen-share'),
            icons:    document.getElementById('favopen-icons')
        },
        bestAns: {
            root:   document.getElementById('bestans-widget'),
            build:  document.getElementById('bestans-build'),
            wr:     document.getElementById('bestans-wr'),
            record: document.getElementById('bestans-record'),
            icons:  document.getElementById('bestans-icons')
        },
        reveal: {
            root:     document.getElementById('reveal-widget'),
            strategy: document.getElementById('reveal-strategy'),
            build:    document.getElementById('reveal-build'),
            result:   document.getElementById('reveal-result'),
            icons:    document.getElementById('reveal-icons'),
            timeline: document.getElementById('reveal-timeline')
        },
        meta: {
            root:     document.getElementById('meta-widget'),
            strategy: document.getElementById('meta-strategy'),
            count:    document.getElementById('meta-count'),
            icons:    document.getElementById('meta-icons')
        },
        rival: {
            root:    document.getElementById('rival-widget'),
            icon:    document.getElementById('rival-icon'),
            tier:    document.getElementById('rival-tier-label'),
            name:    document.getElementById('rival-name'),
            record:  document.getElementById('rival-record'),
            last:    document.getElementById('rival-last')
        },
        scout: {
            root:       document.getElementById('scout-widget'),
            raceIcon:   document.getElementById('scout-race-icon'),
            name:       document.getElementById('scout-name'),
            record:     document.getElementById('scout-record'),
            rivalRow:   document.getElementById('scout-rival'),
            rivalText:  document.getElementById('scout-rival-text'),
            recentRow:  document.getElementById('scout-recent'),
            recentList: document.getElementById('scout-recent-list'),
            ansRow:     document.getElementById('scout-ans'),
            ansIcons:   document.getElementById('scout-ans-icons'),
            ansText:    document.getElementById('scout-ans-text'),
            cheeseRow:  document.getElementById('scout-cheese'),
            cheeseText: document.getElementById('scout-cheese-text')
        },
        mmrDelta: {
            root:    document.getElementById('mmr-delta-widget'),
            value:   document.getElementById('mmr-delta-value'),
            current: document.getElementById('mmr-delta-current')
        },
        rank: {
            root:   document.getElementById('rank-widget'),
            title:  document.getElementById('rank-title'),
            league: document.getElementById('rank-league'),
            sub:    document.getElementById('rank-sub'),
            icon:   document.getElementById('rank-league-icon')
        },
        streak: {
            root: document.getElementById('streak-widget'),
            text: document.getElementById('streak-text'),
            sub:  document.getElementById('streak-sub')
        },
        session: {
            root:        document.getElementById('session-widget'),
            wl:          document.getElementById('session-wl'),
            time:        document.getElementById('session-time'),
            streak:      document.getElementById('session-streak'),
            mmrRow:      document.querySelector('#session-widget .session-mmr-row'),
            serverMmr:   document.getElementById('session-server-mmr')
        }
    };

    const EVENT_REGISTRY = {
        matchResult: {
            slot: 'top-center',
            defaultDurationMs: 15000,
            render(p) {
                const e = els.matchResult;
                const myRace  = (p.myRace  || '?').toUpperCase();
                const oppRace = (p.oppRace || '?').toUpperCase();
                safeText(e.matchup, `${myRace}v${oppRace}`);
                safeText(e.map, p.map || '');
                safeText(e.duration, p.durationText ? `· ${p.durationText}` : '');
                const result = (p.result || '').toUpperCase();
                safeText(e.result, result || '—');
                e.result.className = p.result === 'Victory' ? 'victory'
                                   : p.result === 'Defeat'  ? 'defeat'
                                   : '';
                setIconSlot(e.iconMe,  Icons.raceIcon(p.myRace),  p.myRace);
                setIconSlot(e.iconOpp, Icons.raceIcon(p.oppRace), p.oppRace);
                show(e.root);
            },
            hide() { hide(els.matchResult.root); }
        },

        opponentDetected: {
            // Persistent during the game: stays up from "opponent
            // detected" until matchResult fires post-game. The queue
            // still ticks (defaultDurationMs is just for slotBusy
            // bookkeeping) but hide() is a no-op so the widget keeps
            // its content on screen. The matchResult handler below
            // explicitly hides it when the game ends.
            slot: 'top-center-2',
            defaultDurationMs: 1000,
            render(p) {
                // Prefer the explicit `opponent` field (clean name from
                // backend's parser); otherwise strip the raw text.
                const cleanName = p.opponent || (
                    (p.text || 'Unknown opponent')
                        .split(',')[0]
                        .replace(/[\(\[].*?[\)\]]/g, '')
                        .replace(/\b(Zerg|Protoss|Terran|Random|[ZPTR])\b\s*$/i, '')
                        .trim() || (p.text || 'Unknown opponent')
                );
                safeText(els.opponent.details, cleanName);
                safeText(els.opponent.mmr,
                    Number.isFinite(p.mmr) ? `${p.mmr} MMR` : '');
                safeText(els.opponent.race, p.race || '');
                setIconSlot(els.opponent.icon, Icons.raceIcon(p.race), p.race);

                // Merged-in head-to-head record from buildRematchSummary().
                if (p.record && p.record.total > 0) {
                    safeText(els.opponent.record,
                        `${p.record.wins}W - ${p.record.losses}L`);
                    safeText(els.opponent.winrate,
                        `${p.record.winRate}%`);
                } else {
                    safeText(els.opponent.record, 'first meeting');
                    safeText(els.opponent.winrate, '');
                }
                show(els.opponent.root);
            },
            // Intentionally a no-op so the widget persists for the
            // whole game. The matchResult listener below clears it.
            hide() { /* persistent until matchResult */ }
        },

        rematch: {
            slot: 'top-center-3',
            defaultDurationMs: 15000,
            render(p) {
                safeText(els.rematch.name, p.opponent || '');
                safeText(els.rematch.record, `${p.wins}W – ${p.losses}L`);
                safeText(els.rematch.wr, `${p.winRate}%`);
                setIconSlot(els.rematch.icon, Icons.raceIcon(p.race), p.race);
                show(els.rematch.root);
            },
            hide() { hide(els.rematch.root); }
        },

        cheeseHistory: {
            slot: 'top-center-4',
            defaultDurationMs: 18000,
            render(p) {
                const e = els.cheese;
                // "Victory" in history means WE finished the match quickly → we cheesed them.
                // "Defeat" means they ended us fast → they cheesed us.
                let title, msg;
                if (p.result === 'Victory') {
                    title = 'YOU CHEESED THEM';
                    msg = `Last meeting: cheese win at ${p.durationText}${p.map ? ` on ${p.map}` : ''}`;
                    e.icon.textContent = '⚡';
                } else {
                    title = 'CHEESE WARNING';
                    msg = `Cheesed you at ${p.durationText}${p.map ? ` on ${p.map}` : ''}`;
                    e.icon.textContent = '⚠';
                }
                safeText(e.title, title);
                safeText(e.msg, msg);
                setIconSlot(e.iconImg, Icons.miscIcon('cheese'), 'cheese');
                show(e.root);
            },
            hide() { hide(els.cheese.root); }
        },

        streak: {
            slot: 'center-splash',
            defaultDurationMs: 8000,
            render(p) {
                const e = els.streak;
                safeText(e.text, p.text || '');
                safeText(e.sub,  p.subtext || '');
                // Clear any previous tier, apply new one.
                e.root.classList.remove(
                    'tier-heating-up', 'tier-on-fire', 'tier-rampage',
                    'tier-gg-go-again', 'tier-tilt-warn'
                );
                if (p.tier) e.root.classList.add(`tier-${p.tier}`);
                show(e.root);
            },
            hide() { hide(els.streak.root); }
        },

        rankChange: {
            slot: 'top-center',
            defaultDurationMs: 12000,
            render(p) {
                const up = (p.direction || '').toLowerCase() !== 'down';
                safeText(els.rank.title, up ? 'RANK UP' : 'RANK DOWN');
                safeText(els.rank.league, p.league || '');
                safeText(els.rank.sub, p.subtext || (up ? 'Promotion earned' : 'Demotion'));
                els.rank.title.className = up ? 'victory' : 'defeat';
                setIconSlot(els.rank.icon, Icons.leagueIcon(p.league), p.league);
                show(els.rank.root);
            },
            hide() { hide(els.rank.root); }
        },

        mmrDelta: {
            slot: 'top-right',
            defaultDurationMs: 10000,
            render(p) {
                const delta = Number(p.delta) || 0;
                const sign  = delta >= 0 ? '+' : '';
                safeText(els.mmrDelta.value, `${sign}${delta}`);
                els.mmrDelta.value.className = `big ${delta >= 0 ? 'victory' : 'defeat'}`;
                safeText(els.mmrDelta.current, Number.isFinite(p.current) ? `Now ${p.current}` : '');
                show(els.mmrDelta.root);
            },
            hide() { hide(els.mmrDelta.root); }
        },

        // F1: Opponent's favorite opening
        favoriteOpening: {
            slot: 'top-center-5',
            defaultDurationMs: 18000,
            render(p) {
                const e = els.favOpen;
                safeText(e.strategy, p.strategy || 'Unknown');
                safeText(e.name, p.opponent ? `· ${p.opponent}` : '');
                const share = Number.isFinite(p.sharePct) ? `${p.sharePct}%` : '';
                const count = Number.isFinite(p.count) && Number.isFinite(p.totalSeen)
                    ? ` (${p.count}/${p.totalSeen})`
                    : '';
                safeText(e.share, `${share}${count}`);
                Icons.fillIconRow(e.icons, Icons.strategyIcons(p.strategy), p.strategy);
                show(e.root);
            },
            hide() { hide(els.favOpen.root); }
        },

        // F2: Best historical answer to that opening
        bestAnswer: {
            slot: 'top-center-6',
            defaultDurationMs: 18000,
            render(p) {
                const e = els.bestAns;
                safeText(e.build, p.build || '?');
                safeText(e.wr, Number.isFinite(p.winRatePct) ? `${p.winRatePct}%` : '');
                safeText(e.record,
                    Number.isFinite(p.wins) && Number.isFinite(p.losses)
                        ? `${p.wins}W – ${p.losses}L`
                        : '');
                Icons.fillIconRow(e.icons, Icons.strategyIcons(p.build), p.build);
                show(e.root);
            },
            hide() { hide(els.bestAns.root); }
        },

        // F3: Post-game strategy reveal (with #3 animated build timeline)
        postGameStrategyReveal: {
            slot: 'top-center',
            defaultDurationMs: 16000,
            render(p) {
                const e = els.reveal;
                safeText(e.strategy, p.strategy || '?');
                safeText(e.build, p.myBuild ? `Yours: ${p.myBuild}` : '');
                const result = (p.result || '').toUpperCase();
                safeText(e.result, result || '');
                e.result.className = p.result === 'Victory' ? 'dim victory'
                                   : p.result === 'Defeat'  ? 'dim defeat'
                                   : 'dim';
                Icons.fillIconRow(e.icons, Icons.strategyIcons(p.strategy), p.strategy);

                // #3 Build-order timeline animation. Parse "[m:ss] Name"
                // lines from the OPPONENT's first-5-min log (deduped to
                // real milestones, not 30 zergling lines) and slide them
                // in one-by-one with a small stagger.
                if (e.timeline) {
                    e.timeline.innerHTML = '';
                    // Prefer opponent's build log (the post-game-reveal is
                    // about what the opp did, not what we did). Fall back
                    // to the user's log if the opp log is missing.
                    const lines = Array.isArray(p.oppEarlyBuildLog) && p.oppEarlyBuildLog.length
                        ? p.oppEarlyBuildLog
                        : (Array.isArray(p.earlyBuildLog) ? p.earlyBuildLog : []);
                    const steps = [];
                    for (const line of lines.slice(0, 18)) {
                        const m = String(line).match(/^\s*\[?(\d+:\d{2})\]?\s*(.+?)\s*$/);
                        if (!m) continue;
                        const stamp = m[1];
                        const name  = m[2];
                        const step = document.createElement('span');
                        step.className = 'build-step';
                        const t = document.createElement('span');
                        t.className = 'build-time';
                        t.textContent = stamp;
                        step.appendChild(t);
                        // Try to fetch a single icon for this step's name.
                        const ic = Icons.strategyIcons(name, 1);
                        if (ic.length) {
                            const img = Icons.makeIconImg(ic[0], name);
                            if (img) step.appendChild(img);
                        }
                        const lbl = document.createElement('span');
                        lbl.textContent = name;
                        step.appendChild(lbl);
                        e.timeline.appendChild(step);
                        steps.push(step);
                    }
                    // Stagger reveal: each step lights up ~80ms after the last.
                    steps.forEach((step, i) => {
                        setTimeout(() => step.classList.add('show'), 250 + i * 80);
                    });
                }

                show(e.root);
            },
            hide() {
                hide(els.reveal.root);
                if (els.reveal.timeline) els.reveal.timeline.innerHTML = '';
            }
        },

        // #6 Rival alert
        rivalAlert: {
            slot: 'top-center-7',
            defaultDurationMs: 16000,
            render(p) {
                const e = els.rival;
                const tierLabel = (p.tier || 'rival').toUpperCase();
                safeText(e.tier, tierLabel);
                safeText(e.name, p.opponent || '');
                safeText(e.record,
                    `${p.wins}W - ${p.losses}L (${p.winRate}%)  |  ${p.total} matches`);
                safeText(e.last, p.lastResult ? `Last: ${p.lastResult}` : '');
                setIconSlot(e.icon, Icons.raceIcon(p.race), p.race);
                show(e.root);
            },
            hide() { hide(els.rival.root); }
        },

        // #1 Scouting Report -- consolidated pre-game card
        scoutingReport: {
            slot: 'top-center',
            defaultDurationMs: 22000,
            render(p) {
                const e = els.scout;
                setIconSlot(e.raceIcon, Icons.raceIcon(p.race), p.race);
                safeText(e.name, p.opponent || 'Unknown');
                if (p.record && p.record.total > 0) {
                    safeText(e.record,
                        `${p.record.wins}W-${p.record.losses}L  ${p.record.winRate}%`);
                } else {
                    safeText(e.record, 'first meeting');
                }
                if (p.rival) {
                    safeText(e.rivalText,
                        `${p.rival.tier.toUpperCase()}  -  Last: ${p.rival.lastResult || '?'}`);
                    e.rivalRow.style.display = '';
                } else {
                    e.rivalRow.style.display = 'none';
                }
                if (Array.isArray(p.recentGames) && p.recentGames.length > 0) {
                    renderScoutRecentGames(e.recentList, p.recentGames);
                    e.recentRow.style.display = '';
                } else {
                    e.recentRow.style.display = 'none';
                }
                if (p.bestAnswer) {
                    Icons.fillIconRow(e.ansIcons,
                        Icons.strategyIcons(p.bestAnswer.build, 2),
                        p.bestAnswer.build);
                    safeText(e.ansText,
                        `${p.bestAnswer.build}  ${p.bestAnswer.winRatePct}%`);
                    e.ansRow.style.display = '';
                } else {
                    e.ansRow.style.display = 'none';
                }
                if (p.cheese) {
                    const verb = p.cheese.result === 'Victory' ? 'You cheesed' : 'Cheesed you';
                    safeText(e.cheeseText,
                        `${verb} at ${p.cheese.durationText} on ${p.cheese.map}`);
                    e.cheeseRow.style.display = '';
                } else {
                    e.cheeseRow.style.display = 'none';
                }
                show(e.root);
            },
            hide() { hide(els.scout.root); }
        },

        // F5: Meta check
        metaCheck: {
            slot: 'top-right-2',
            defaultDurationMs: 12000,
            render(p) {
                const e = els.meta;
                safeText(e.strategy, p.strategy || '?');
                const total = Number.isFinite(p.sessionTotal) ? p.sessionTotal : null;
                const tail = total ? ` / ${total}` : '';
                safeText(e.count,
                    Number.isFinite(p.count) ? `x${p.count}${tail} this session` : '');
                Icons.fillIconRow(e.icons, Icons.strategyIcons(p.strategy, 2), p.strategy);
                show(e.root);
            },
            hide() { hide(els.meta.root); }
        }
    };

    socket.on('overlay_event', (envelope) => {
        if (!envelope || !envelope.type) return;
        console.log('[Overlay] Event:', envelope.type, envelope.payload);
        enqueue(envelope);

        // The opponent widget is persistent-during-game: render() keeps
        // it on screen until the game ends. Clear it the moment a
        // matchResult arrives (which marks the post-game state) so the
        // widget doesn't carry a stale opponent into the next pre-game.
        if (envelope.type === 'matchResult' && els.opponent && els.opponent.root) {
            try { hide(els.opponent.root); } catch (_) {}
        }
    });

    function renderSession(state) {
        const e = els.session;
        if (!state) return;
        // W-L and elapsed time render on the same row (see session.html).
        // MMR delta + current MMR render on a separate row underneath.
        // All three values are anchored in real SC2Pulse readings the
        // backend pulls in refreshMmrFromPulseAfterMatch(); we render
        // an em-dash placeholder until both anchors land.
        safeText(e.wl, `${state.wins}W - ${state.losses}L`);
        safeText(e.time, state.durationText || '0m');
        renderSessionMmr(state);
        const s = state.currentStreak || {};
        if (s.type === 'win' && s.count >= 2) {
            safeText(e.streak, `W${s.count}`);
            e.streak.className = 'session-streak win-streak';
            e.streak.style.display = '';
        } else if (s.type === 'loss' && s.count >= 2) {
            safeText(e.streak, `L${s.count}`);
            e.streak.className = 'session-streak loss-streak';
            e.streak.style.display = '';
        } else {
            e.streak.textContent = '';
            e.streak.style.display = 'none';
        }
        show(e.root);
    }

    function renderSessionMmr(state) {
        // Single large 'SERVER MMR' line (e.g., 'NA 4280'). Replaces
        // the older delta + current pair. The +/-1 session-delta UI
        // was removed because the player's current rating is the
        // stat that matters at a glance; session swing is implicit
        // in the W-L row above.
        const e = els.session;
        if (!e || !e.serverMmr) return;
        const current = Number(state.mmrCurrent);
        const hasCurrent = Number.isFinite(current);
        const region = (state.region || '').toString().trim();
        const hasRegion = region.length > 0;
        let label;
        if (hasRegion && hasCurrent) label = `${region} ${current}`;
        else if (hasCurrent)         label = String(current);
        else if (hasRegion)          label = `${region} —`;
        else                         label = '—';
        safeText(e.serverMmr, label);
        if (e.mmrRow) {
            e.mmrRow.dataset.state = (hasCurrent || hasRegion) ? 'ready' : 'empty';
        }
    }

    socket.on('session_state', renderSession);
    renderSession({ wins: 0, losses: 0, mmrDelta: 0, durationText: '0m', currentStreak: {} });
    // Immediate /api/session pull so the SERVER + MMR line populates
    // on first paint instead of waiting for the next 60s poll. The
    // backend also emits session_state on socket connect, but a stale
    // socket (e.g., overlay opened before the server is ready) would
    // otherwise leave the widget on '—' until the next tick.
    fetch(`${SERVER_URL}/api/session`).then(r => r.ok ? r.json() : null)
        .then(s => s && renderSession(s))
        .catch(() => {});

    // Live update of #opp-mmr when the backend resolves the
    // opponent's SC2Pulse rating AFTER the opponent widget is
    // already on screen. Avoids overwriting a known value with an
    // empty payload.
    socket.on('opponentMmrUpdate', (payload) => {
        if (!payload || !Number.isFinite(payload.mmr)) return;
        const mmrEl = els.opponent && els.opponent.mmr;
        if (!mmrEl) return;
        safeText(mmrEl, `${payload.mmr} MMR`);
    });


    setInterval(() => {
        fetch(`${SERVER_URL}/api/session`).then(r => r.ok ? r.json() : null)
            .then(s => s && renderSession(s))
            .catch(() => {});
    }, 60000);

    // --------------------------------------------------------
    // #8 TOP-BUILDS PERSISTENT TILE GRID
    // --------------------------------------------------------
    const topBuildsRoot = document.getElementById('topbuilds-widget');
    const topBuildsGrid = document.getElementById('topbuilds-grid');

    function renderTopBuilds(builds) {
        if (!topBuildsGrid) return;
        topBuildsGrid.innerHTML = '';
        if (!builds || builds.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'topbuild-tile';
            empty.style.color = '#7b869e';
            empty.textContent = 'No games analyzed yet.';
            topBuildsGrid.appendChild(empty);
            show(topBuildsRoot);
            return;
        }
        for (const b of builds) {
            const tile = document.createElement('div');
            tile.className = 'topbuild-tile';

            const iconWrap = document.createElement('span');
            iconWrap.className = 'topbuild-icons';
            const ic = Icons.strategyIcons(b.name, 2);
            for (const u of ic) {
                const img = Icons.makeIconImg(u, b.name);
                if (img) iconWrap.appendChild(img);
            }
            tile.appendChild(iconWrap);

            const nameEl = document.createElement('span');
            nameEl.className = 'topbuild-name';
            nameEl.textContent = b.name;
            nameEl.title = b.name;
            tile.appendChild(nameEl);
            const recEl = document.createElement('span');
            recEl.className = 'topbuild-record';
            recEl.textContent = b.winRatePct + '%';
            recEl.style.color = b.winRatePct >= 50 ? '#00ff88' : '#ff3366';
            recEl.title = b.wins + 'W - ' + b.losses + 'L (' + b.games + ' games)';
            tile.appendChild(recEl);

            topBuildsGrid.appendChild(tile);
        }
        show(topBuildsRoot);
    }

    function refreshTopBuilds() {
        fetch(SERVER_URL + '/api/top-builds?limit=6')
            .then(r => r.ok ? r.json() : null)
            .then(j => j && renderTopBuilds(j.builds))
            .catch(() => {});
    }

    if (topBuildsRoot) {
        refreshTopBuilds();
        socket.on('overlay_event', (env) => {
            if (env && env.type === 'matchResult') setTimeout(refreshTopBuilds, 4000);
        });
        setInterval(refreshTopBuilds, 5 * 60 * 1000);
    }

})();
