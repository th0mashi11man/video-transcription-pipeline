"""Apple Silicon GPU recognition, preserving Whisper's word probabilities."""

import gc
import importlib
import platform
from pathlib import Path
from types import SimpleNamespace

MLX_MODELS = {
    name: f"mlx-community/whisper-{name}-mlx"
    for name in ("tiny", "base", "small", "medium", "large-v2", "large-v3")
}
MLX_MODELS["turbo"] = "mlx-community/whisper-large-v3-turbo"
WEIGHT_FILES = ("weights.safetensors", "weights.npz")


def uses_mlx(device=None):
    return device == "mlx" or (
        device is None and platform.system() == "Darwin" and platform.machine() == "arm64"
    )


def complete_model(path):
    path = Path(path)
    return (path / "config.json").is_file() and any(
        (path / name).is_file() and (path / name).stat().st_size > 0 for name in WEIGHT_FILES
    )


def download_mlx_model(name, progress):
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError
    repo = MLX_MODELS[name]
    try:
        cached = snapshot_download(repo, local_files_only=True)
        if complete_model(cached):
            progress.set("load_model", f"Loading {name.title()} model", "Using the model saved on this Mac.")
            return cached
    except LocalEntryNotFoundError:
        pass
    label = f"Downloading {name.title()} model"
    detail = "First use of this model. It will stay on this Mac for future transcriptions."
    progress.set("download_model", label, detail)
    path = snapshot_download(
        repo, allow_patterns=["config.json", *WEIGHT_FILES],
        tqdm_class=progress.bar("download_model", label, detail, unit="files"),
    )
    if not complete_model(path):
        raise RuntimeError("The transcription model download is incomplete. Retry to resume it.")
    return path


def recognize_mlx(samples, model_name, language, progress):
    import mlx.core as mx
    if not mx.metal.is_available():
        raise RuntimeError("The Apple GPU is unavailable. MLX requires an Apple Silicon Mac with Metal.")
    mx.set_default_device(mx.gpu)
    path = download_mlx_model(model_name, progress)
    progress.set("load_model", f"Loading {model_name.title()} model", "Apple GPU · MLX")
    module = importlib.import_module("mlx_whisper.transcribe")
    # mlx-whisper 0.4 exposes its real processed-frame counter through tqdm.
    # Scope this adapter to its transcription module, leaving global tqdm alone.
    original = module.tqdm
    module.tqdm = SimpleNamespace(tqdm=progress.bar(
        "transcribe", "Transcribing", "Apple GPU · MLX", unit="frames",
    ))
    try:
        result = module.transcribe(
            samples, path_or_hf_repo=path, language=language, word_timestamps=True,
            verbose=False, hallucination_silence_threshold=2.0,
        )
        words = [
            {"text": w["word"].strip(), "start": float(w["start"]),
             "end": float(w["end"]), "confidence": w.get("probability"), "speaker": None}
            for segment in result["segments"] for w in segment.get("words", [])
        ]
        return words, result["language"]
    finally:
        module.tqdm = original
        # Release MLX weights before PyAnnote uses the same unified GPU memory.
        module.ModelHolder.model = None
        module.ModelHolder.model_path = None
        mx.synchronize()
        gc.collect()
        mx.clear_cache()
