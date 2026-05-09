/* ============================================================
 * SC2 Stream Overlay -- Voice Readout
 *
 * Speaks the scouting report aloud via the browser's Web Speech API
 * when a scoutingReport event fires. Reads its settings from
 * /api/config -> config.voice (managed by the analyzer's
 * Settings -> Voice readout tab).
 *
 * Every important step logs to console under "[VoiceReadout]" so DevTools
 * can show why nothing spoke, instead of silently swallowing failures.
 * Set window.VoiceReadout.verbose = false to mute.
 *
 * Public surface (window.VoiceReadout):
 *   refreshConfig()                  -> re-fetch /api/config
 *   speakScoutingReport(payload)     -> speak this scouting card now
 *   onConfigChanged(cb)              -> register a config-update hook
 *   getConfig()                      -> current cached voice cfg
 *   diag()                           -> dump diagnostic state to console
 *   verbose                          -> set false to mute info logs
 * ============================================================ */

(function () {
    'use strict';

    var VOICE_CONFIG_URL = '/api/config';
    var VOICE_REFRESH_INTERVAL_MS = 60000;
    var LOG_PREFIX = '[VoiceReadout]';

    var DEFAULTS = {
        enabled: true,
        volume: 1.0,
        rate: 0.95,
        pitch: 1.0,
        delay_ms: 600,
        preferred_voice: ''
    };

    var cachedConfig = Object.assign({}, DEFAULTS);
    var configReady = false;
    var lastSpokenKey = null;
    var configListeners = [];
    var pendingTimer = null;
    var primed = false;
    var verbose = true;

    function info() {
        if (!verbose) return;
        var args = Array.prototype.slice.call(arguments);
        args.unshift(LOG_PREFIX);
        try { console.info.apply(console, args); } catch (_) {}
    }

    function warn() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(LOG_PREFIX);
        try { console.warn.apply(console, args); } catch (_) {}
    }

    function clamp(n, lo, hi) {
        if (typeof n !== 'number' || !isFinite(n)) return lo;
        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
    }

    function applyConfigPatch(raw) {
        if (!raw || typeof raw !== 'object') {
            warn('config fetch returned non-object; using defaults');
            return;
        }
        var v = raw.config && raw.config.voice;
        if (!v) {
            warn('config.voice missing from /api/config response; using defaults', raw);
            return;
        }
        cachedConfig = {
            enabled: v.enabled !== false,
            volume:  clamp(typeof v.volume   === 'number' ? v.volume   : DEFAULTS.volume,   0, 1),
            rate:    clamp(typeof v.rate     === 'number' ? v.rate     : DEFAULTS.rate,    0.5, 2),
            pitch:   clamp(typeof v.pitch    === 'number' ? v.pitch    : DEFAULTS.pitch,   0, 2),
            delay_ms: clamp(typeof v.delay_ms === 'number' ? v.delay_ms : DEFAULTS.delay_ms, 0, 5000),
            preferred_voice: typeof v.preferred_voice === 'string' ? v.preferred_voice : ''
        };
        configReady = true;
        info('config loaded', cachedConfig);
        configListeners.forEach(function (cb) {
            try { cb(cachedConfig); } catch (e) { warn('config listener threw', e); }
        });
    }

    function refreshConfig() {
        if (typeof fetch !== 'function') {
            warn('fetch() not available; cannot load config');
            return Promise.resolve();
        }
        return fetch(VOICE_CONFIG_URL)
            .then(function (r) {
                if (!r.ok) {
                    warn('GET ' + VOICE_CONFIG_URL + ' returned ' + r.status);
                    return null;
                }
                return r.json();
            })
            .then(applyConfigPatch)
            .catch(function (err) { warn('config fetch failed', err); });
    }

    function selectVoice(name) {
        if (!name || !window.speechSynthesis) return null;
        var list = window.speechSynthesis.getVoices() || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name) return list[i];
        }
        return null;
    }

    function buildOpponentLine(p) {
        var name = (p && p.opponent) ? String(p.opponent) : 'Unknown';
        var race = (p && p.race) ? String(p.race) : '';
        if (race) return 'Facing ' + name + ', ' + race + '.';
        return 'Facing ' + name + '.';
    }

    function buildRecordLine(p) {
        var r = p && p.record;
        if (!r || !r.total) return 'First meeting.';
        var wins = Number(r.wins) || 0;
        var losses = Number(r.losses) || 0;
        var pct = Math.round(Number(r.winRate) || 0);
        return "You're " + wins + ' and ' + losses + ' against them, '
            + pct + ' percent win rate.';
    }

    function buildRivalLine(p) {
        if (!p || !p.rival || !p.rival.tier) return '';
        var tier = String(p.rival.tier).toLowerCase();
        return 'They are your ' + tier + '.';
    }

    function buildCheeseLine(p) {
        if (!p || !p.cheese) return '';
        var verb = p.cheese.result === 'Victory'
            ? 'You cheesed them at '
            : 'Cheese warning. They got you at ';
        var when = p.cheese.durationText || 'an early timing';
        return verb + when + '.';
    }

    function buildAnswerLine(p) {
        var a = p && p.bestAnswer;
        if (!a || !a.build) return '';
        var pct = Math.round(Number(a.winRatePct) || 0);
        if (!pct) return 'Best answer is ' + a.build + '.';
        return 'Best answer is ' + a.build + '. ' + pct + ' percent win rate.';
    }

    function buildScoutingReadoutText(p) {
        var parts = [
            buildOpponentLine(p),
            buildRecordLine(p),
            buildRivalLine(p),
            buildCheeseLine(p),
            buildAnswerLine(p)
        ];
        return parts.filter(function (s) { return !!s; }).join(' ');
    }

    function applyVoiceSettings(utter, cfg) {
        utter.volume = cfg.volume;
        utter.rate = cfg.rate;
        utter.pitch = cfg.pitch;
        var v = selectVoice(cfg.preferred_voice);
        if (v) {
            utter.voice = v;
            // Chromium ignores .voice if .lang doesn't match the voice's lang;
            // setting both ensures the user's selection actually plays.
            utter.lang = v.lang || 'en-US';
            info('using voice: ' + v.name + ' (' + v.lang + ')');
        } else if (cfg.preferred_voice) {
            warn('preferred voice "' + cfg.preferred_voice + '" not found; falling back to default');
        }
    }

    function fingerprintPayload(p) {
        if (!p) return '';
        return [
            p.opponent || '',
            p.race || '',
            p.record ? p.record.total : 0
        ].join('|');
    }

    var gestureGranted = false;
    var pendingPayload = null;

    var BANNER_ID = 'voice-readout-gesture-banner';
    var BANNER_CSS = 'position:fixed;bottom:16px;right:16px;'
        + 'background:rgba(20,30,50,0.92);color:#fff;'
        + 'padding:10px 16px;border-radius:8px;'
        + 'border:1px solid #5b8def;'
        + 'font-family:system-ui,-apple-system,sans-serif;'
        + 'font-size:13px;cursor:pointer;z-index:99999;'
        + 'box-shadow:0 4px 12px rgba(0,0,0,0.4);'
        + 'pointer-events:auto;user-select:none;'
        + 'transition:opacity 0.2s;';

    function showGestureBanner() {
        if (typeof document === 'undefined' || !document.body) return;
        if (document.getElementById(BANNER_ID)) return;
        var el = document.createElement('div');
        el.id = BANNER_ID;
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.style.cssText = BANNER_CSS;
        el.textContent = String.fromCharCode(0x1F50A)
            + ' Click anywhere to enable voice readout';
        document.body.appendChild(el);
    }

    function hideGestureBanner() {
        if (typeof document === 'undefined') return;
        var el = document.getElementById(BANNER_ID);
        if (el && el.parentNode) el.parentNode.removeChild(el);
    }

    function onFirstGesture() {
        if (gestureGranted) return;
        gestureGranted = true;
        info('user gesture detected; speech unblocked');
        document.removeEventListener('click', onFirstGesture, true);
        document.removeEventListener('keydown', onFirstGesture, true);
        document.removeEventListener('touchstart', onFirstGesture, true);
        hideGestureBanner();
        if (pendingPayload) {
            var p = pendingPayload;
            pendingPayload = null;
            speakScoutingReport(p);
        }
    }

    function attachGestureListeners() {
        if (typeof document === 'undefined') return;
        document.addEventListener('click', onFirstGesture, true);
        document.addEventListener('keydown', onFirstGesture, true);
        document.addEventListener('touchstart', onFirstGesture, true);
    }

    function primeOnce() {
        if (primed) return;
        if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
        try {
            var u = new window.SpeechSynthesisUtterance('');
            u.volume = 0;
            window.speechSynthesis.speak(u);
            primed = true;
            info('primed speech engine');
        } catch (e) {
            warn('priming speak failed', e);
        }
    }

    function speakScoutingReport(payload) {
        info('speakScoutingReport called with', payload);
        if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
            warn('Web Speech API not available in this browser context');
            return;
        }
        var cfg = cachedConfig;
        if (!cfg.enabled) {
            info('voice readout disabled in config; skipping');
            return;
        }
        if (!gestureGranted) {
            info('gesture not granted yet; queueing payload and showing banner');
            pendingPayload = payload;
            showGestureBanner();
            return;
        }
        var key = fingerprintPayload(payload);
        if (key && key === lastSpokenKey) {
            info('payload fingerprint matches last spoken; suppressing duplicate');
            return;
        }
        var text = buildScoutingReadoutText(payload);
        if (!text) {
            warn('readout text was empty; nothing to speak');
            return;
        }
        info('readout text: "' + text + '"');
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        try { window.speechSynthesis.cancel(); } catch (_) {}
        primeOnce();
        pendingTimer = setTimeout(function () {
            pendingTimer = null;
            try {
                var utter = new window.SpeechSynthesisUtterance(text);
                applyVoiceSettings(utter, cfg);
                utter.onstart = function () {
                    info('utterance started speaking');
                    lastSpokenKey = key;
                };
                utter.onend = function () { info('utterance finished'); };
                utter.onerror = function (ev) {
                    var code = ev && ev.error ? ev.error : 'unknown';
                    warn('utterance error: ' + code);
                    lastSpokenKey = null;
                    if (code === 'not-allowed') {
                        gestureGranted = false;
                        attachGestureListeners();
                        pendingPayload = payload;
                        showGestureBanner();
                    }
                };
                window.speechSynthesis.speak(utter);
                info('speak() called');
            } catch (e) { warn('speak() threw', e); }
        }, cfg.delay_ms);
    }

    function onConfigChanged(cb) {
        if (typeof cb === 'function') configListeners.push(cb);
    }

    function getConfig() {
        return Object.assign({}, cachedConfig);
    }

    function diag() {
        var voices = (window.speechSynthesis && window.speechSynthesis.getVoices)
            ? window.speechSynthesis.getVoices() : [];
        var summary = {
            speechSynthesisAvailable: !!window.speechSynthesis,
            speechSynthesisUtteranceAvailable: !!window.SpeechSynthesisUtterance,
            speechSynthesisSpeaking: window.speechSynthesis ? window.speechSynthesis.speaking : null,
            speechSynthesisPaused: window.speechSynthesis ? window.speechSynthesis.paused : null,
            voicesLoaded: voices.length,
            voicesSample: voices.slice(0, 5).map(function (v) { return v.name + ' (' + v.lang + ')'; }),
            preferredVoiceMatch: !!selectVoice(cachedConfig.preferred_voice),
            configReady: configReady,
            cachedConfig: cachedConfig,
            lastSpokenKey: lastSpokenKey,
            primed: primed
        };
        info('diag', summary);
        return summary;
    }

    info('voice-readout.js loaded');

    attachGestureListeners();
    refreshConfig();
    setInterval(refreshConfig, VOICE_REFRESH_INTERVAL_MS);
    if (window.speechSynthesis && typeof window.speechSynthesis.getVoices === 'function') {
        try { window.speechSynthesis.getVoices(); } catch (_) {}
    }
    if (window.speechSynthesis && typeof window.speechSynthesis.addEventListener === 'function') {
        try {
            window.speechSynthesis.addEventListener('voiceschanged', function () {
                var n = (window.speechSynthesis.getVoices() || []).length;
                info('voiceschanged: ' + n + ' voices now available');
            });
        } catch (_) {}
    }

    Object.defineProperty(window, 'VoiceReadout', {
        configurable: true,
        value: {
            refreshConfig: refreshConfig,
            speakScoutingReport: speakScoutingReport,
            clearLastSpoken: function () { lastSpokenKey = null; info('lastSpokenKey cleared'); },
            onConfigChanged: onConfigChanged,
            getConfig: getConfig,
            diag: diag,
            get verbose() { return verbose; },
            set verbose(v) { verbose = !!v; }
        }
    });

})();
