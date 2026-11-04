"""Local Whisper word probabilities and PyAnnote speaker detection.

Word probabilities are model estimates, not calibrated correctness guarantees.
Unlike alignment scores, these estimates come directly from the ASR decoder.
"""

import argparse
import gc
import json
import os
import tempfile
from pathlib import Path

from .audio import extract_audio_ffmpeg
from .export import save_transcription_outputs
from .pipeline import assign_speakers_to_words, group_words_into_segments, smart_join_tokens

MODELS = ("tiny", "base", "small", "medium", "large-v2", "large-v3", "turbo")


def transcribe_media(media_file, output_dir=None, model_name="small", language=None,
                     device=None, compute_type=None, do_diarize=True, hf_token=None,
                     min_speakers=None, max_speakers=None, start_time=None,
                     duration=None, cleanup_audio=True):
    media = Path(media_file).expanduser().resolve(strict=True)
    if not media.is_file():
        raise ValueError("Choose an audio or video file.")
    if model_name not in MODELS:
        raise ValueError(f"Unsupported Whisper model: {model_name}")
    if device not in (None, "cpu", "cuda"):
        raise ValueError("Whisper supports CPU or CUDA. On Apple Silicon, use CPU.")

    token = hf_token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if do_diarize and not token:
        from huggingface_hub import get_token
        token = get_token()
    if do_diarize and not token:
        raise ValueError("Speaker detection needs a Hugging Face read token. Connect Hugging Face in Settings and accept the PyAnnote model agreements.")
    out = Path(output_dir).expanduser().resolve() if output_dir else media.parent
    out.mkdir(parents=True, exist_ok=True)

    # Always use a distinct temporary file so source media cannot be overwritten.
    with tempfile.TemporaryDirectory(prefix="transcript-audio-") as temporary:
        audio = Path(temporary) / "audio.wav"
        print("[1/4] Extracting audio…", flush=True)
        extract_audio_ffmpeg(media, audio, start_time=start_time, duration=duration)
        from faster_whisper import WhisperModel
        if device is None:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
        compute_type = compute_type or ("float16" if device == "cuda" else "int8")
        print(f"[2/4] Loading Whisper {model_name} on {device}. First use downloads model weights…", flush=True)
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        # Feed normalized samples directly: newer PyAV releases removed a
        # decoder argument used by Faster Whisper's file-loading helper.
        import numpy as np
        import wave
        with wave.open(str(audio), "rb") as stream:
            samples = np.frombuffer(stream.readframes(stream.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        if samples.size == 0:
            raise ValueError("This recording has no audio samples.")
        generated, info = model.transcribe(samples, language=language, word_timestamps=True,
                                           vad_filter=True, beam_size=5)
        words = []
        for segment in generated:
            for word in segment.words or []:
                words.append({"text": word.word.strip(), "start": float(word.start),
                              "end": float(word.end), "confidence": float(word.probability),
                              "speaker": None})
            print(f"Recognized through {segment.end:.1f}s", flush=True)
        detected_language = info.language
        del model
        gc.collect()

        turns = []
        if do_diarize:
            print("[3/4] Detecting speakers with PyAnnote…", flush=True)
            try:
                import torch
                import wave
                from pyannote.audio import Pipeline
                speaker_model = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=token)
                if speaker_model is None:
                    raise RuntimeError("Model access was not granted.")
                speaker_device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
                speaker_model.to(torch.device(speaker_device))
                # FFmpeg already made PCM16 mono WAV. Read it without depending
                # on TorchCodec's platform-specific FFmpeg shared libraries.
                with wave.open(str(audio), "rb") as stream:
                    sample_rate = stream.getframerate()
                    pcm = bytearray(stream.readframes(stream.getnframes()))
                waveform = torch.frombuffer(pcm, dtype=torch.int16).to(torch.float32).reshape(1, -1) / 32768.0
                options = {}
                if min_speakers is not None:
                    options["min_speakers"] = min_speakers
                if max_speakers is not None:
                    options["max_speakers"] = max_speakers
                diarized = speaker_model({"waveform": waveform, "sample_rate": sample_rate}, **options)
                annotation = getattr(diarized, "speaker_diarization", diarized)
                turns = [(float(turn.start), float(turn.end), str(speaker))
                         for turn, _, speaker in annotation.itertracks(yield_label=True)]
                assign_speakers_to_words(words, turns)
                if words and not turns:
                    raise RuntimeError("No speaker turns were detected. Try a clearer recording or disable speaker detection explicitly.")
            except Exception as exc:
                # Do not silently return a transcript without the requested speakers.
                detail = str(exc).replace(token, "[redacted]") if token else str(exc)
                raise RuntimeError("Speaker detection failed. Check your read token and accept the agreements at "
                                   "huggingface.co/pyannote/speaker-diarization-community-1 and "
                                   f"huggingface.co/pyannote/segmentation-3.0. Details: {detail}") from None
        else:
            print("[3/4] Speaker detection disabled by user.", flush=True)

        # Returned times refer to the original recording, including CLI clipping.
        offset = sum(float(part) * 60 ** index for index, part in enumerate(reversed(str(start_time or 0).split(":"))))
        for word in words:
            word["start"] += offset
            word["end"] += offset
        turns = [(start + offset, end + offset, speaker) for start, end, speaker in turns]
        result = {"engine": "faster-whisper", "model": model_name, "language": detected_language,
                  "mediaName": media.name, "confidence_kind": "ASR word probability (uncalibrated)",
                  "text": smart_join_tokens([w["text"] for w in words]), "words": words,
                  "segments": group_words_into_segments(words),
                  "speaker_turns": [{"start": s, "end": e, "speaker": who} for s, e, who in turns]}
        print("[4/4] Saving transcript…", flush=True)
        paths = save_transcription_outputs(result, out / media.stem, include_speakers=do_diarize)
        if not cleanup_audio:
            import shutil
            target = out / f"{media.stem}.extracted.wav"
            if target.resolve() == media:
                raise ValueError("Refusing to overwrite the source audio with extracted audio.")
            shutil.copyfile(audio, target)
        return result, paths


def main():
    parser = argparse.ArgumentParser(description="Local Whisper transcription with word confidence and speaker detection.")
    parser.add_argument("media_file")
    parser.add_argument("--output-dir", "-o")
    parser.add_argument("--model", choices=MODELS, default="small")
    parser.add_argument("--language", "-l")
    parser.add_argument("--device", choices=("cpu", "cuda"))
    parser.add_argument("--compute-type", choices=("int8", "float32", "float16"))
    parser.add_argument("--diarize", dest="do_diarize", action="store_true", default=True)
    parser.add_argument("--no-diarize", dest="do_diarize", action="store_false")
    parser.add_argument("--min-speakers", type=int)
    parser.add_argument("--max-speakers", type=int)
    parser.add_argument("--start-time")
    parser.add_argument("--duration", type=float)
    parser.add_argument("--cleanup-audio", action="store_true")
    # Desktop result path is deliberately separate from the media basename.
    parser.add_argument("--result-file", type=Path)
    args = vars(parser.parse_args())
    result_file = args.pop("result_file")
    try:
        result, paths = transcribe_media(model_name=args.pop("model"), **args)
        if result_file:
            result_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        print(f"Complete. JSON: {paths['json']}", flush=True)
    except Exception as exc:
        import sys
        detail = str(exc)
        for name in ("HF_TOKEN", "HUGGINGFACE_TOKEN"):
            if os.environ.get(name):
                detail = detail.replace(os.environ[name], "[redacted]")
        print(f"Error: {detail}", file=sys.stderr, flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
