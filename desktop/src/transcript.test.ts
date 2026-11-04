import { describe, expect, it } from "vitest";
import {
  exportTranscript,
  needsReview,
  normalizeTranscript,
  serializeTranscript,
} from "./transcript";

describe("transcript import and review", () => {
  it("reads WhisperX alignment scores and Faster Whisper probabilities without inventing missing scores", () => {
    const t = normalizeTranscript({
      segments: [
        {
          start: 0,
          end: 2,
          words: [
            { word: "one", start: 0, end: 0.5, score: 0.6 },
            { text: "two", start: 0.5, end: 1, probability: 0.99 },
            { text: "three", start: 1, end: 2 },
          ],
        },
      ],
    });
    expect(t.segments[0].words.map((w) => w.confidence)).toEqual([
      0.6,
      0.99,
      null,
    ]);
    expect(t.segments[0].words.map((w) => needsReview(w, 0.8))).toEqual([
      true,
      false,
      true,
    ]);
  });
  it("retains original text, timing, and model confidence through corrections and reopening", () => {
    const t = normalizeTranscript({
      segments: [
        {
          start: 1,
          end: 2,
          words: [{ text: "wrong", start: 1, end: 2, confidence: 0.2 }],
        },
      ],
    });
    const w = t.segments[0].words[0];
    w.text = "right";
    w.reviewed = true;
    const saved = serializeTranscript(t);
    expect(saved.text).toBe("right");
    expect(saved.segments[0].text).toBe("right");
    expect(saved.words[0]).toMatchObject({
      originalText: "wrong",
      confidence: 0.2,
      start: 1,
      end: 2,
    });
    const reopened = normalizeTranscript(JSON.parse(JSON.stringify(saved)));
    expect(needsReview(reopened.segments[0].words[0], 0.9)).toBe(false);
    expect(exportTranscript(reopened, "srt")).toContain(
      "00:00:01,000 --> 00:00:02,000\nright",
    );
  });
  it("keeps missing and invalid timestamps untimed and refuses misleading subtitle export", () => {
    const t = normalizeTranscript({
      segments: [
        {
          text: "Untimed",
          words: [{ text: "Untimed", confidence: 4, start: -1, end: null }],
        },
      ],
    });
    expect(t.segments[0].words[0].confidence).toBeNull();
    expect(t.segments[0].start).toBeNull();
    expect(exportTranscript(t, "txt")).toBe("Untimed");
    expect(() => exportTranscript(t, "srt")).toThrow("valid start and end");
  });
  it("exports multilingual corrections without adding spaces between CJK tokens", () => {
    const t = normalizeTranscript({
      segments: [
        { start: 0, end: 1.9999, words: [{ text: "你" }, { text: "好" }] },
      ],
    });
    expect(exportTranscript(t, "vtt")).toBe(
      "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n你好\n",
    );
  });
  it("rejects non-transcript JSON and malformed word objects", () => {
    expect(() => normalizeTranscript({ foo: 1 })).toThrow(
      "no transcript segments",
    );
    expect(() =>
      normalizeTranscript({ segments: [{ words: [null] }] }),
    ).toThrow("Expected a transcript object");
  });
});
