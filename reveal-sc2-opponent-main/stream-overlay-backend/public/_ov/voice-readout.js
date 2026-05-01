/* ============================================================
 * SC2 Stream Overlay -- Voice Readout
 *
 * Speaks the scouting report aloud via the browser's Web Speech API
 * when a scoutingReport event fires. Reads its settings from
 * /api/config -> config.voice (managed by the analyzer's
 * Settings -> Voice readout tab). No API key, no audio downloads --
 * pure browser TTS so it works in OBS Browser Source and Streamlabs
 * Browser Source identically.
 *
 * Public surface (window.VoiceReadout):
 *   refreshConfig()                  -> re-fetch /api/config
 *   speakScoutingReport(payload)     -> speak this scouting card now
 *   onConfigChanged(cb)              -> register a config-update hook
 *   getConfig()                      -> current cached voice cfg
 *
 * The module is defensive: it never throws into the renderer, never
 * spams duplicate utterances for the same opponent, and silently
 * no-ops when the Web Speech API is unavailable.
 * ============================================================ */

(function () {
    'use strict';

    var VOICE_CONFIG_URL = '/api/config';
    var VOICE_REFRESH_INTERVAL_MS = 60000;

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

    function clamp(n, lo, hi) {
        if (typeof n !== 'number' || !isFinite(n)) return lo;
        if (n < lo) return lo;
        if (n > hi) return hi;
        return n;
    }

    function applyConfigPatch(raw) {
        if (!raw || typeof raw !== 'object') return;
        var v = raw.config && raw.config.voice;
        if (!v) return;
        cachedConfig = {
            enabled: v.enabled !== false,
            volume:  clamp(typeof v.volume   === 'number' ? v.volume   : DEFAULTS.volume,   0, 1),
            rate:    clamp(typeof v.rate     === 'number' ? v.rate     : DEFAULTS.rate,    0.5, 2),
            pitch:   clamp(typeof v.pitch    === 'number' ? v.pitch    : DEFAULTS.pitch,   0, 2),
            delay_ms: clamp(typeof v.delay_ms === 'number' ? v.delay_ms : DEFAULTS.delay_ms, 0, 5000),
            preferred_voice: typeof v.preferred_voice === 'string' ? v.preferred_voice : ''
        };
        configReady = true;
        configListeners.forEach(function (cb) {
            try { cb(cachedConfig); } catch (_) { /* never let a hook break the overlay */ }
        });
    }

    function refreshConfig() {
        if (typeof fetch !== 'function') return Promise.resolve();
        return fetch(VOICE_CONFIG_URL)
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(applyConfigPatch)
            .catch(function () { /* keep cached defaults */ });
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
        if (v) utter.voice = v;
    }

    function fingerprintPayload(p) {
        if (!p) return '';
        return [
            p.opponent || '',
            p.race || '',
            p.record ? p.record.total : 0
        ].join('|');
    }

    function speakScoutingReport(payload) {
        if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
        var cfg = cachedConfig;
        if (!cfg.enabled) return;
        var key = fingerprintPayload(payload);
        if (key && key === lastSpokenKey) return;
        lastSpokenKey = key;
        var text = buildScoutingReadoutText(payload);
        if (!text) return;
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        try { window.speechSynthesis.cancel(); } catch (_) {}
        pendingTimer = setTimeout(function () {
            pendingTimer = null;
            try {
                var utter = new window.SpeechSynthesisUtterance(text);
                applyVoiceSettings(utter, cfg);
                window.speechSynthesis.speak(utter);
            } catch (_) { /* never break the renderer */ }
        }, cfg.delay_ms);
    }

    function onConfigChanged(cb) {
        if (typeof cb === 'function') configListeners.push(cb);
    }

    function getConfig() {
        return Object.assign({}, cachedConfig);
    }

    // Initial fetch + lightweight refresh so saved config edits get
    // picked up without a full overlay reload. Web Speech voices may
    // load asynchronously; touch them once to prime the list.
    refreshConfig();
    setInterval(refreshConfig, VOICE_REFRESH_INTERVAL_MS);
    if (window.speechSynthesis && typeof window.speechSynthesis.getVoices === 'function') {
        try { window.speechSynthesis.getVoices(); } catch (_) {}
    }

    window.VoiceReadout = {
        refreshConfig: refreshConfig,
        speakScoutingReport: speakScoutingReport,
        onConfigChanged: onConfigChanged,
        getConfig: getConfig
    };

})();
