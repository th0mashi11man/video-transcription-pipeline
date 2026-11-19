import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { defaultView, normalizeTranscript, renameSpeaker, speakerName } from "./transcript";
import { presentTranscript, rowHeading, rowsToText } from "./presentation";
import { transcriptDocx } from "./word-export";
import { transcriptInqScribe } from "./inqscribe-export";
import { defaultOptions, makeProject, readProject } from "./project";

const fixture = () => normalizeTranscript({
  mediaName: "Interview.wav",
  speaker_turns: [{speaker: "SPEAKER_00", start: 83.48, end: 85.9}],
  segments: [
    {speaker:"SPEAKER_00", start:83.48, end:85.9, text:"Hello", words:[{text:"Hello", start:83.48, end:85.9, confidence:0.9}]},
    {speaker:"SPEAKER_01", start:87.36, end:88.2, text:"Yes"},
    {speaker:"SPEAKER_00", start:89.12, end:90.7, text:"Again"},
  ],
});

describe("speaker names", () => {
  it("renames every occurrence while preserving speaker identities, diarization and precise timings", () => {
    const original = fixture();
    const changed = renameSpeaker(original, "SPEAKER_00", "  Åsa   Andersson  ");
    expect(changed.segments).toEqual(original.segments);
    expect(changed.speakerTurns).toEqual(original.speakerTurns);
    expect(original.speakerNames).toEqual({});
    const rows = presentTranscript(changed);
    expect(rows.map(row => row.speakerLabel)).toEqual(["Åsa Andersson", "Speaker 2", "Åsa Andersson"]);
    expect(rowHeading(rows[0], defaultView)).toBe("Åsa Andersson · 1:23");
    expect(rows[0].start).toBe(83.48);
    expect(rows[0].end).toBe(85.9);
  });
  it("does not merge distinct speakers with the same display name", () => {
    const changed = renameSpeaker(renameSpeaker(fixture(), "SPEAKER_00", "Alex"), "SPEAKER_01", "Alex");
    expect(presentTranscript(changed)).toHaveLength(3);
  });
  it("restores names when reopening a saved project", () => {
    const changed = renameSpeaker(fixture(), "SPEAKER_00", "Interviewer");
    const project = makeProject(changed, null, defaultView, defaultOptions);
    const reopened = readProject(JSON.parse(JSON.stringify(project))).transcript!;
    expect(reopened.speakerNames).toEqual({SPEAKER_00:"Interviewer"});
    expect(presentTranscript(reopened)[0].speakerLabel).toBe("Interviewer");
  });
  it("supports unnamed imported speakers and validates edited names", () => {
    const t = normalizeTranscript({segments:[{text:"Hello", start:0, end:1}]});
    expect(presentTranscript(renameSpeaker(t, null, "Narrator"))[0].speakerLabel).toBe("Narrator");
    expect(() => renameSpeaker(t, null, " \t ")).toThrow("Enter a speaker name");
    expect(() => renameSpeaker(t, null, "x".repeat(81))).toThrow("80");
    expect(speakerName("toString")).toBe("toString");
    expect(normalizeTranscript({segments:[], speakerNames:{SPEAKER_00:4, SPEAKER_01:"  "}}).speakerNames).toEqual({});
  });
  it("exports renamed speakers and single start timestamps to Word/TXT while preserving InqScribe frame fields", async () => {
    const t = renameSpeaker(fixture(), "SPEAKER_00", "Åsa & 李");
    const rows = presentTranscript(t);
    const txt = rowsToText(rows, defaultView);
    const xml = strFromU8(unzipSync(await transcriptDocx("Interview", rows, defaultView))["word/document.xml"]);
    expect(txt).toContain("Åsa & 李 · 1:23");
    expect(xml).toContain("Åsa &amp; 李 · 1:23");
    for (const content of [txt, xml]) {
      expect(content).not.toContain("SPEAKER_00");
      expect(content).not.toContain("–");
      expect(content).not.toContain("1:25");
    }
    const fields = transcriptInqScribe(rows, defaultView).split("\n")[0].split("\t");
    expect(fields).toEqual(["00:01:23.12", "00:01:25.23", "Åsa & 李", "Hello"]);
    const hidden = {...defaultView, speakers:false, timestamps:false};
    const hiddenRows = presentTranscript(t, hidden);
    expect(rowsToText(hiddenRows, hidden)).toBe("Hello\n\n⟦?Yes?⟧\n\n⟦?Again?⟧");
    expect(transcriptInqScribe(hiddenRows, hidden)).not.toContain("Åsa");
  });
});
