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
