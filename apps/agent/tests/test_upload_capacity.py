import importlib
import json
from unittest.mock import MagicMock

import pytest

client = importlib.import_module('sc2tools_agent.api_client')
wire = importlib.import_module('sc2tools_agent.upload_json')

def response(status,payload):
    value=MagicMock(status_code=status,headers={})
    value.json.return_value=payload
    value.text=json.dumps(payload)
    return value

def test_lossless_numeric_canonical_wire_and_exact_budget():
    value={'gameId':'g', 'x':[2.0,.125,True,None], 'name':'\u03a9'}
    data=wire.compact_json_bytes(value)
    assert b'2.0' not in data
    assert json.loads(data)==value
    budget=wire.playback_byte_budget(value)
    assert budget+len(wire.compact_json_bytes({'games':[dict(value,mapPlayback=None)]}))-4==wire.GAME_BODY_MAX_BYTES

def test_nonfinite_rejected():
    with pytest.raises(ValueError):
        wire.compact_json_bytes({'x':float('nan')})

def test_http_uses_exact_checked_wire_bytes(monkeypatch):
    mocked=MagicMock(return_value=response(202,{'accepted':[{'gameId':'g'}]}))
    monkeypatch.setattr(client.requests,'request',mocked)
    body={'gameId':'g','x':[2.0,.125]}
    client.ApiClient('https://example.invalid','secret').upload_game(body)
    kwargs=mocked.call_args.kwargs
    assert 'json' not in kwargs
    assert kwargs['data']==wire.compact_json_bytes(body)
    assert kwargs['headers']['content-type']=='application/json'

def test_chunked_requests_fit_and_account_for_every_game(monkeypatch):
    monkeypatch.setattr(client,'GAME_BODY_MAX_BYTES',180)
    sent=[]
    def post(*args,**kwargs):
        assert len(kwargs['data'])<=180
        ids=[g['gameId'] for g in json.loads(kwargs['data'])['games']]
        sent.extend(ids)
        return response(202,{'accepted':[{'gameId':i} for i in ids], 'rejected':[]})
    monkeypatch.setattr(client.requests,'request',post)
    games=[{'gameId':str(i),'padding':'x'*100} for i in range(3)]
    result=client.ApiClient('https://example.invalid','secret').upload_games_batch(games)
    assert sent==['0','1','2']
    assert [x['gameId'] for x in result['accepted']]==sent
    assert result['rejected']==[]

def test_later_busy_chunk_acknowledges_prior_and_retries_only_remaining(monkeypatch):
    monkeypatch.setattr(client,'GAME_BODY_MAX_BYTES',180)
    mocked=MagicMock(side_effect=[response(202,{'accepted':[{'gameId':'0'}],'rejected':[]}),
                                 response(503,{'error':{'code':'replay_ingest_busy'}})])
    monkeypatch.setattr(client.requests,'request',mocked)
    games=[{'gameId':str(i),'padding':'x'*100} for i in range(3)]
    result=client.ApiClient('https://example.invalid','secret').upload_games_batch(games)
    assert result['accepted']==[{'gameId':'0'}]
    assert [r['gameId'] for r in result['rejected']]==['1','2']
    assert all(r['retryable'] for r in result['rejected'])
    assert mocked.call_count==2

def test_oversized_game_is_rejected_without_post_or_truncation(monkeypatch):
    monkeypatch.setattr(client,'GAME_BODY_MAX_BYTES',100)
    mocked=MagicMock()
    monkeypatch.setattr(client.requests,'request',mocked)
    game={'gameId':'large','padding':'x'*200}
    result=client.ApiClient('https://example.invalid','secret').upload_games_batch([game])
    assert result=={'accepted':[],'rejected':[{'gameId':'large','errors':['game_payload_too_large'],'retryable':False}]}
    assert game['padding']=='x'*200
    mocked.assert_not_called()


def _stub_bundle(monkeypatch, tmp_path, count=2):
    import hashlib
    artifacts = importlib.import_module('sc2tools_agent.playback_artifacts')
    segments = []
    for index in range(count):
        body = json.dumps({'index': index}).encode()
        digest = hashlib.sha256(body).hexdigest()
        (tmp_path / f'{digest}.json').write_bytes(body)
        segments.append({'index': index, 'sizeBytes': len(body), 'sha256': digest})
    monkeypatch.setattr(artifacts, 'load_bundle', lambda _path: {'segments': segments})
    return tmp_path / 'manifest.json', segments


