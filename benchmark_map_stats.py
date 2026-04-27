import sys
import os
import time

sys.path.append(os.path.join(os.getcwd(), 'SC2Replay-Analyzer'))
sys.modules['sc2reader'] = type('sc2reader', (), {'load_replay': None})()
sys.modules['analytics.opponent_profiler'] = type('profiler', (), {'OpponentProfiler': lambda *args, **kwargs: None})()

from db.database import ReplayAnalyzer

def setup_db():
    import random
    analyzer = ReplayAnalyzer()
    analyzer.db = {}
    maps = ['Map A', 'Map B', 'Map C', 'Map D']
    results = ['Win', 'Loss', 'Other']
    for b in range(10):
        build_name = f"Build {b}"
        analyzer.db[build_name] = {'games': []}
        for g in range(10000): # 100,000 games total
            analyzer.db[build_name]['games'].append({
                'id': f"{b}_{g}",
                'map': random.choice(maps),
                'result': random.choice(results)
            })
    return analyzer

print("Generating 100,000 games for benchmark...")
analyzer = setup_db()

print("\n--- Benchmarking First Call (Cold Cache) ---")
start_time = time.time()
analyzer.get_map_stats()
first_call_time = time.time() - start_time
print(f"Time for first call: {first_call_time:.4f} seconds")

print("\n--- Benchmarking Subsequent Calls (Warm Cache) ---")
start_time = time.time()
for _ in range(100):
    analyzer.get_map_stats()
subsequent_calls_time = time.time() - start_time
print(f"Time for 100 subsequent calls: {subsequent_calls_time:.4f} seconds")
print(f"Average time per warm call: {subsequent_calls_time/100:.6f} seconds")
print(f"Speedup: {first_call_time / (subsequent_calls_time/100):.2f}x")
