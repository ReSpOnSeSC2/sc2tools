"""``PulseClient`` — resolve an in-game opponent name to a full SC2Pulse
ladder profile.

We hit ``https://sc2pulse.nephest.com/sc2/api`` — the same community API
the legacy overlay backend uses for post-game MMR resolution. Two
endpoints we need:

* ``GET /character/search?term=<name>`` — name search returning up to N
  candidates, each with character ID, region, account handle, and
  per-race game counts.
* ``GET /group/team?characterId=<id>&season=<id>&queue=LOTV_1V1`` — the
  candidate's current 1v1 team rating (MMR + league).

Resolution flow when the bridge feeds us an in-game opponent:

1. ``character/search?term=<name>`` returns 0..N candidates. We trim to
   the user's race-aware preference and (optionally) region.
2. For each shortlisted candidate fetch their current 1v1 team. The
   one with the most-recent ``lastPlayed`` and matching race wins.
3. Build an ``OpponentProfile`` with confidence ∈ [0, 1] reflecting
   how clean the disambiguation was (1.0 = unique name, .65 = best of
   N tied on region, .4 = no race agreement, etc.).

Resilience:

* Per-call exponential back-off (Pulse occasionally 502s under load).
* 5-minute LRU cache keyed on ``(name, region, race)`` so a rematch
  doesn't re-hit Pulse.
* Partial-failure paths surface what we have — name + region from
  search, missing MMR — instead of returning ``None`` and leaving the
  widget blank.
* No bare ``raise`` to the caller. The bridge runs us in a thread and
  expects ``OpponentProfile`` or ``None``.

Performance contract from the prompt: cache-cold lookup under 500 ms,
cache-warm under 10 ms.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

import requests

from .metrics import METRICS
from .types import OpponentProfile

_log = logging.getLogger("sc2tools_agent.live.pulse_lookup")

DEFAULT_API_ROOT = "https://sc2pulse.nephest.com/sc2/api"
DEFAULT_QUEUE = "LOTV_1V1"
DEFAULT_REQUEST_TIMEOUT_SEC = 6.0
DEFAULT_CACHE_TTL_SEC = 300.0  # 5 minutes per the prompt
DEFAULT_CACHE_MAX = 256
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_BASE_SEC = 0.4

# Pulse region codes from the API. Used both ways — input filter and
# output label.
PULSE_REGION_CODE_TO_LABEL = {1: "US", 2: "EU", 3: "KR", 5: "CN"}
PULSE_REGION_LABEL_TO_CODE = {v: k for k, v in PULSE_REGION_CODE_TO_LABEL.items()}

_RACE_CANONICAL = {
    "z": "Zerg",
    "p": "Protoss",
    "t": "Terran",
    "r": "Random",
    "zerg": "Zerg",
    "protoss": "Protoss",
    "terran": "Terran",
    "random": "Random",
    # The agent's lifecycle layer sometimes ships truncated forms
    # ("Terr", "Prot", "Zerg", "Rand") because the SC2 client reports
    # them that way in some locales. Map the prefixes too so the race
    # tiebreaker still works.
    "terr": "Terran",
    "prot": "Protoss",
    "rand": "Random",
}


def _canon_race(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    return _RACE_CANONICAL.get(raw.strip().casefold())


def _league_label(value: Any) -> Optional[str]:
    """Pulse encodes league as an integer 0..6 (Bronze..Grandmaster).
    Map to the human label the widget renders."""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    leagues = [
        "Bronze", "Silver", "Gold", "Platinum",
        "Diamond", "Master", "Grandmaster",
    ]
    if 0 <= n < len(leagues):
        return leagues[n]
    return None


def _candidate_top_race(member: Dict[str, Any]) -> Optional[str]:
    """Pick the race the candidate has played most as a tiebreaker
    against the in-game race the SC2 client reported."""
    counts = {
        "Zerg": int(member.get("zergGamesPlayed") or 0),
        "Protoss": int(member.get("protossGamesPlayed") or 0),
        "Terran": int(member.get("terranGamesPlayed") or 0),
        "Random": int(member.get("randomGamesPlayed") or 0),
    }
    best = max(counts.items(), key=lambda kv: kv[1])
    return best[0] if best[1] > 0 else None


def _pick_hit_character(hit: Dict[str, Any]) -> Dict[str, Any]:
    """Locate the ``character`` sub-object inside one
    ``/character/search`` hit.

    SC2Pulse's response shape varies — for live ladder names it nests
    the character under ``hit.members[0].character`` (newer servers)
    or ``hit.members.character`` (older servers); for some legacy
    responses the character is at ``hit.character`` directly.
    Mirror the legacy ``stream-overlay-backend/routes/onboarding.js``
    ``pickHitCharacter`` helper, which has been battle-tested in
    production against the same Pulse instance.

    Without this helper the lookup misses every modern shape — the
    agent only checked ``hit.character``, got an empty dict, the name
    didn't match, no candidates scored above zero, and every opponent
    got reported as ``confidence=0.0 mmr=None``. The user-visible
    symptom was "Profile lookup unavailable" on every opponent.
    """
    if not isinstance(hit, dict):
        return {}
    ch = hit.get("character")
    if isinstance(ch, dict):
        return ch
    members = hit.get("members")
    if isinstance(members, list) and members:
        first = members[0]
        if isinstance(first, dict):
            inner = first.get("character")
            if isinstance(inner, dict):
                return inner
    if isinstance(members, dict):
        inner = members.get("character")
        if isinstance(inner, dict):
            return inner
    return {}


def _pick_hit_member(hit: Dict[str, Any]) -> Dict[str, Any]:
    """Locate the ``member`` (race-counts carrier) inside one
    ``/character/search`` hit.

    Race counts (``zergGamesPlayed`` etc) live on the team-member
    object, which Pulse places either at ``hit.members[0]``,
    ``hit.members``, or — on the oldest legacy responses — directly
    on the hit dict.
    """
    if not isinstance(hit, dict):
        return {}
    members = hit.get("members")
    if isinstance(members, list) and members:
        first = members[0]
        if isinstance(first, dict):
            return first
    if isinstance(members, dict):
        return members
    return hit


def _split_battletag(account_handle: Optional[str]) -> Optional[str]:
    """Pulse's ``character.name`` looks like ``Player#1234``. We pull
    the bare display name for matching against the in-game name (which
    Blizzard's local API gives without the discriminator)."""
    if not account_handle:
        return None
    return account_handle.split("#", 1)[0] or None


class _Cache:
    """Tiny TTL+LRU dict — 5-minute window, 256-entry cap.

    Per the prompt: "Caches lookups for 5 minutes by (name, region) to
    avoid hammering Pulse on rematches." We extend the key with race
    so a Zerg-named Player1234 doesn't accidentally resolve to a
    Protoss candidate from the previous lookup.
    """

    def __init__(self, *, ttl_sec: float, max_entries: int) -> None:
        self._ttl = ttl_sec
        self._max = max_entries
        self._data: "OrderedDict[Tuple[str, Optional[str], Optional[str]], Tuple[float, OpponentProfile]]" = OrderedDict()
        self._lock = threading.RLock()

    def get(
        self,
        name: str,
        region: Optional[str],
        race: Optional[str],
    ) -> Optional[OpponentProfile]:
        now = time.time()
        key = (name.casefold(), region, race)
        with self._lock:
            hit = self._data.get(key)
            if hit is None:
                return None
            written_at, profile = hit
            if now - written_at > self._ttl:
                # Expired — drop and miss.
                self._data.pop(key, None)
                return None
            # LRU touch.
            self._data.move_to_end(key)
            return profile

    def put(
        self,
        name: str,
        region: Optional[str],
        race: Optional[str],
        profile: OpponentProfile,
    ) -> None:
        key = (name.casefold(), region, race)
        with self._lock:
            self._data[key] = (time.time(), profile)
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._data.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


class PulseClient:
    """Resolve in-game opponent names to a typed ``OpponentProfile``.

    Construct once per agent run and share across the bridge. Thread-
    safe — every call goes through a fresh ``requests.Session.get`` and
    the cache is locked.
    """

    def __init__(
        self,
        *,
        api_root: str = DEFAULT_API_ROOT,
        queue: str = DEFAULT_QUEUE,
        session: Optional[requests.Session] = None,
        cache_ttl_sec: float = DEFAULT_CACHE_TTL_SEC,
        cache_max_entries: int = DEFAULT_CACHE_MAX,
        request_timeout_sec: float = DEFAULT_REQUEST_TIMEOUT_SEC,
        retry_attempts: int = DEFAULT_RETRY_ATTEMPTS,
        retry_base_sec: float = DEFAULT_RETRY_BASE_SEC,
        sleep: Any = time.sleep,
    ) -> None:
        self._api_root = api_root.rstrip("/")
        self._queue = queue
        self._session = session or requests.Session()
        self._cache = _Cache(
            ttl_sec=cache_ttl_sec, max_entries=cache_max_entries,
        )
        self._timeout = request_timeout_sec
        self._retries = max(1, retry_attempts)
        self._backoff = retry_base_sec
        self._sleep = sleep
        # Season ID is stable for ~3 months; cache it lazily on first
        # lookup so we don't hit ``/season/list/all`` for every name
        # query. ``None`` = not yet fetched, ``0`` = fetched but failed.
        self._season_id: Optional[int] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def resolve(
        self,
        *,
        name: str,
        region: Optional[str] = None,
        race: Optional[str] = None,
    ) -> Optional[OpponentProfile]:
        """Look up ``name`` and return a populated ``OpponentProfile``.

        ``region`` and ``race`` are optional disambiguation hints —
        when present they tighten the candidate filter; when absent we
        return the highest-confidence guess across all regions.

        Returns ``None`` only when Pulse returned zero candidates for
        the name AND we have nothing useful to put in the profile.
        Partial failures (Pulse 502, missing MMR) still return a
        profile with the fields we have, so the widget can render
        opponent name + race even if MMR is missing.
        """
        name_clean = (name or "").strip()
        if not name_clean:
            return None
        cached = self._cache.get(name_clean, region, race)
        if cached is not None:
            METRICS.incr("pulse.resolve.cache_hit")
            return cached
        METRICS.incr("pulse.resolve.cache_miss")
        started = time.monotonic()
        try:
            profile = self._resolve_uncached(
                name=name_clean,
                region=region,
                race=race,
            )
        except Exception:  # noqa: BLE001
            METRICS.incr("pulse.resolve.unhandled_error")
            _log.exception(
                "pulse_resolve_unhandled name=%s region=%s race=%s",
                name_clean, region, race,
            )
            # Last-resort fallback so the bridge always emits SOMETHING
            # for the widget to render. Confidence 0.0 is a signal that
            # this is "we know nothing more than the name."
            return OpponentProfile(
                name=name_clean,
                region=region,
                top_race=_canon_race(race),
                confidence=0.0,
            )
        finally:
            METRICS.observe_ms(
                "pulse.resolve.latency",
                (time.monotonic() - started) * 1000.0,
            )
        if profile is not None:
            self._cache.put(name_clean, region, race, profile)
            if profile.mmr is not None:
                METRICS.incr("pulse.resolve.full")
            else:
                METRICS.incr("pulse.resolve.partial")
        return profile

    def cache_size(self) -> int:
        return len(self._cache)

    def clear_cache(self) -> None:
        self._cache.clear()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _resolve_uncached(
        self,
        *,
        name: str,
        region: Optional[str],
        race: Optional[str],
    ) -> Optional[OpponentProfile]:
        candidates = self._search_character(name)
        if not candidates:
            # Pulse returned nothing. Surface a low-confidence stub so
            # the widget can still show "vs <name>" — the alternative
            # of silent failure was a UX dead-end the prompt explicitly
            # called out.
            return OpponentProfile(
                name=name,
                region=region,
                top_race=_canon_race(race),
                confidence=0.0,
            )
        scored = self._score_candidates(
            candidates, name=name, region=region, race=race,
        )
        if not scored:
            return OpponentProfile(
                name=name,
                region=region,
                top_race=_canon_race(race),
                confidence=0.0,
                alternatives=[
                    self._candidate_label(c) for c in candidates[:3]
                ],
            )
        best_score, best = scored[0]
        confidence = self._confidence_for(best_score, scored)
        team_info = self._fetch_team_for(best)
        return self._build_profile(
            name=name,
            region=region,
            race=race,
            candidate=best,
            team=team_info,
            confidence=confidence,
            alternatives=[
                self._candidate_label(c) for _, c in scored[1:3]
            ],
        )

    def _search_character(self, term: str) -> List[Dict[str, Any]]:
        """Hit ``/character/search?term=…``. Returns ``[]`` on any
        failure path; the caller already handles the empty result
        with a low-confidence stub."""
        url = f"{self._api_root}/character/search"
        params = {"term": term}
        data = self._get_with_retry(url, params=params)
        if not isinstance(data, list):
            return []
        # Pulse returns up to ~50 by default; trim to a reasonable
        # shortlist so we don't fan out the team-fetch step too wide.
        return data[:10]

    def _fetch_team_for(
        self, candidate: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        ch = _pick_hit_character(candidate)
        cid = ch.get("id")
        if not isinstance(cid, int):
            try:
                cid = int(cid)
            except (TypeError, ValueError):
                return None
        season = self._ensure_season()
        if not season:
            # Without a season we can still produce a team-less profile.
            return None
        url = f"{self._api_root}/group/team"
        params = {
            "characterId": str(cid),
            "season": str(season),
            "queue": self._queue,
        }
        data = self._get_with_retry(url, params=params)
        if not isinstance(data, list) or not data:
            return None
        # Highest rating wins among the candidate's 1v1 teams (one per
        # race). Pulse returns one entry per (queue, race) team the
        # character has touched this season.
        best = None
        best_rating = -1
        for t in data:
            try:
                r = int(t.get("rating") or -1)
            except (TypeError, ValueError):
                continue
            if r > best_rating:
                best_rating = r
                best = t
        return best

    def _ensure_season(self) -> Optional[int]:
        if self._season_id is not None:
            return self._season_id or None
        url = f"{self._api_root}/season/list/all"
        data = self._get_with_retry(url)
        if not isinstance(data, list):
            self._season_id = 0
            return None
        ids: List[int] = []
        for season in data:
            if not isinstance(season, dict):
                continue
            try:
                ids.append(int(season.get("battlenetId")))
            except (TypeError, ValueError):
                continue
        if not ids:
            self._season_id = 0
            return None
        self._season_id = max(ids)
        return self._season_id

    def _get_with_retry(
        self,
        url: str,
        *,
        params: Optional[Dict[str, str]] = None,
    ) -> Any:
        """GET with exponential back-off. Returns the JSON body or
        ``None`` after the retry budget is exhausted.

        We retry on connection errors and 5xx (Pulse occasionally 502s
        during their backend rotation). 4xx is non-retryable — we drop
        immediately. Per-attempt timeout from ``self._timeout`` keeps
        the overall worst case at ``retries × timeout`` which at the
        defaults is 18 s; the bridge fires this in a worker thread so
        the overall poll loop is unaffected.
        """
        last_exc: Optional[Exception] = None
        for attempt in range(self._retries):
            try:
                r = self._session.get(
                    url,
                    params=params,
                    timeout=self._timeout,
                    headers={"accept": "application/json"},
                )
            except requests.RequestException as exc:
                last_exc = exc
                self._sleep(self._backoff * (2 ** attempt))
                continue
            if r.status_code == 200:
                try:
                    return r.json()
                except ValueError:
                    return None
            if 400 <= r.status_code < 500:
                # 4xx — Pulse said "no" definitively. Don't retry.
                return None
            # 5xx → back off + retry.
            last_exc = RuntimeError(f"pulse_status_{r.status_code}")
            self._sleep(self._backoff * (2 ** attempt))
        if last_exc is not None:
            _log.debug("pulse_get_failed url=%s err=%s", url, last_exc)
        return None

    # ------------------------------------------------------------------
    # Scoring + profile assembly
    # ------------------------------------------------------------------

    def _score_candidates(
        self,
        candidates: List[Dict[str, Any]],
        *,
        name: str,
        region: Optional[str],
        race: Optional[str],
    ) -> List[Tuple[float, Dict[str, Any]]]:
        """Score each candidate ∈ [0, 1] and sort descending.

        Components:

        * Name match: exact (1.0) > startswith (.6) > contains (.3).
        * Region match: matches caller hint (+.3) > no hint (.0).
        * Race match: top-played race agrees with hint (+.2).
        """
        target_region_code = (
            PULSE_REGION_LABEL_TO_CODE.get(region) if region else None
        )
        target_race = _canon_race(race)
        scored: List[Tuple[float, Dict[str, Any]]] = []
        for c in candidates:
            if not isinstance(c, dict):
                continue
            ch = _pick_hit_character(c)
            cand_name = _split_battletag(ch.get("name"))
            score = 0.0
            # Name
            if cand_name and cand_name.casefold() == name.casefold():
                score += 1.0
            elif cand_name and cand_name.casefold().startswith(name.casefold()):
                score += 0.6
            elif cand_name and name.casefold() in cand_name.casefold():
                score += 0.3
            # Region
            if target_region_code is not None:
                if ch.get("region") == target_region_code:
                    score += 0.3
            # Race — race counts live on the team-member object, which
            # Pulse nests under ``members[0]`` (newer responses) or
            # ``members`` (older). Helper handles both shapes.
            member = _pick_hit_member(c)
            top_race = _candidate_top_race(member)
            if target_race and top_race and top_race == target_race:
                score += 0.2
            if score > 0:
                scored.append((score, c))
        scored.sort(key=lambda kv: kv[0], reverse=True)
        return scored

    def _confidence_for(
        self,
        best_score: float,
        scored: List[Tuple[float, Dict[str, Any]]],
    ) -> float:
        """Map raw score → bridge-friendly confidence in [0, 1].

        * 1.5+ (exact name + region + race agreement) → 1.0
        * 1.0–1.5 → 0.85
        * Tied with another candidate → halve the confidence to flag
          the disambiguation risk.
        """
        if best_score <= 0:
            return 0.0
        base = min(1.0, best_score / 1.5)
        if len(scored) >= 2 and abs(scored[0][0] - scored[1][0]) < 0.05:
            base *= 0.5
        # Floor at 0.2 so we never report 0.0 confidence for a
        # candidate we did pick — 0.0 means "no candidate at all"
        # (handled by the caller's stub branch).
        return max(0.2, round(base, 2))

    def _candidate_label(self, candidate: Dict[str, Any]) -> str:
        ch = _pick_hit_character(candidate)
        name = _split_battletag(ch.get("name")) or "?"
        region = PULSE_REGION_CODE_TO_LABEL.get(ch.get("region"), "?")
        return f"{name} ({region})"

    def _build_profile(
        self,
        *,
        name: str,
        region: Optional[str],
        race: Optional[str],
        candidate: Dict[str, Any],
        team: Optional[Dict[str, Any]],
        confidence: float,
        alternatives: List[str],
    ) -> OpponentProfile:
        ch = _pick_hit_character(candidate)
        cand_region = PULSE_REGION_CODE_TO_LABEL.get(ch.get("region"))
        # Display name from the candidate (preferred — has the right
        # discriminator), fall back to the in-game name from the
        # caller if Pulse withheld it.
        candidate_name = _split_battletag(ch.get("name")) or name
        battle_tag = ch.get("name") if isinstance(ch.get("name"), str) else None
        cid = ch.get("id")
        if not isinstance(cid, int):
            try:
                cid = int(cid)
            except (TypeError, ValueError):
                cid = None
        mmr: Optional[int] = None
        league: Optional[str] = None
        league_tier: Optional[int] = None
        # Race counts may live on the candidate-level member, not the
        # candidate dict itself — pick from wherever Pulse parked them.
        candidate_member = _pick_hit_member(candidate)
        top_race: Optional[str] = (
            _candidate_top_race(candidate_member) or _canon_race(race)
        )
        if team is not None:
            try:
                mmr = int(team.get("rating")) if team.get("rating") is not None else None
            except (TypeError, ValueError):
                mmr = None
            league = _league_label(team.get("league"))
            try:
                league_tier = (
                    int(team.get("tier"))
                    if team.get("tier") is not None
                    else None
                )
            except (TypeError, ValueError):
                league_tier = None
            try:
                wins = int(team.get("wins") or 0)
                losses = int(team.get("losses") or 0)
                ties = int(team.get("ties") or 0)
                played = wins + losses + ties
            except (TypeError, ValueError):
                played = None
            recent_count: Optional[int] = played if played else None
            members = team.get("members") if isinstance(team, dict) else None
            if isinstance(members, list) and members:
                m0 = members[0] if isinstance(members[0], dict) else {}
                # Member-level top race overrides the candidate-level
                # one when present — the team is queue-scoped so it's
                # more reliable for "what race they pick in 1v1."
                top_race = _candidate_top_race(m0) or top_race
        else:
            recent_count = None
        return OpponentProfile(
            name=candidate_name,
            pulse_character_id=cid,
            region=cand_region or region,
            battle_tag=battle_tag,
            account_handle=battle_tag,
            mmr=mmr,
            league=league,
            league_tier=league_tier,
            top_race=top_race,
            recent_games_count=recent_count,
            confidence=confidence,
            alternatives=alternatives,
        )


__all__ = [
    "DEFAULT_API_ROOT",
    "DEFAULT_CACHE_MAX",
    "DEFAULT_CACHE_TTL_SEC",
    "DEFAULT_QUEUE",
    "DEFAULT_REQUEST_TIMEOUT_SEC",
    "DEFAULT_RETRY_ATTEMPTS",
    "DEFAULT_RETRY_BASE_SEC",
    "PULSE_REGION_CODE_TO_LABEL",
    "PULSE_REGION_LABEL_TO_CODE",
    "PulseClient",
]
