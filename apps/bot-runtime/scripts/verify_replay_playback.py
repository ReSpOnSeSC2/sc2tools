"""Verify a replay through its final recorded frame, without any gameplay actions."""
import argparse
import asyncio
from pathlib import Path
import time

from loguru import logger
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2.replay_viewer import local_map_data
from pluto_sc2.replays import inspect_replay
from pluto_sc2.runner import ManagedSC2Process, write_json


async def verify(replay, output):
    info = inspect_replay(replay)
    started = time.monotonic()
    async with ManagedSC2Process(base_build=f"Base{info['base_build']}", data_hash=info['data_version']) as controller:
        request = api.RequestStartReplay(replay_data=replay.read_bytes(), observed_player_id=0,
                                         disable_fog=False, realtime=False, options=api.InterfaceOptions(raw=True))
        map_data, _ = local_map_data(info)
        if map_data:
            request.map_data = map_data
        response = await controller._execute(start_replay=request)
        if response.start_replay.HasField('error'):
            raise RuntimeError(response.start_replay.error_details)
        loop = 0
        while loop < info['game_loops']:
            if time.monotonic() - started > 120:
                raise TimeoutError('Replay validation exceeded two minutes')
            await controller._execute(step=api.RequestStep(count=min(224, info['game_loops'] - loop)))
            response = await controller._execute(observation=api.RequestObservation())
            next_loop = response.observation.observation.game_loop
            if next_loop <= loop:
                raise RuntimeError('Replay stopped advancing before its final recorded frame')
            loop = next_loop
            if response.observation.player_result:
                break
        write_json(output, dict(replay=str(replay.resolve()), final_loop=loop, expected_loop=info['game_loops'],
                               reached_final_frame=loop >= info['game_loops'] - 1,
                               wall_seconds=time.monotonic() - started,
                               results=[{'player_id':p.player_id, 'result':p.result}
                                        for p in response.observation.player_result]))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('replay', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    logger.remove()
    asyncio.run(verify(args.replay, args.output))
