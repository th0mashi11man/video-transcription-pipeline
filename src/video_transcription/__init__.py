"""
Universal Video-to-Text Transcription & Speaker Diarization Pipeline.
Powered by FFmpeg, Faster Whisper, and PyAnnote.
"""

from .audio import extract_audio_ffmpeg, find_ffmpeg
from .export import format_timestamp_srt, format_timestamp_vtt, save_transcription_outputs
from .pipeline import assign_speakers_to_words, group_words_into_segments, main as transcribe_main, run_pipeline
from .weights import download_diarization_weights, download_whisper_weights

__version__ = "0.3.0"
__all__ = [
    "assign_speakers_to_words",
    "download_diarization_weights",
    "download_whisper_weights",
    "extract_audio_ffmpeg",
    "find_ffmpeg",
    "format_timestamp_srt",
    "format_timestamp_vtt",
    "group_words_into_segments",
    "run_pipeline",
    "save_transcription_outputs",
    "transcribe_main",
]
