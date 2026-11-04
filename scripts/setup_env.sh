#!/usr/bin/env bash
set -e

# Always run from the project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "=== Setting up Video-to-Text Pipeline Environment ==="
echo "Project root: $ROOT_DIR"

# Check if uv is installed
if ! command -v uv &> /dev/null; then
    echo "Error: uv is not installed or not in PATH."
    echo "Install uv via: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

# Check if ffmpeg is installed
if ! command -v ffmpeg &> /dev/null; then
    echo "Warning: ffmpeg not found in PATH."
    if [ -f "/opt/homebrew/bin/ffmpeg" ]; then
        echo "Found ffmpeg in /opt/homebrew/bin/ffmpeg. Adding to PATH."
        export PATH="/opt/homebrew/bin:$PATH"
    else
        echo "Please install ffmpeg (e.g. brew install ffmpeg)."
    fi
else
    echo "Found ffmpeg at: $(command -v ffmpeg)"
fi

# Install a reproducible Python 3.12 environment, including speaker detection.
echo "Installing Whisper and PyAnnote into .venv with Python 3.12..."
uv sync --python 3.12 --extra speakers --extra dev

# Link package directory directly to site-packages (bypasses macOS UF_HIDDEN .pth issue completely)
SITE_PACKAGES=$(.venv/bin/python3 -c "import site; print(site.getsitepackages()[0])" 2>/dev/null || true)
if [ -n "$SITE_PACKAGES" ] && [ -d "$SITE_PACKAGES" ]; then
    ln -sfn "$ROOT_DIR/src/video_transcription" "$SITE_PACKAGES/video_transcription"
fi

# Ensure macOS does not set UF_HIDDEN on .venv .pth files (which Python 3.12 skips by default)
if [[ "$OSTYPE" == "darwin"* ]]; then
    chflags -R nohidden .venv 2>/dev/null || true
fi

echo "=== Environment setup complete! ==="
echo "To activate: source .venv/bin/activate"
echo "Or run scripts directly with uv: uv run transcribe <video>"
