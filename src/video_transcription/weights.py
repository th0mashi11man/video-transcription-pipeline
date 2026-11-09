"""Pre-download Whisper and optional PyAnnote models."""

import argparse
import os


def download_whisper_weights(model="small"):
    from .mlx_backend import uses_mlx, download_mlx_model
    if uses_mlx():
        from .progress import Progress
        return download_mlx_model(model, Progress())
    from faster_whisper.utils import download_model
    return download_model(model)


def download_diarization_weights(hf_token=None):
    from pyannote.audio import Pipeline
    from huggingface_hub import get_token
    token = hf_token or os.environ.get("HF_TOKEN") or get_token()
    if not token:
        raise ValueError("Set HF_TOKEN to a Hugging Face read token and accept the PyAnnote model agreements.")
    model = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1", token=token)
    if model is None:
        raise RuntimeError("Could not download speaker detection models. Check your token and model access.")
    return model


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="small")
    parser.add_argument("--speakers", action="store_true")
    args = parser.parse_args()
    download_whisper_weights(args.model)
    if args.speakers:
        download_diarization_weights()


if __name__ == "__main__":
    main()
