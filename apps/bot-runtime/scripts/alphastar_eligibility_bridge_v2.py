"""Queue-compatible v2 rules on the already-proven parameter-free mask graph.

Mask geometry is identical to v1. The independent v2 observation rules do not
mistake supply shortage or absent panel abilities for inability to enqueue.
No legacy graph, source file, checkpoint parameter or optimizer is modified.
"""
from scripts.alphastar_eligibility_bridge_v1 import (
    FUNCTION_INPUT as FUNCTION_INPUT,
    SOURCES_INPUT as SOURCES_INPUT,
    build_eligibility_bridge as _build_mask_graph,
)

ELIGIBILITY_ADAPTER = "conditional-producer-mask-v2"
ELIGIBILITY_RULES = "protoss-action-eligibility-v2"


def build_eligibility_bridge(example, config, registry, **kwargs):
    return _build_mask_graph(example, config, registry, **kwargs)
