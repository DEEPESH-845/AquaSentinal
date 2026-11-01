"""Image-quality estimate: monotonic in contrast, and the clear synthetic frame is GOOD."""

from app.perception.quality import analyze, decode

from .conftest import synthetic_frame


def test_visibility_estimate_falls_with_contrast_and_clear_frame_is_good():
    estimates = [analyze(decode(synthetic_frame(contrast=c))).visibility_estimate for c in (0.2, 0.3, 0.4, 0.5, 0.6)]
    assert estimates == sorted(estimates) and len(set(estimates)) == len(estimates)
    clear = analyze(decode(synthetic_frame(contrast=1.0)))
    assert clear.band == "GOOD"
    assert analyze(decode(synthetic_frame(contrast=0.6))).band == "GOOD"  # contrast 0.062, what twin frames show at turbidity 0.3
    assert analyze(decode(synthetic_frame(contrast=0.2))).band == "UNRELIABLE"
