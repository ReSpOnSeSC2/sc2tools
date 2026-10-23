"""Analytics layer.

Houses shared feature extraction and statistical replay measurements.
Every consumer should
read its inputs through `analytics.feature_extractor.extract_features` so all
features are computed in one place against one canonical schema.
"""
