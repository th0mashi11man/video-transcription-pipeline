"""Progress reporting must serialize model-library counters without stopping ASR."""

import json
from pathlib import Path

import numpy as np
import pytest

from video_transcription.progress import Progress


@pytest.mark.parametrize("value, expected", [
    (np.int64(7), 7), (np.uint64(9), 9),
    (np.float32(.25), .25), (np.float64(.125), .125),
    (np.float64("nan"), None), (np.float64("inf"), None),
    (np.int64(-1), None), (None, None),
])
def test_model_counters_produce_valid_json(tmp_path, value, expected):
    reporter = Progress(tmp_path / "progress.json")
    reporter.set("speakers", "Identifying speakers", completed=value, total=value)
    data = json.loads(reporter.path.read_text(), parse_constant=lambda v: pytest.fail(v))
    assert data["completed"] == expected
    assert data["total"] == expected


def test_progress_write_failure_does_not_interrupt_processing(monkeypatch, tmp_path, capsys):
    reporter = Progress(tmp_path / "progress.json")
    reporter.set("extract", "Preparing recording")
    def fail_replace(*args, **kwargs):
        raise PermissionError("progress file is temporarily unavailable")
    monkeypatch.setattr(Path, "replace", fail_replace)
    reporter.set("speakers", "Identifying speakers", completed=np.int64(1), total=np.int64(4))
    reporter.set("complete", "Transcript ready")
    assert reporter.current["stage"] == "complete"
    assert json.loads(reporter.path.read_text())["stage"] == "extract"
    assert not reporter.path.with_suffix(".tmp").exists()
    assert capsys.readouterr().err.count("transcription will continue") == 1


def test_unavailable_progress_directory_does_not_stop_processing(tmp_path, capsys):
    unavailable = tmp_path / "not-a-directory"
    unavailable.write_text("file")
    reporter = Progress(unavailable / "progress.json")
    reporter.set("speakers", "Identifying speakers")
    assert reporter.current["stage"] == "speakers"
    assert "transcription will continue" in capsys.readouterr().err
