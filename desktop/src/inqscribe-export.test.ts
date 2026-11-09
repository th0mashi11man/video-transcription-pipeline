import { describe, expect, it } from "vitest";
import { defaultView, normalizeTranscript } from "./transcript";
import { presentTranscript } from "./presentation";
import { transcriptInqScribe } from "./inqscribe-export";
import { frameTime } from "./timecode";

const view = { ...defaultView, pauses: true, reviewed: true };
const fixture = () => normalizeTranscript({
  segments: [
    {
      speaker: "SPEAKER_00",
      words: [
        { text: "Hallo", start: 0, end: 0.5, confidence: 0.6 },
        { text: "again", start: 1.2, end: 1.4, confidence: 0.99 },
        { text: "today.", start: 1.55, end: 1.7, confidence: 0.99 },
      ],
    },
    {
      speaker: "SPEAKER_01",
      words: [{ text: "Yes.", start: 2.3, end: 2.8, reviewed: true }],
    },
  ],
});

describe("InqScribe tab-delimited import export", () => {
  it("writes headerless four-field records with video-frame times and unassigned pauses", () => {
    expect(transcriptInqScribe(presentTranscript(fixture(), view), view)).toBe(
      "00:00:00.00\t00:00:01.18\tSpeaker 1\t⟦Hallo⟧ (0.7) again (.) today.\n" +
      "00:00:01.18\t00:00:02.08\t\t(0.6)\n" +
      "00:00:02.08\t00:00:02.20\tSpeaker 2\tYes.✓",
    );
  });
  it("omits disabled display features without losing text or inventing times", () => {
    const hidden = {
      ...defaultView, speakers: false, timestamps: false,
      uncertainty: false, reviewed: false, pauses: false,
    };
    expect(transcriptInqScribe(presentTranscript(fixture(), hidden), hidden)).toBe(
      "\t\t\tHallo again today.\n\t\t\tYes.",
    );
  });
  it("leaves missing timing fields blank and retains missing confidence markers", () => {
    const t = normalizeTranscript({ segments: [{ speaker: "A", text: "Untimed" }] });
    expect(transcriptInqScribe(presentTranscript(t, view), view)).toBe(
      "\t\tA\t⟦?Untimed?⟧",
    );
  });
  it("encodes multiline text as vertical tabs and prevents embedded field separators", () => {
    const t = normalizeTranscript({ segments: [{
      speaker: "A\tB\nC", text: "Åsa\t& <李>\r\nsecond\rthird\nfourth",
      start: 3599.9996, end: 3601.2,
    }] });
    const clean = { ...defaultView, uncertainty: false };
    const text = transcriptInqScribe(presentTranscript(t, clean), clean);
    expect(text).toBe(
      "01:00:00.00\t01:00:01.05\tA B C\tÅsa & <李>\vsecond\vthird\vfourth",
    );
    expect(text.split("\n")).toHaveLength(1);
    expect(text.split("\t")).toHaveLength(4);
  });
  it("exports only supplied rows for the current-view scope", () => {
    const rows = presentTranscript(fixture(), view);
    expect(transcriptInqScribe(rows.slice(-1), view)).toBe(
      "00:00:02.08\t00:00:02.20\tSpeaker 2\tYes.✓",
    );
    expect(transcriptInqScribe([], view)).toBe("");
  });
  it("rounds to the nearest frame and carries frames through seconds, minutes, and hours", () => {
    expect(frameTime(0.02, 25)).toBe("00:00:00.01");
    expect(frameTime(0.999, 25)).toBe("00:00:01.00");
    expect(frameTime(59.999, 30)).toBe("00:01:00.00");
    expect(frameTime(3599.999, 24)).toBe("01:00:00.00");
  });
  it("counts fractional video rates as non-drop frames rather than decimal seconds", () => {
    expect(frameTime(60.06, 30000 / 1001)).toBe("00:01:00.00");
    expect(frameTime(60.06, 24000 / 1001)).toBe("00:01:00.00");
    expect(frameTime(60.06, 60000 / 1001)).toBe("00:01:00.00");
    expect(frameTime(3600, 30000 / 1001)).toBe("00:59:56.12");
  });
});
