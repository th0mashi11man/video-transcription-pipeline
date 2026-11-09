import {
  defaultView,
  formatTime,
  needsReview,
  type Transcript,
  type TranscriptView,
  type Word,
} from "./transcript";

export type DisplayToken = {
  kind: "word" | "pause";
  text: string;
  start: number | null;
  end: number | null;
  segment: number;
  word: number | null;
  uncertainty: "low" | "unknown" | null;
  reviewed: boolean;
};
export type DisplayRow = {
  id: string;
  kind: "turn" | "pause";
  speaker: string | null;
  start: number | null;
  end: number | null;
  tokens: DisplayToken[];
  segments: number[];
};

// Only timing estimates are produced. No overlap, breath, stress, or intonation
// symbols are invented from ASR text. Untimed words break pause inference.
export function pauseNotation(gap: number): string | null {
  if (!Number.isFinite(gap) || gap + 1e-6 < 0.1) return null;
  return gap + 1e-6 < 0.2 ? "(.)" : `(${gap.toFixed(1)})`;
}

export function turnTime(time: number | null): string {
  return formatTime(time);
}
export function speakerName(speaker: string | null) {
  const match = speaker?.match(/^SPEAKER_(\d+)$/);
  return match ? `Speaker ${Number(match[1]) + 1}` : speaker || "Speaker";
}
export function rowHeading(row: DisplayRow, view: TranscriptView) {
  if (row.kind === "pause") return "";
  const parts = [];
  if (view.timestamps)
    parts.push(
      `[${turnTime(row.start)}${row.end !== null ? "–" + turnTime(row.end) : ""}]`,
    );
  if (view.speakers && row.kind === "turn")
    parts.push(speakerName(row.speaker) + ":");
  return parts.join(" ");
}

function alignedTurn(t: Transcript, w: Word, speaker: string | null) {
  if (w.start === null || w.end === null) return -1;
  let best = -1,
    overlap = 0;
  (t.speakerTurns ?? []).forEach((turn, i) => {
    if (speaker && turn.speaker !== speaker) return;
    const amount = Math.max(
      0,
      Math.min(turn.end, w.end!) - Math.max(turn.start, w.start!),
    );
    if (amount > overlap) {
      best = i;
      overlap = amount;
    }
  });
  return best;
}

export function presentTranscript(
  t: Transcript,
  view = t.view ?? defaultView,
  threshold = view.confidenceThreshold,
): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let current: DisplayRow | undefined;
  let previous: DisplayToken | undefined;
  let diarizedEnd: number | null = null;

  t.segments.forEach((segment, si) => {
    const units: { value: Word; index: number | null }[] = segment.words.length
      ? segment.words.map((value, index) => ({ value, index }))
      : [
          {
            index: null,
            value: {
              text: segment.text,
              start: segment.start,
              end: segment.end,
              speaker: segment.speaker,
              confidence: null,
              reviewed: segment.reviewed,
              originalText: segment.text,
            },
          },
        ];
    units.forEach(({ value: w, index: wi }) => {
      const speaker = w.speaker ?? segment.speaker;
      const turnIndex = alignedTurn(t, w, speaker);
      const breakTurn = !current || current.speaker !== speaker;
      const gap =
        previous?.end !== null &&
        previous?.end !== undefined &&
        w.start !== null
          ? w.start - previous.end
          : -1;
      const nextTurn = t.speakerTurns?.[turnIndex];
      const overlappingTurns =
        breakTurn &&
        diarizedEnd !== null &&
        nextTurn !== undefined &&
        diarizedEnd >= nextTurn.start - 1e-6;
      const notation =
        view.pauses &&
        !overlappingTurns &&
        (!breakTurn || gap + 1e-6 >= 0.2)
          ? pauseNotation(gap)
          : null;
      if (notation && previous) {
        const pause: DisplayToken = {
          kind: "pause",
          text: notation,
          start: previous.end,
          end: w.start,
          segment: si,
          word: null,
          uncertainty: null,
          reviewed: false,
        };
        if (breakTurn && current && current.speaker !== speaker) {
          rows.push({
            id: `pause-${si}-${wi}`,
            kind: "pause",
            speaker: null,
            start: pause.start,
            end: pause.end,
            tokens: [pause],
            segments: [previous.segment, si],
          });
        } else current?.tokens.push(pause);
      }
      if (breakTurn) {
        current = {
          id: `turn-${si}-${wi}`,
          kind: "turn",
          speaker,
          start: w.start,
          end: w.end,
          tokens: [],
          segments: [],
        };
        rows.push(current);
        diarizedEnd = nextTurn?.end ?? null;
      }
      const token: DisplayToken = {
        kind: "word",
        text: w.text,
        start: w.start,
        end: w.end,
        segment: si,
        word: wi,
        uncertainty:
          view.uncertainty && needsReview(w, threshold)
            ? w.confidence === null
              ? "unknown"
              : "low"
            : null,
        reviewed: w.reviewed,
      };
      current!.tokens.push(token);
      if (!current!.segments.includes(si)) current!.segments.push(si);
      if (nextTurn) diarizedEnd = Math.max(diarizedEnd ?? nextTurn.end, nextTurn.end);
      const turnEnd = w.end;
      if (turnEnd !== null)
        current!.end = Math.max(current!.end ?? turnEnd, turnEnd);
      previous = token;
    });
  });
  return rows;
}

export function tokenSeparator(
  previous: DisplayToken | undefined,
  next: DisplayToken,
) {
  if (!previous) return "";
  const cjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
  return cjk.test(previous.text.slice(-1)) && cjk.test(next.text[0] ?? "")
    ? ""
    : " ";
}
export function rowText(
  row: DisplayRow,
  view: TranscriptView,
  plainMarkers = false,
) {
  return row.tokens
    .map((token, index) => {
      let text = token.text;
      if (plainMarkers && token.uncertainty)
        text = token.uncertainty === "unknown" ? `⟦?${text}?⟧` : `⟦${text}⟧`;
      if (view.reviewed && token.reviewed && token.kind === "word") text += "✓";
      return tokenSeparator(row.tokens[index - 1], token) + text;
    })
    .join("");
}
export function rowsToText(rows: DisplayRow[], view: TranscriptView) {
  return rows
    .map((row) =>
      [rowHeading(row, view), rowText(row, view, true)]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}
