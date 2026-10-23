"""Local import throughput, with a five-minute time-weighted EWMA."""
from __future__ import annotations

import math
import time

EWMA_SECONDS = 5 * 60
ETA_MIN_SAMPLES = 3
ETA_MIN_SECONDS = 15
ETA_MIN_PROCESSED = 5


class ImportRate:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.previous = None
        self.rate = None
        self.samples = 0
        self.elapsed = 0
        self.processed = 0

    def observe(self, processed, remaining, *, active=True):
        now = self.clock()
        if self.previous is None or processed < self.previous[1]:
            self.previous = (now, processed)
            self.rate, self.samples, self.elapsed, self.processed = None, 0, 0, 0
        else:
            before, count = self.previous
            seconds = now - before
            if seconds > 0:
                delta = max(0, processed - count)
                self.previous = (now, processed)
                if active:
                    instant = delta / seconds
                    weight = 1 - math.exp(-seconds / EWMA_SECONDS)
                    self.rate = instant if self.rate is None else self.rate + weight * (instant - self.rate)
                    self.elapsed += seconds
                    self.processed += delta
                    if delta:
                        self.samples += 1
        rate = self.rate if active and self.rate and self.rate > 0 else None
        confident = self.samples >= ETA_MIN_SAMPLES and self.elapsed >= ETA_MIN_SECONDS and self.processed >= ETA_MIN_PROCESSED
        return {"ratePerMinute": rate * 60 if rate else None,
                "etaSeconds": math.ceil(max(0, remaining) / rate) if rate and confident else None}
