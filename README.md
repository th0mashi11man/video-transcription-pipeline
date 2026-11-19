# Transcript Studio

A Mac app for creating and reviewing transcripts alongside audio or video, based on [misc-an/video-transcription-pipeline](https://github.com/misc-an/video-transcription-pipeline). Whisper recognizes words on the Apple GPU through MLX; PyAnnote identifies speakers through Metal. Processing stays local.

## Desktop app

The interface follows macOS system appearance, with a native title bar, compact toolbar, recording sidebar, transcript, and optional review inspector. Open a recording, choose Transcribe, and select words to listen and correct them. Space plays or pauses. Open…, Save, and Export… share a labelled toolbar group and the native File menu. Command + O opens a recording or project; Command + S saves the editable project; Command + Shift + E exports a copy.

Choose the recording's language from the Language menu, or leave **Detect automatically** selected. The menu lists Whisper's supported languages by name; Cantonese appears for Large v3 and Turbo, whose tokenizers support it.

Use Pauses in the visible transcript controls to show or hide automatic Jeffersonian pause notation:

- Gaps within a speaker's turn from 0.1 seconds to under 0.2 seconds use `(.)`.
- Longer gaps use tenths of a second, such as `(0.7)` or `(1.0)`.
- Pauses stay inline when the same speaker continues, including across ASR segments.
- A pause of at least 0.2 seconds between different speakers appears on its own line, without a speaker label. Shorter gaps between speakers are omitted.
- Overlaps, missing timing, and leading/trailing recording silence are not turned into pause symbols.

These are timing estimates from word boundaries, or passage boundaries in older imports. Listen to check them. The app does not infer breath, stress, intonation, or overlap notation. Turning pause display off does not alter source words or erase notation entered manually as text.

The toolbar keeps all transcript controls visible: Speakers, Timestamps, and Pauses are grouped together; Uncertainty, Confidence, and Review marks form a review group; Follow playback controls scrolling. Search filters the transcript separately. Consecutive segments by the same speaker form one displayed turn. Timestamps use the same word boundaries as the pause timings. Original diarization is retained and used to avoid adding pause symbols across detected overlaps. Display settings and the confidence threshold are preserved in saved `.tstudio` projects.

Playback and transcript timestamps show tenths of a second, such as `00:01:23.5`. Word and TXT exports use the same precision. Original word timings retain their full precision for playback, corrections, and pause calculation.

## Projects and files

Each project has its own window. **Open…** accepts recordings, `.tstudio` projects, and older JSON transcripts. **File → Open Recent** reopens recent projects. Opening a project that is already open focuses its existing window.

**Save** asks for a project name and location once, then updates that file. Changes autosave after the first save, including corrections, speaker information, transcript display settings, transcription choices, and a recording reference. Writes replace the project atomically; external changes produce an error rather than silently being overwritten. **File → Duplicate…** saves a separate project and opens it in another window. Unsaved changes are protected by Save / Don’t Save / Cancel when closing or quitting. Only one local transcription runs at a time across windows.

Recordings are linked, not embedded. A recording inside the project’s folder is linked relatively, so the folder can be moved together. If the recording has moved elsewhere, use **Locate Recording…** beside the player. **Replace Recording…** changes the current recording without removing transcript edits. Legacy JSON imports become untitled projects until saved as `.tstudio`.

## Export

Choose **Export…** in the toolbar or **File → Export As…**. On macOS, format, content, filename, and destination are chosen together in one native save sheet. Word (.docx) and plain text (.txt) create a separate copy and leave the project open. Both use the same turn and pause presentation as the screen. You can export the entire transcript or the current filtered view.

- Speaker names and start/end timestamps in tenths of a second are included when visible.
- Automatic pauses appear inline or on separate lines using the same rule as the screen.
- Word preserves uncertainty shading and visible review marks.
- TXT represents low-confidence text as `⟦word⟧`, missing scores as `⟦?word?⟧`, and visible review marks as `✓`.
- Switching a display feature off also removes it from Word/TXT export.
- Corrections are exported; original wording and model scores remain in the editable project.

SubRip and WebVTT are also available as caption formats. Caption export requires valid passage times. Projects reopen their linked recording automatically when it is available. Multitoken corrections keep their original timing; they are not automatically realigned.

For InqScribe, choose **InqScribe (.txt)**. This format uses frame-based `HH:MM:SS.FF` timecodes required by the importer, with the video's frame rate detected by the installed local engine. For audio or unknown rates, choose **Frame rate** in the export sheet (default 25 fps); the export sheet initially uses the project’s frame rate. Fractional rates use non-drop numbering. In InqScribe, use **File → Import → Tab-delimited Text**, select the exported text file, and set **Imported Frame Rate** to the same rate chosen in the app.

The file follows [InqScribe's four-field import format](https://docs.inqscribe.com/3.0/formats/tab-delimited-text/): start, end, speaker, transcript, without a header. It uses all turns or the current filtered view and respects display settings, including pauses, uncertainty markers, and review marks. Hidden or missing timestamps are left blank; no timing is invented. Pauses between speakers have an empty speaker field. Multiline text uses InqScribe's vertical-tab convention; tabs within text become spaces. Caption formats SRT and VTT retain the millisecond syntax required by their specifications.

## Small shared builds and first use

The distributed app contains a small engine installer, the interface, and the Python orchestration source. It does **not** include Python, PyTorch, speaker embeddings, or transcription model weights.

On first transcription, the app downloads Python 3.12 and pinned engine dependencies into its local application-data directory. Model weights download into a local cache when their model is first used. Later uses reuse both. A failed or cancelled engine installation does not get a completion marker, so it can be retried. Initial setup requires an internet connection and roughly 1 GB of local engine storage, plus the selected models.

The recording sidebar shows the current stage: engine setup, model download, model loading, GPU transcription, or speaker detection. Downloads show actual completed file counts; transcription and speaker processing show real progress when available. Work without a measurable total uses an indeterminate indicator. The app does not invent an ETA. Models stay on this Mac and are reused; switching to a model that has not been downloaded starts its own first-use download.

Apple Silicon uses [MLX Whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper), running on Metal in float16, with word timestamps and probability estimates. MLX model memory is released before PyAnnote uses the same GPU through PyTorch MPS. Existing Faster Whisper weights are a different format, so the first MLX run downloads an MLX model. The app still ships without any model weights. The Metal runtime is pinned to MLX 0.29.3 for compatibility with macOS 14 and later.

The installer manifest is versioned by its content and architecture. Dependency changes use a new environment rather than modifying an active one. App bundles are never modified during setup. Downloads and transcription run in background processes and can be cancelled.

## Development

Requirements: Node.js 22.12+, Rust, [uv](https://docs.astral.sh/uv/), and the [Tauri macOS prerequisites](https://v2.tauri.app/start/prerequisites/). Current distributed builds target Apple Silicon Macs running macOS 14 or later. Shared builds receive free local ad hoc signatures; no Apple Developer certificate or notarization service is used.

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
npm run build:portable
```

This packages the first-use downloader and engine manifest. A build without an included credential requires a previously saved Keychain credential. Provision it with the binary's `--store-token-stdin` command, which reads the token from standard input, and accept the conditions for [speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) and [segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0). The interface has no Settings menu. Speaker detection can be disabled explicitly.

A private build for the intended small group:

```bash
cd desktop
npm run build:private
```

It reads the app's saved Keychain credential and includes it in the app, so recipients need no account setup. `UV_BIN` may point to the local uv executable. Other build environments can provide `TRANSCRIPT_STUDIO_HF_TOKEN` through a secret manager. Never put the token in a shell command or tracked file.

The temporary credential is generated under the ignored `desktop/src-tauri/.private/` directory and removed after packaging. A recipient can extract a token included in an app; share that artifact only with its intended recipients. Do not upload private bundles or installers to GitHub. Source checks reject recognizable Hugging Face tokens and private artifacts in tracked files and report file names only. Native and private resources are blocked from the preview server.

The release app is built at `desktop/src-tauri/target/release/bundle/macos/Transcript Studio.app`. The packaging script signs the thinned downloader, builds the app, signs the final helper and complete app in that order, and runs strict recursive signature verification. It then copies the app and [first-launch guide](desktop/distribution/First%20launch.txt) into a ZIP, extracts it again, and verifies the delivered signatures. Any failed check stops packaging. Ad hoc signing never calls Apple's notarization service, and Apple signing/notarization credentials are excluded from the build environment.

The private Apple Silicon archive is `output/Transcript Studio-private-arm64.zip`, with a SHA-256 checksum alongside it. It contains a `Transcript Studio` folder with the app and `Read Me - First launch.txt`. Share the whole ZIP privately. Public builds omit `-private` from the archive name. `--debug` is still available for development and produces a separate `-debug.zip`; use the default release build for recipients. Direct `tauri build` does not run these distribution checks; use the portable/private packaging scripts for sharing.

### Opening a privately shared copy

The recipient should quit the old version, unzip the download, and move **Transcript Studio.app** into **Applications**. Because this build is not notarized, they must deliberately approve their downloaded copy. The included guide gives this one-time Terminal command:

```bash
xattr -dr com.apple.quarantine "/Applications/Transcript Studio.app"
```

This removes quarantine only from this app; it does not disable Gatekeeper for the Mac. The recipient can then open the app normally. A new download may require the same step. Previously downloaded models and saved credentials remain in the user's application data. Employer-managed Macs may enforce policies that prevent this approach.

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

CLI speaker detection uses `HF_TOKEN` or an existing Hugging Face login. Options include `--language`, `--device`, `--compute-type`, speaker bounds, `--start-time`, `--duration`, and `--cleanup-audio`. Model probabilities are uncalibrated estimates; high-confidence words can still be incorrect. Apple Silicon defaults to MLX/Metal; `--device mlx` explicitly selects it. `--device cpu` or `--device cuda` selects Faster Whisper with the corresponding compute type. `--compute-type` applies to Faster Whisper; MLX uses float16. PyAnnote selects MPS, CUDA, or CPU according to availability. `--progress-file` writes the current job stage and actual progress to an atomic JSON file.

The packaged binary also supports `--prepare-engine <local-data-directory>` to provision its engine without opening a window. This uses the same installation plan as the desktop workflow.

## Verification

```bash
uv run --extra dev pytest tests -q
python3 scripts/check_secrets.py
cd desktop
npm test
npm run test:packaging
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Tests cover project round trips, queued autosaves, atomic project replacement, external-change protection, movable recording links, legacy transcript import, source safety, speaker assignment, confidence propagation, cache readiness, view persistence, pause thresholds and placement, untimed words, and matching Word/TXT content and formatting. macOS packaging checks deliberately invalidate a real helper binary, repair it, verify extracted ZIP signatures and launch its executable, and ensure that changes after signing are rejected. Word output is additionally rendered for visual review. The upstream example transcripts remain importable.

For a native macOS export-sheet check, run `cargo run --manifest-path desktop/src-tauri/Cargo.toml --example export-sheet-check -- "Export check" docx --automatic` from the repository root. It checks all format filters and the scope/frame-rate controls in the actual Mac sheet, then closes without writing a file. Omit `--automatic` to select a destination and inspect the returned export choice manually.
