"""Read-only engine replay checks in a dedicated disposable SC2 process."""
import argparse
import asyncio
from pathlib import Path

from loguru import logger
from s2clientprotocol import sc2api_pb2 as api
from google.protobuf.json_format import MessageToDict

from pluto_sc2.replays import inspect_replay
from pluto_sc2.runner import ManagedSC2Process, write_json


async def check(files, output):
    info = inspect_replay(files[0])
    records = []
    async with ManagedSC2Process(base_build=f"Base{info['base_build']}", data_hash=info['data_version']) as controller:
        for file in files:
            file = file.resolve()
            record = {"replay_path": str(file)}
            for mode in ("path", "data"):
                request = api.RequestReplayInfo(download_data=False)
                if mode == "path":
                    request.replay_path = str(file)
                else:
                    request.replay_data = file.read_bytes()
                response = await controller._execute(replay_info=request)
                record[mode] = MessageToDict(response.replay_info, preserving_proto_field_name=True)
            records.append(record)
    write_json(output, {"records": records})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    logger.remove()
    asyncio.run(check(args.files, args.output))
