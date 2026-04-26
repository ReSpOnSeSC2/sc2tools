"""Analytics layer.

Houses the shared feature-extraction stage plus future analytics consumers
(macro-score, win-probability, build clustering, etc.). Every consumer should
read its inputs through `analytics.feature_extractor.extract_features` so all
features are computed in one place against one canonical schema.
"""
