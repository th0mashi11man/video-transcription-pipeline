# Transcript Studio

A local Tauri desktop app for producing and reviewing transcripts beside their audio or video. Built on [misc-an/video-transcription-pipeline](https://github.com/misc-an/video-transcription-pipeline), with Whisper transcription and PyAnnote speaker detection.

## What works in this first version

- Open a local recording and generate a transcript with word timestamps, ASR word probabilities, and speaker labels.
- Play audio or video alongside the transcript. Click a word to seek to its timestamp.
- Replay a selected word with one second of surrounding context, loop that section, and change playback speed.
- Highlight low-confidence words using an adjustable threshold. Missing scores are shown separately and included in review.
- Search passages, filter to passages needing review, and jump to the next issue.
- Edit words or untimed passages; mark words or whole passages reviewed. Preserve the original wording, timing, and model score.
- Save and reopen JSON projects; export corrected TXT, SRT, and VTT.
- Connect Hugging Face through guided setup and store the token in the operating system credential vault (Keychain on macOS).
- Run and cancel transcription in the background, with an activity log and actionable failures.

## Run locally

Requirements: Node.js 22.12+, Rust, Python 3.12 via [uv](https://docs.astral.sh/uv/), FFmpeg, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). macOS needs Xcode Command Line Tools.

From the repository root:

```bash
uv sync --python 3.12 --extra speakers --extra dev
cd desktop
npm ci
npm run tauri dev
```

The app automatically uses the repository's `.venv`. A different Python executable can be selected in Settings. A Python environment with the project's dependencies and an FFmpeg executable are currently required separately; this is a development MVP, not a self-contained installer. The Python source is included in packaged app resources.

For a browser-only preview:

```bash
cd desktop
npm run dev
```

Open the displayed local address. The browser preview supports media playback, JSON import, editing, sample exploration, and export. Transcription and secure token storage require the Tauri desktop app.

Build a macOS app:

```bash
cd desktop
npm run tauri build
```

The app is written to `desktop/src-tauri/target/release/bundle/macos/Transcript Studio.app`. Distribution signing and notarization are not configured. Windows/Linux targets need their respective platform prerequisites and bundle target configuration; only macOS has been checked here.

## Connect Hugging Face and identify speakers

Speaker detection is enabled by default. In the app, open Settings → Connect Hugging Face:

1. Follow **Create a read token**, sign in or create a free account, and create a token with **Read** access.
2. Follow the links to accept the user conditions for [speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) and [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0), using the same account.
3. Paste the token into the password field and choose **Save token**.
4. Open a recording and choose **Transcribe recording**.

The token is stored in the OS credential vault and passed to the Python child process through its environment, not command-line arguments or project JSON. The UI never reads the saved value back. Removing it deletes the app's credential entry. “Token added” means it was stored; access to the gated models is verified during transcription. An invalid token or missing agreement produces an error with setup instructions. Speaker detection failures are not silently ignored. You may explicitly disable speaker detection to transcribe without it.

The initial model download requires internet access. Transcription and speaker inference run locally. PyAnnote telemetry is disabled for jobs started by the app. Model downloads may be substantial; choose Tiny or Base for a quick first test. On Apple Silicon, Whisper uses CPU/int8 because CTranslate2 does not support Metal; PyAnnote can use Metal. Speaker IDs are anonymous labels, not identified people.

## Review and save

1. Attach the original recording and transcribe it, or open an existing pipeline JSON file.
2. Use **Needs review** or **Next issue** to find low-score or unscored words.
3. Select a word and use **Replay context**. Enable **Loop** to listen repeatedly.
4. Type a correction and choose **Save correction**, or mark a complete passage reviewed.
5. Choose **Save project** to save JSON, including corrections and review decisions.

JSON does not embed the recording. Reattach its original file after reopening a project. Changes are saved explicitly; the app prompts before replacing or closing unsaved work. Exporting text or subtitles does not save review metadata.

Confidence is an uncalibrated ASR estimate: a high score can still be wrong, and a low score can be right. Corrections keep the original score instead of inventing a new certainty. Imported older WhisperX `score` fields are alignment scores rather than ASR probabilities; they are retained for review, but should not be compared as calibrated probabilities. Legacy Qwen output has timestamps but no scores and is shown as confidence unavailable. Untimed passages can be edited, but subtitle export requires valid start/end times. Multiword replacements retain the original selected word's timing; they do not perform realignment.

Playback uses the system webview's codecs. MP4 with H.264/AAC and WAV/MP3 are practical choices on macOS; FFmpeg can transcribe additional formats that the player may not support. Playback failures are reported explicitly.

## Command-line pipeline

```bash
uv run --extra speakers transcribe recording.mp4 --output-dir data/output
# No speaker detection or Hugging Face account:
uv run transcribe recording.mp4 --no-diarize --model small
# Download models in advance (HF_TOKEN is needed for --speakers):
uv run --extra speakers download-weights --model small --speakers
```

For command-line speaker detection, use the `HF_TOKEN` environment variable or an existing Hugging Face login. Options include `--language sv`, `--device cpu|cuda`, `--compute-type`, `--min-speakers`, `--max-speakers`, `--start-time`, `--duration`, and `--cleanup-audio`. Output includes TXT, SRT, VTT, and JSON. Word times for clipped CLI runs are offset to the original recording.

The desktop app writes intermediate job results and activity logs in its local application-data directory under `jobs/`. Your source recording is not modified. Temporary extracted audio is removed after completion or an ordinary error; a forcefully cancelled process may leave its temporary directory behind. Project JSON is written only to the location you select.

## Repository findings and implementation choices

The upstream checkout was examined at `12489f1`. It is a small Python CLI with reusable FFmpeg extraction, word grouping, speaker assignment, and TXT/SRT/VTT/JSON exporters, plus example transcripts and six tests. Its latest change replaced WhisperX with Qwen3-ASR. The earlier WhisperX version at `e9dd20b` already used CTranslate2 on CPU/CUDA and PyAnnote on CPU/Metal/CUDA.

The current fork uses Faster Whisper directly so timestamps and ASR word probabilities come from the same decoder. PyAnnote speaker turns are assigned by temporal overlap using the upstream helper, then grouped into passages. This avoids presenting a forced-alignment score as transcription certainty. Qwen dependencies and model download paths were removed. The existing example files remain importable.

```text
desktop/                      React + TypeScript review interface
  src/transcript.ts           Import, review metadata, and corrected export
  src-tauri/                  Tauri native commands, credential vault, job runner
src/video_transcription/
  whisper.py                  Faster Whisper + PyAnnote orchestration
  pipeline.py                 Shared grouping and speaker assignment
  audio.py                    FFmpeg extraction
  export.py                   TXT/SRT/VTT/JSON exporters
  weights.py                  Model pre-download helpers
tests/                        Python regression and backend contract tests
```

## Checks

```bash
uv run --extra dev pytest tests -q
cd desktop
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

Tests cover transcript import, missing confidence/timestamps, edit persistence, subtitle export, source-file protection, confidence propagation, clipping offsets, and explicit/redacted speaker-detection failures. Real gated speaker-model inference requires the user's authorized Hugging Face account and model agreements.
