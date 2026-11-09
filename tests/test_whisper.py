"""Verify confidence, speaker propagation, and source safety without model downloads."""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import video_transcription.whisper as whisper


def fake_recognizer(monkeypatch):
    word = SimpleNamespace(word=" hello", start=.5, end=1.2, probability=.42)
    class Model:
        def __init__(self, *args, **kwargs):
            pass
        def transcribe(self, *args, **kwargs):
            assert kwargs["word_timestamps"] is True
            return iter([SimpleNamespace(words=[word], end=1.2)]), SimpleNamespace(language="en")
    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=Model))
    def extract(source, target, **kwargs):
        import wave
        with wave.open(str(target), 'wb') as stream:
            stream.setnchannels(1)
            stream.setsampwidth(2)
            stream.setframerate(16000)
            stream.writeframes(b'\0\0' * 32000)
    monkeypatch.setattr(whisper, "extract_audio_ffmpeg", extract)


def test_whisper_preserves_word_probability_and_original_media(monkeypatch, tmp_path):
    fake_recognizer(monkeypatch)
    media = tmp_path / "interview.2026.extracted.wav"
    media.write_bytes(b"source")
    result, outputs = whisper.transcribe_media(media, tmp_path / "output", device="cpu", do_diarize=False, start_time="00:01:00")
    assert media.read_bytes() == b"source"
    assert result["words"][0] == {"text": "hello", "start": 60.5, "end": 61.2, "confidence": .42, "speaker": None}
    assert result["segments"][0]["words"][0]["confidence"] == .42
    assert json.loads(outputs["json"].read_text())["mediaName"] == media.name


def test_missing_token_does_not_silently_disable_speakers(monkeypatch, tmp_path):
    media = tmp_path / "input.wav"
    media.write_bytes(b"source")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("HUGGINGFACE_TOKEN", raising=False)
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(get_token=lambda: None))
    with pytest.raises(ValueError, match="Set HF_TOKEN"):
        whisper.transcribe_media(media, do_diarize=True)


def test_requested_speaker_failure_is_actionable_and_redacts_token(monkeypatch, tmp_path):
    fake_recognizer(monkeypatch)
    media = tmp_path / "input.wav"
    media.write_bytes(b"source")
    class Pipeline:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            error = RuntimeError("access denied for hf_secret_token")
            error.response = SimpleNamespace(status_code=403)
            raise error
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "torchaudio", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "pyannote", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "pyannote.audio", SimpleNamespace(Pipeline=Pipeline))
    with pytest.raises(RuntimeError) as error:
        whisper.transcribe_media(media, tmp_path / "output", device="cpu", hf_token="hf_secret_token")
    assert "accept the agreements" in str(error.value)
    assert "hf_secret_token" not in str(error.value)
    assert not list((tmp_path / "output").glob("*.json"))


def test_speaker_runtime_errors_do_not_blame_credentials(monkeypatch, tmp_path):
    fake_recognizer(monkeypatch)
    media = tmp_path / "input.wav"
    media.write_bytes(b"source")
    class Pipeline:
        @staticmethod
        def from_pretrained(*args, **kwargs):
            raise RuntimeError("Object of type int64 is not JSON serializable")
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "pyannote.audio", SimpleNamespace(Pipeline=Pipeline))
    with pytest.raises(RuntimeError, match="int64") as error:
        whisper.transcribe_media(media, tmp_path / "output", device="cpu", hf_token="hf_test_token")
    assert "Check your read token" not in str(error.value)
    assert "accept the agreements" not in str(error.value)


def test_speaker_turns_reach_words_segments_and_saved_json(monkeypatch, tmp_path):
    fake_recognizer(monkeypatch)
    media = tmp_path / "interview.wav"
    media.write_bytes(b"original recording")
    class Tensor:
        def to(self, *args): return self
        def reshape(self, *args): return self
        def __truediv__(self, other): return self
    torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False),
        backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False)),
        device=lambda device: device, frombuffer=lambda *args, **kwargs: Tensor(),
        int16="int16", float32="float32",
    )
    class Pipeline:
        @staticmethod
        def from_pretrained(name, token):
            assert name == "pyannote/speaker-diarization-community-1"
            assert token == "hf_test_token"
            return Pipeline()
        def to(self, device):
            assert device == "cpu"
        def __call__(self, audio, **kwargs):
            assert audio["sample_rate"] == 16000
            import numpy as np
            kwargs["hook"]("segmentation", None, total=np.int64(4), completed=np.int64(4))
            progress = json.loads((tmp_path / "progress.json").read_text())
            assert progress["completed"] == 4 and progress["total"] == 4
            annotation = SimpleNamespace(itertracks=lambda **kwargs: iter([
                (SimpleNamespace(start=0, end=2), 0, "SPEAKER_01"),
            ]))
            return SimpleNamespace(speaker_diarization=annotation)
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "pyannote", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "pyannote.audio", SimpleNamespace(Pipeline=Pipeline))
    result, files = whisper.transcribe_media(media, tmp_path / "out", device="cpu", hf_token="hf_test_token",
                                            progress_file=tmp_path / "progress.json")
    assert result["words"][0]["speaker"] == "SPEAKER_01"
    assert result["segments"][0]["speaker"] == "SPEAKER_01"
    assert result["words"][0]["confidence"] == .42
    assert json.loads(files["json"].read_text())["speaker_turns"][0]["speaker"] == "SPEAKER_01"
