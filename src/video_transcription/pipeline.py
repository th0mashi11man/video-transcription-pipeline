"""Shared segmentation and speaker-assignment utilities, plus the Whisper CLI."""

import warnings
from typing import Any, Dict, List, Optional, Tuple

# Suppress harmless third-party runtime warnings
warnings.filterwarnings("ignore", category=UserWarning, module=r"pyannote.*")
warnings.filterwarnings("ignore", category=SyntaxWarning, module=r"nagisa.*")
warnings.filterwarnings("ignore", message=r".*torchcodec.*")
warnings.filterwarnings("ignore", message=r".*upgrade_checkpoint.*")



def is_cjk(char: str) -> bool:
    """Check if character is within Chinese/Japanese/Korean unicode ranges."""
    code = ord(char)
    return (
        0x4E00 <= code <= 0x9FFF
        or 0x3400 <= code <= 0x4DBF
        or 0x3040 <= code <= 0x309F
        or 0x30A0 <= code <= 0x30FF
        or 0xAC00 <= code <= 0xD7AF
    )


def smart_join_tokens(tokens: List[str]) -> str:
    """Join tokens intelligently: insert spaces between non-CJK words, no spaces between CJK chars."""
    if not tokens:
        return ""
    result = []
    for i, token in enumerate(tokens):
        if i == 0:
            result.append(token)
            continue
        prev = tokens[i - 1]
        prev_is_cjk = prev and is_cjk(prev[-1])
        curr_is_cjk = token and is_cjk(token[0])
        # Only omit space when transitioning between CJK characters
        if prev_is_cjk and curr_is_cjk:
            result.append(token)
        else:
            result.append(" " + token)
    return "".join(result).strip()


def assign_speakers_to_words(
    words: List[Dict[str, Any]],
    speaker_turns: List[Tuple[float, float, str]],
) -> List[Dict[str, Any]]:
    """Assign speaker labels to words based on maximum temporal overlap with diarization intervals."""
    if not speaker_turns:
        return words

    for w in words:
        w_start = float(w["start"])
        w_end = float(w["end"])
        best_overlap = 0.0
        best_speaker = None
        min_dist = float("inf")
        closest_speaker = None

        w_mid = (w_start + w_end) / 2.0

        for t_start, t_end, speaker in speaker_turns:
            overlap = max(0.0, min(w_end, t_end) - max(w_start, t_start))
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = speaker

            dist = 0.0 if (t_start <= w_mid <= t_end) else min(abs(w_mid - t_start), abs(w_mid - t_end))
            if dist < min_dist:
                min_dist = dist
                closest_speaker = speaker

        w["speaker"] = best_speaker if best_speaker is not None else closest_speaker

    return words


def group_words_into_segments(
    words: List[Dict[str, Any]],
    max_duration: float = 7.0,
    pause_threshold: float = 1.0,
) -> List[Dict[str, Any]]:
    """Group aligned words into dialogue segments breaking on speaker change, pauses, or sentence punctuation."""
    if not words:
        return []

    segments: List[Dict[str, Any]] = []
    current_words: List[Dict[str, Any]] = []
    current_speaker = words[0].get("speaker")

    for w in words:
        speaker = w.get("speaker")
        speaker_changed = (speaker != current_speaker) if speaker is not None else False
        pause = (float(w["start"]) - float(current_words[-1]["end"])) if current_words else 0.0
        dur = (float(w["end"]) - float(current_words[0]["start"])) if current_words else 0.0
        ends_sentence = (
            current_words and current_words[-1]["text"].rstrip()[-1:] in ".?!。？！"
        )

        if current_words and (speaker_changed or pause > pause_threshold or dur > max_duration or ends_sentence):
            token_texts = [x["text"] for x in current_words]
            seg_text = smart_join_tokens(token_texts)
            segments.append({
                "start": float(current_words[0]["start"]),
                "end": float(current_words[-1]["end"]),
                "text": seg_text,
                "speaker": current_speaker,
                "words": current_words,
            })
            current_words = []
            current_speaker = speaker

        current_words.append(w)

    if current_words:
        token_texts = [x["text"] for x in current_words]
        seg_text = smart_join_tokens(token_texts)
        segments.append({
            "start": float(current_words[0]["start"]),
            "end": float(current_words[-1]["end"]),
            "text": seg_text,
            "speaker": current_speaker,
            "words": current_words,
        })

    return segments


def run_pipeline(*args, **kwargs):
    """Transcribe with Whisper and return the paths of the exported files."""
    from .whisper import transcribe_media
    _, paths = transcribe_media(*args, **kwargs)
    return paths


def main():
    from .whisper import main as whisper_main
    whisper_main()


if __name__ == "__main__":
    main()