def _playback_server(segments, script):
    """Route playback requests; ``script`` maps a request key to queued
    responses (the last one repeats)."""
    calls = []
    artifact = 'c' * 64

    def request(method, url, **kwargs):
        if url.endswith('/artifacts'):
            key = 'prepare'
            default = response(200, {'ok': True, 'artifactId': artifact})
        elif url.endswith('/complete'):
            key = 'complete'
            default = response(200, {'ok': True, 'artifactId': artifact, 'segmentCount': len(segments)})
        else:
            index = int(url.rsplit('/', 1)[1])
            key = f'segment{index}'
            default = response(200, {'ok': True, 'sha256': segments[index]['sha256']})
        calls.append(key)
        queued = script.get(key)
        if queued:
            return queued.pop(0) if len(queued) > 1 else queued[0]
        return default
    return request, calls


def busy(code):
    value = response(503, {'error': {'code': code}})
    value.headers = {'Retry-After': '5'}
    return value


def test_busy_segment_is_retried_in_place_without_restarting_publication(monkeypatch, tmp_path):
    manifest, segments = _stub_bundle(monkeypatch, tmp_path)
    ok = response(200, {'ok': True, 'sha256': segments[0]['sha256']})
    request, calls = _playback_server(segments, {'segment0': [busy('replay_ingest_busy'), busy('replay_ingest_busy'), ok]})
    monkeypatch.setattr(client.requests, 'request', request)
    waits = []
    monkeypatch.setattr(client.time, 'sleep', waits.append)
    result = client.ApiClient('https://example.invalid', 'secret').upload_playback_artifact('g', manifest)
    assert result['segmentCount'] == 2
    assert calls == ['prepare', 'segment0', 'segment0', 'segment0', 'segment1', 'complete']
    assert waits == [5.0, 5.0]


def test_busy_artifact_writer_is_waited_out(monkeypatch, tmp_path):
    manifest, segments = _stub_bundle(monkeypatch, tmp_path)
    ok = response(200, {'ok': True, 'artifactId': 'c' * 64})
    request, calls = _playback_server(segments, {'prepare': [busy('playback_artifact_busy')] * 4 + [ok]})
    monkeypatch.setattr(client.requests, 'request', request)
    monkeypatch.setattr(client.time, 'sleep', lambda _s: None)
    client.ApiClient('https://example.invalid', 'secret').upload_playback_artifact('g', manifest)
    assert calls.count('prepare') == 5
    assert calls[-1] == 'complete'


def test_rejected_segment_is_not_retried(monkeypatch, tmp_path):
    manifest, segments = _stub_bundle(monkeypatch, tmp_path)
    rejected = response(400, {'error': {'code': 'invalid_playback_artifact'}})
    request, calls = _playback_server(segments, {'segment1': [rejected]})
    monkeypatch.setattr(client.requests, 'request', request)
    monkeypatch.setattr(client.time, 'sleep', lambda _s: None)
    with pytest.raises(client._ApiError) as raised:
        client.ApiClient('https://example.invalid', 'secret').upload_playback_artifact('g', manifest)
    assert raised.value.status == 400
    assert calls == ['prepare', 'segment0', 'segment1']


def test_persistent_backpressure_eventually_surfaces(monkeypatch, tmp_path):
    manifest, segments = _stub_bundle(monkeypatch, tmp_path)
    request, calls = _playback_server(segments, {'segment0': [busy('replay_ingest_busy')]})
    monkeypatch.setattr(client.requests, 'request', request)
    clock = {'now': 0.0}
    monkeypatch.setattr(client.time, 'monotonic', lambda: clock['now'])
    monkeypatch.setattr(client.time, 'sleep', lambda s: clock.__setitem__('now', clock['now'] + s))
    with pytest.raises(client.ReplayIngestBusy):
        client.ApiClient('https://example.invalid', 'secret').upload_playback_artifact('g', manifest)
    assert clock['now'] >= client.PLAYBACK_BUSY_MAX_WAIT_SEC
    assert 'segment1' not in calls
