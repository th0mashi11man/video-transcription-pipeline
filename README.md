# Transcript Studio

A Mac app for creating and reviewing transcripts alongside audio or video, based on [misc-an/video-transcription-pipeline](https://github.com/misc-an/video-transcription-pipeline). Whisper recognizes words; PyAnnote identifies speakers. Processing stays local.

## Desktop app

The interface follows macOS system appearance, with a native title bar, compact toolbar, recording sidebar, transcript, and optional review inspector. Open a recording, choose Transcribe, and select words to listen and correct them. Space plays or pauses; Command/Ctrl + S saves the project.

Use the Pauses checkbox to show or hide automatic Jeffersonian pause notation:

- Gaps from 0.1 seconds to under 0.2 seconds use `(.)`.
- Longer gaps use tenths of a second, such as `(0.7)` or `(1.0)`.
- Pauses stay inline when the same speaker continues, including across ASR segments.
- A pause between different speakers appears on its own line, without a speaker label.
- Overlaps, missing timing, and leading/trailing recording silence are not turned into pause symbols.

These are timing estimates from word boundaries, or passage boundaries in older imports. Listen to check them. The app does not infer breath, stress, intonation, or overlap notation. Turning pause display off does not alter source words or erase notation entered manually as text.

Display options control speaker labels, speaker-turn timestamps, uncertainty, and review marks. Consecutive segments by the same speaker form one displayed turn. Turn timestamps use the same word boundaries as the pause timings. Original diarization is retained and used to avoid adding pause symbols across detected overlaps. Display settings and the confidence threshold are preserved in saved JSON projects.

## Export

Choose Export in the toolbar, then Word (.docx) or plain text (.txt). Both use the same turn and pause presentation as the screen. You can export the entire transcript or the current filtered view.

- Speaker names and millisecond start/end timestamps are included when visible.
- Automatic pauses appear inline or on separate lines using the same rule as the screen.
- Word preserves uncertainty shading and visible review marks.
- TXT represents low-confidence text as `⟦word⟧`, missing scores as `⟦?word?⟧`, and visible review marks as `✓`.
- Switching a display feature off also removes it from Word/TXT export.
- Corrections are exported; original wording and model scores remain in the JSON project.

SubRip and WebVTT are also available as caption formats. Caption export requires valid passage times. JSON projects do not embed media: attach the source recording after reopening a project. Multitoken corrections keep their original timing; they are not automatically realigned.

## Small shared builds and first use

The distributed app contains a small engine installer, the interface, and the Python orchestration source. It does **not** include Python, PyTorch, speaker embeddings, or transcription model weights.

On first transcription, the app downloads Python 3.12 and pinned engine dependencies into its local application-data directory. Model weights download into a local cache when their model is first used. Later uses reuse both. A failed or cancelled engine installation does not get a completion marker, so it can be retried. Initial setup requires an internet connection and roughly 1 GB of local engine storage, plus the selected models.

The installer manifest is versioned by its content and architecture. Dependency changes use a new environment rather than modifying an active one. App bundles are never modified during setup. Downloads and transcription run in background processes and can be cancelled.

## Development

Requirements: Node.js 22.12+, Rust, [uv](https://docs.astral.sh/uv/), and the [Tauri macOS prerequisites](https://v2.tauri.app/start/prerequisites/). Current distributed builds target Apple Silicon Macs. Signing and notarization are not configured.

```bash
uv sync --python 3.12 --extra speakers --extra dev
cd desktop
npm ci
npm run tauri dev
```

Development uses the project's `.venv`. For the browser preview, use `npm run dev`; recording playback, editing, JSON import, and exports work there. Transcription requires the desktop app.

## Packaging

A build without an included credential:

```bash
cd desktop
npm run build:portable -- --debug
```

This packages the first-use downloader and engine manifest. Recipients add a read token through Settings and accept the conditions for [speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) and [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0). Speaker detection can be disabled explicitly.

A private build for the intended small group:

```bash
cd desktop
npm run build:private -- --debug
```

It reads the app's saved Keychain credential and includes it in the app, so recipients need no account setup. `UV_BIN` may point to the local uv executable. Other build environments can provide `TRANSCRIPT_STUDIO_HF_TOKEN` through a secret manager. Never put the token in a shell command or tracked file.

The temporary credential is generated under the ignored `desktop/src-tauri/.private/` directory and removed after packaging. A recipient can extract a token included in an app; share that artifact only with its intended recipients. Do not upload private bundles or installers to GitHub. Source checks reject recognizable Hugging Face tokens and private artifacts in tracked files and report file names only. Native and private resources are blocked from the preview server.

The app is built at `desktop/src-tauri/target/debug/bundle/macos/Transcript Studio.app`. Omit `--debug` for a release build. Standard direct `tauri build` remains a development build using an external Python environment; use the portable/private packaging scripts for recipients.

The pinned first-use manifest can be regenerated after changing Python dependencies:

```bash
uv export --locked --no-emit-project --extra speakers --no-hashes --no-dev \
  --format requirements-txt --output-file desktop/src-tauri/engine-requirements.txt
```

## Command line

```bash
uv run --extra speakers transcribe recording.mp4 --output-dir data/output
uv run transcribe recording.mp4 --no-diarize --model small
```

CLI speaker detection uses `HF_TOKEN` or an existing Hugging Face login. Options include `--language`, `--device`, `--compute-type`, speaker bounds, `--start-time`, `--duration`, and `--cleanup-audio`. Model probabilities are uncalibrated estimates; high-confidence words can still be incorrect. On Apple Silicon, Whisper uses CPU/int8 and PyAnnote can use Metal.

The packaged binary also supports `--prepare-engine <local-data-directory>` to provision its engine without opening a window. This uses the same installation plan as the desktop workflow.

## Verification

```bash
uv run --extra dev pytest tests -q
python3 scripts/check_secrets.py
cd desktop
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Tests cover legacy transcript import, source safety, speaker assignment, confidence propagation, cache readiness, view persistence, pause thresholds and placement, untimed words, and matching Word/TXT content and formatting. Word output is additionally rendered for visual review. The upstream example transcripts remain importable.
