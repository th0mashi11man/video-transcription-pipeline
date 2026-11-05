"""Audio extraction and processing utilities using FFmpeg."""

import os
import shutil
import subprocess
from pathlib import Path
from typing import Optional
from tqdm import tqdm


def find_ffmpeg() -> str:
    """Locate ffmpeg binary on the system."""
    binary = shutil.which("ffmpeg")
    if binary:
        return binary
    for candidate in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    try:
        from imageio_ffmpeg import get_ffmpeg_exe
        return get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        pass
    raise FileNotFoundError(
        "FFmpeg binary not found. Please install ffmpeg (e.g. 'brew install ffmpeg') or add it to PATH."
    )


def extract_audio_ffmpeg(
    media_path: Path,
    output_wav_path: Path,
    start_time: Optional[str] = None,
    duration: Optional[float] = None,
) -> Path:
    """
    Universal media to 16kHz mono 16-bit PCM WAV extraction using FFmpeg.
    Supports any video (.webm, .mp4, .mkv, .mov, .avi, etc.) or audio (.mp3, .m4a, .flac, etc.).
    """
    ffmpeg_bin = find_ffmpeg()
    output_wav_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [ffmpeg_bin, "-y"]

    if start_time is not None:
        cmd.extend(["-ss", str(start_time)])

    cmd.extend(["-i", str(media_path)])

    if duration is not None:
        cmd.extend(["-t", str(duration)])

    # Stream-agnostic audio extraction: no video, 16kHz, mono, 16-bit PCM
    cmd.extend([
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        str(output_wav_path),
    ])

    with tqdm(total=100, desc="[1/5] Extracting audio (FFmpeg)", bar_format="{l_bar}{bar}| {n_fmt}/{total_fmt}%") as pbar:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        pbar.update(30)
        _, stderr_data = process.communicate()
        pbar.update(70)

        if process.returncode != 0:
            raise RuntimeError(f"FFmpeg audio extraction failed (code {process.returncode}):\n{stderr_data}")

    return output_wav_path
