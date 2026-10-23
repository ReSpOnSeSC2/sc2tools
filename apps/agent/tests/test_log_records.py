from sc2tools_agent.ui.log_records import LogRecord, matches, parse_chunk, read_tail


def test_tracebacks_and_partial_lines_stay_with_their_record():
    records, carry = parse_chunk("", "2026-10-23T12:00:00 ERROR upload failed\nTraceback:\n  File x\nVal")
    assert records == [LogRecord("ERROR", ["2026-10-23T12:00:00 ERROR upload failed", "Traceback:", "  File x"])]
    assert carry == "Val"
    more, carry = parse_chunk(carry, "ueError: bad\n2026-10-23T12:01:00 INFO recovered\n")
    assert more[0] == LogRecord(None, ["ValueError: bad"])
    assert more[1].level == "INFO"
    assert carry == ""
    assert matches(records[0], "Errors only")
    assert not matches(more[1], "Errors only")


def test_text_before_first_header_and_header_split_across_ticks():
    records, carry = parse_chunk("", "starting up\n2026-10-")
    assert records == [LogRecord(None, ["starting up"])]
    records, carry = parse_chunk(carry, "23T12:00:00 WARNING delayed\r\nwrapped json\r\n")
    assert records == [LogRecord("WARNING", ["2026-10-23T12:00:00 WARNING delayed", "wrapped json"])]
    assert matches(records[0], "warnings")
    assert carry == ""


def test_large_seed_and_wake_read_only_a_bounded_tail(tmp_path, monkeypatch):
    path = tmp_path / "agent.log"
    path.write_bytes((b"2026-10-23T12:00:00 INFO line\n" * 120000))
    real_open = type(path).open
    counts = []

    class Reader:
        def __init__(self, wrapped): self.wrapped = wrapped
        def __enter__(self): self.wrapped.__enter__(); return self
        def __exit__(self, *args): return self.wrapped.__exit__(*args)
        def __getattr__(self, name): return getattr(self.wrapped, name)
        def read(self, *args):
            data = self.wrapped.read(*args); counts.append(len(data)); return data
        def readline(self, *args):
            data = self.wrapped.readline(*args); counts.append(len(data)); return data

    monkeypatch.setattr(type(path), "open", lambda self, *args, **kwargs: Reader(real_open(self, *args, **kwargs)))
    data, offset, skipped, rotated = read_tail(path, 0, False)
    assert skipped and not rotated and offset == path.stat().st_size
    assert sum(counts) <= 300 * 1024
    assert data.startswith(b"2026-")
    counts.clear()
    _, _, skipped, _ = read_tail(path, 2, True)
    assert skipped and sum(counts) <= 300 * 1024
