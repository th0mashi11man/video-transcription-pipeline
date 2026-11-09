"""Exercise backend selection, resumable downloads, and MLX word metadata offline."""

import json
import sys
from types import SimpleNamespace

import pytest
from video_transcription import mlx_backend
from video_transcription.progress import Progress


def test_apple_silicon_defaults_to_gpu_with_explicit_cpu_override(monkeypatch):
    monkeypatch.setattr(mlx_backend.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(mlx_backend.platform, "machine", lambda: "arm64")
    assert mlx_backend.uses_mlx()
    assert not mlx_backend.uses_mlx("cpu")
    assert not mlx_backend.uses_mlx("cuda")
    monkeypatch.setattr(mlx_backend.platform, "machine", lambda: "x86_64")
    assert not mlx_backend.uses_mlx()
    assert mlx_backend.uses_mlx("mlx")


def test_partial_model_download_is_completed_and_then_reused_offline(monkeypatch, tmp_path):
    import huggingface_hub
    (tmp_path / "config.json").write_text("{}")
    calls = []
    def snapshot(repo, **kwargs):
        calls.append(kwargs)
        if not kwargs.get("local_files_only"):
            (tmp_path / "weights.npz").write_bytes(b"downloaded")
        return str(tmp_path)
    monkeypatch.setattr(huggingface_hub, "snapshot_download", snapshot)
    progress = Progress(tmp_path / "progress.json")
    assert mlx_backend.download_mlx_model("small", progress) == str(tmp_path)
    assert len(calls) == 2
    assert progress.current["stage"] == "download_model"
    calls.clear()
    assert mlx_backend.download_mlx_model("small", progress) == str(tmp_path)
    assert calls == [{"local_files_only": True}]
    assert progress.current["stage"] == "load_model"
    assert "saved on this Mac" in progress.current["detail"]


def test_progress_file_has_real_counts_and_clears_them_when_stage_changes(tmp_path):
    reporter = Progress(tmp_path / "progress.json")
    bar = reporter.bar("download_model", "Downloading model", unit="files")
    with bar(total=10) as counter:
        counter.update(3)
        reporter.last_update = 0
        counter.refresh()
        data = json.loads(reporter.path.read_text())
        assert (data["completed"], data["total"], data["unit"]) == (3, 10, "files")
    reporter.set("speakers", "Identifying speakers")
    assert json.loads(reporter.path.read_text())["total"] is None
    assert not reporter.path.with_suffix(".tmp").exists()


@pytest.mark.parametrize("fail", [False, True])
def test_mlx_preserves_word_scores_uses_gpu_and_releases_memory(monkeypatch, tmp_path, fail):
    calls = []
    mx = SimpleNamespace(
        metal=SimpleNamespace(is_available=lambda: True), gpu="gpu",
        set_default_device=lambda device: calls.append(device),
        synchronize=lambda: calls.append("sync"), clear_cache=lambda: calls.append("clear"),
    )
    monkeypatch.setitem(sys.modules, "mlx", SimpleNamespace(core=mx))
    monkeypatch.setitem(sys.modules, "mlx.core", mx)
    monkeypatch.setattr(mlx_backend, "download_mlx_model", lambda *args: str(tmp_path))
    original_tqdm = object()
    module = SimpleNamespace(tqdm=original_tqdm, ModelHolder=SimpleNamespace(model=object(), model_path="loaded"))
    def transcribe(samples, **options):
        assert options["path_or_hf_repo"] == str(tmp_path)
        assert options["word_timestamps"] is True
        assert options["language"] == "sv"
        assert "beam_size" not in options
        if fail:
            raise RuntimeError("test decode failure")
        return {"language": "sv", "segments": [{"words": [
            {"word": " Hej", "start": .5, "end": 1.2, "probability": .42},
            {"word": " igen", "start": 1.2, "end": 1.7},
        ]}]}
    module.transcribe = transcribe
    monkeypatch.setitem(sys.modules, "mlx_whisper.transcribe", module)
    if fail:
        with pytest.raises(RuntimeError, match="test decode failure"):
            mlx_backend.recognize_mlx([], "small", "sv", Progress())
    else:
        words, language = mlx_backend.recognize_mlx([], "small", "sv", Progress())
        assert language == "sv"
        assert words[0] == {"text": "Hej", "start": .5, "end": 1.2, "confidence": .42, "speaker": None}
        assert words[1]["confidence"] is None
    assert calls == ["gpu", "sync", "clear"]
    assert module.ModelHolder.model is None
    assert module.ModelHolder.model_path is None
    assert module.tqdm is original_tqdm
