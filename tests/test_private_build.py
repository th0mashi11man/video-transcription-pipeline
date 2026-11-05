"""Verify private-build safeguards and the portable decoder fallback."""

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import video_transcription.audio as audio

spec = importlib.util.spec_from_file_location('check_secrets', Path(__file__).parents[1] / 'scripts/check_secrets.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def test_guard_rejects_tokens_without_echoing_them():
    token = b'hf_' + b'A' * 30
    assert guard.credential_risk('settings.json', b'{"token":"' + token + b'"}') == 'possible credential'
    assert guard.credential_risk('README.md', b'Use a token beginning with hf_') is None


def test_guard_rejects_private_material_even_without_a_visible_token():
    assert guard.credential_risk('desktop/src-tauri/.private/runtime.bin', b'') == 'private build material'
    assert guard.credential_risk('Transcript Studio.app/Contents/MacOS/app', b'') == 'private build material'
    assert guard.credential_risk('private.dmg', b'') == 'private build material'
    assert guard.credential_risk('output/Transcript Studio-private-arm64.zip', b'') == 'private build material'
    assert guard.credential_risk('desktop/src-tauri/tauri.private.conf.json', b'configuration only') is None


def test_audio_uses_included_decoder_without_a_system_ffmpeg(monkeypatch):
    monkeypatch.setattr(audio.shutil, 'which', lambda name: None)
    monkeypatch.setattr(audio.os.path, 'isfile', lambda path: False)
    monkeypatch.setitem(sys.modules, 'imageio_ffmpeg', SimpleNamespace(get_ffmpeg_exe=lambda: '/included/runtime/ffmpeg'))
    assert audio.find_ffmpeg() == '/included/runtime/ffmpeg'
