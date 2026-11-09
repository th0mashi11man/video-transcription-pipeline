import { rowText, speakerName, type DisplayRow } from "./presentation";
import type { TranscriptView } from "./transcript";
import { frameTime } from "./timecode";

// InqScribe's four-field import: start, end, speaker, transcript; no header.
// https://docs.inqscribe.com/3.0/formats/tab-delimited-text/
export function transcriptInqScribe(
  rows: DisplayRow[],
  view: TranscriptView,
) {
  const time = (value: number | null) =>
    view.timestamps && value !== null ? frameTime(value, view.frameRate) : "";
  return rows
    .map((row) => {
      const speaker =
        view.speakers && row.kind === "turn" ? speakerName(row.speaker) : "";
      return [
        time(row.start),
        time(row.end),
        speaker.replace(/[\t\r\n\v\u2028\u2029]/g, " "),
        // Tabs cannot appear inside fields; multiline text uses vertical tabs.
        rowText(row, view, true)
          .replace(/\t/g, " ")
          .replace(/\r\n?|\n|\u2028|\u2029/g, "\v"),
      ].join("\t");
    })
    .join("\n");
}
