import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import {
  defaultView,
  normalizeTranscript,
  serializeTranscript,
} from "./transcript";
import {
  pauseNotation,
  presentTranscript,
  rowText,
  rowsToText,
  rowHeading,
} from "./presentation";
import { transcriptDocx } from "./word-export";

const fixture = () =>
  normalizeTranscript({
    mediaName: "Interview.wav",
    language: "en",
    speaker_turns: [
      { start: 0, end: 0.6, speaker: "SPEAKER_00" },
      { start: 1.1, end: 1.8, speaker: "SPEAKER_00" },
      { start: 2.2, end: 3, speaker: "SPEAKER_01" },
    ],
    segments: [
      {
        start: 0,
        end: 0.5,
        speaker: "SPEAKER_00",
        words: [{ text: "Hello", start: 0, end: 0.5, confidence: 0.6 }],
      },
      {
        start: 1.2,
        end: 1.7,
        speaker: "SPEAKER_00",
        words: [
          { text: "again", start: 1.2, end: 1.4, confidence: 0.95 },
          { text: "today.", start: 1.55, end: 1.7, confidence: 0.99 },
        ],
      },
      {
        start: 2.3,
        end: 2.8,
        speaker: "SPEAKER_01",
        words: [
          {
            text: "Yes.",
            start: 2.3,
            end: 2.8,
            confidence: 0.9,
            reviewed: true,
          },
        ],
      },
    ],
  });
const withPauses = { ...defaultView, pauses: true };

describe("Jeffersonian pause presentation", () => {
  it("uses micropause and tenths of seconds and never treats overlap as silence", () => {
    expect(pauseNotation(0.09)).toBeNull();
    expect(pauseNotation(0.1)).toBe("(.)");
    expect(pauseNotation(0.199)).toBe("(.)");
    expect(pauseNotation(0.2)).toBe("(0.2)");
    expect(pauseNotation(0.74)).toBe("(0.7)");
    expect(pauseNotation(1)).toBe("(1.0)");
    expect(pauseNotation(-0.3)).toBeNull();
    expect(pauseNotation(NaN)).toBeNull();
  });
  it("keeps same-speaker pauses inline across segments and diarization spans", () => {
    const rows = presentTranscript(fixture(), withPauses);
    expect(rows.map((r) => r.kind)).toEqual(["turn", "pause", "turn"]);
    expect(rowText(rows[0], withPauses)).toBe("Hello (0.7) again (.) today.");
    expect(rows[0].segments).toEqual([0, 1]);
    expect(rows[0].start).toBe(0);
    expect(rows[0].end).toBe(1.7);
  });
  it("puts a gap between different speakers on a separate unassigned line", () => {
    const rows = presentTranscript(fixture(), withPauses);
    expect(rows[1].speaker).toBeNull();
    expect(rowText(rows[1], withPauses)).toBe("(0.6)");
    expect(rowHeading(rows[1], withPauses)).toBe("");
    expect(rowsToText(rows, withPauses)).toContain("\n\n(0.6)\n\n");
  });
  it("removes all pause symbols when switched off, without modifying source words", () => {
    const t = fixture(),
      before = JSON.stringify(t);
    expect(
      rowsToText(presentTranscript(t, defaultView), defaultView),
    ).not.toMatch(/\([.\d]/);
    expect(JSON.stringify(t)).toBe(before);
  });
  it("does not infer a pause through missing or reversed word timing", () => {
    const t = normalizeTranscript({
      segments: [
        {
          speaker: "SPEAKER_00",
          words: [
            { text: "One", start: 0, end: 1 },
            { text: "unknown" },
            { text: "two", start: 3, end: 4 },
            { text: "overlap", start: 3.5, end: 4.5 },
          ],
        },
      ],
    });
    expect(
      presentTranscript(t, withPauses)
        .flatMap((r) => r.tokens)
        .some((t) => t.kind === "pause"),
    ).toBe(false);
  });
  it("does not turn overlapping diarized speaker turns into an interspeaker pause", () => {
    const t = fixture();
    t.speakerTurns![1].end = 2.5;
    const rows = presentTranscript(t, withPauses);
    expect(rows.filter((row) => row.kind === "pause")).toHaveLength(0);
    expect(rows.filter((row) => row.kind === "turn")).toHaveLength(2);
  });
  it("retains speaker turns and display settings when saving and reopening", () => {
    const t = {
      ...fixture(),
      view: { ...withPauses, reviewed: true, confidenceThreshold: 0.9 },
    };
    const reopened = normalizeTranscript(
      JSON.parse(JSON.stringify(serializeTranscript(t))),
    );
    expect(reopened.speakerTurns).toEqual(t.speakerTurns);
    expect(reopened.view).toEqual(t.view);
  });
  it("uses valid passage boundaries for older transcripts without word timing", () => {
    const t = normalizeTranscript({
      segments: [
        { speaker: "SPEAKER_00", text: "Hello", start: 0, end: 0.5 },
        { speaker: "SPEAKER_00", text: "again", start: 1.2, end: 1.7 },
        { speaker: "SPEAKER_01", text: "Yes", start: 2.3, end: 2.8 },
      ],
    });
    const rows = presentTranscript(t, withPauses);
    expect(rows.map((r) => r.kind)).toEqual(["turn", "pause", "turn"]);
    expect(rowText(rows[0], withPauses)).toBe("Hello (0.7) again");
    expect(rowText(rows[1], withPauses)).toBe("(0.6)");
  });
});

describe("matching Word and text exports", () => {
  it("exports the same speaker turns, precise times, pauses, and corrected words", async () => {
    const t = fixture();
    t.segments[0].words[0].text = "Hallo";
    const view = { ...withPauses, reviewed: true };
    const rows = presentTranscript(t, view);
    const txt = rowsToText(rows, view);
    expect(txt).toContain("[00:00:00.000–00:00:01.700] Speaker 1:");
    expect(txt).toContain("⟦Hallo⟧ (0.7) again (.) today.");
    expect(txt).toContain("Yes.✓");
    const zip = unzipSync(await transcriptDocx("Interview", rows, view));
    const xml = strFromU8(zip["word/document.xml"]);
    for (const value of [
      "Hallo",
      "(0.7)",
      "(.)",
      "(0.6)",
      "Speaker 1:",
      "Speaker 2:",
      "00:00:01.700",
      "✓",
    ])
      expect(xml).toContain(value);
    expect(xml).toContain("FFF0B3");
    expect(xml).not.toContain("Hello");
  });
  it("omits every disabled display feature from both formats", async () => {
    const view = {
      ...defaultView,
      speakers: false,
      timestamps: false,
      uncertainty: false,
      reviewed: false,
    };
    const rows = presentTranscript(fixture(), view);
    expect(rowsToText(rows, view)).toBe("Hello again today.\n\nYes.");
    const zip = unzipSync(await transcriptDocx("Interview", rows, view));
    const xml = strFromU8(zip["word/document.xml"]);
    for (const value of ["Speaker 1:", "00:00:", "FFF0B3", "(0.7)", "✓"])
      expect(xml).not.toContain(value);
  });
  it("marks missing confidence distinctly in text and Word", async () => {
    const t = fixture();
    t.segments[0].words[0].confidence = null;
    const rows = presentTranscript(t, defaultView);
    expect(rowsToText(rows, defaultView)).toContain("⟦?Hello?⟧");
    const zip = unzipSync(await transcriptDocx("Interview", rows, defaultView));
    expect(strFromU8(zip["word/document.xml"])).toContain("E5E7EB");
  });
});
