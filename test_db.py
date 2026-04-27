import sys
import os

sys.path.append(os.path.join(os.getcwd(), 'SC2Replay-Analyzer'))
sys.modules['sc2reader'] = type('sc2reader', (), {'load_replay': None})()
sys.modules['analytics.opponent_profiler'] = type('profiler', (), {'OpponentProfiler': lambda x=None: None})()

from db.database import ReplayAnalyzer

print("Testing initialization")
a = ReplayAnalyzer()
print("Initialized")
