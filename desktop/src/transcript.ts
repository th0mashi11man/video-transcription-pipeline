import { decimalTime, videoFrameRates } from "./timecode";

export type Word = {
  text: string;
  start: number | null;
  end: number | null;
  confidence: number | null;
  originalText: string;
  reviewed: boolean;
  speaker?: string | null;
};
export type Segment = {
  start: number | null;
  end: number | null;
  speaker: string | null;
  text: string;
  words: Word[];
  reviewed: boolean;
};
export type Transcript = {
  version: 1;
  language: string;
  engine: string;
  mediaName: string;
  segments: Segment[];
  speakerTurns?: { start: number; end: number; speaker: string }[];
  view?: TranscriptView;
};

export type TranscriptView = {
  speakers: boolean;
  timestamps: boolean;
  pauses: boolean;
  uncertainty: boolean;
  reviewed: boolean;
  confidenceThreshold: number;
  frameRate: number;
};
export const defaultView: TranscriptView = {
  speakers: true,
  timestamps: true,
  pauses: false,
  uncertainty: true,
  reviewed: false,
  confidenceThreshold: 0.8,
  frameRate: 25,
};

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a transcript object.");
  return value as Record<string, unknown>;
};
const time = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const score = (value: unknown): number | null => {
  const n = time(value);
  return n !== null && n <= 1 ? n : null;
};

export function normalizeTranscript(
  value: unknown,
  mediaName = "",
): Transcript {
  const input = record(value);
  if (!Array.isArray(input.segments))
    throw new Error("This JSON has no transcript segments.");
  const segments = input.segments.map((raw): Segment => {
    const s = record(raw);
    const words = Array.isArray(s.words)
      ? s.words.map((rawWord): Word => {
          const w = record(rawWord);
          if (typeof w.text !== "string" && typeof w.word !== "string")
            throw new Error("A transcript word is missing its text.");
          const text = String(w.text ?? w.word).trim();
          const start = time(w.start);
          const end = time(w.end);
          return {
            text,
            originalText:
              typeof w.originalText === "string" ? w.originalText : text,
            start,
            end: end !== null && start !== null && end < start ? null : end,
            confidence: score(w.confidence ?? w.probability ?? w.score),
            reviewed: w.reviewed === true,
            speaker: typeof w.speaker === "string" ? w.speaker : null,
          };
        })
      : [];
    const start = time(s.start);
    const end = time(s.end);
    return {
      start,
      end: end !== null && start !== null && end < start ? null : end,
      text: typeof s.text === "string" ? s.text : "",
      speaker: typeof s.speaker === "string" ? s.speaker : null,
      words,
      reviewed: s.reviewed === true,
    };
  });
  const rawTurns = input.speakerTurns ?? input.speaker_turns;
  const speakerTurns = Array.isArray(rawTurns)
    ? rawTurns.flatMap((raw) => {
        const t = record(raw);
        const start = time(t.start),
          end = time(t.end);
        return start !== null &&
          end !== null &&
          end > start &&
          typeof t.speaker === "string"
          ? [{ start, end, speaker: t.speaker }]
          : [];
      })
    : [];
  const rawView =
    input.view && typeof input.view === "object"
      ? (input.view as Record<string, unknown>)
      : {};
  const view = { ...defaultView };
  const savedFrameRate = videoFrameRates.find((r) => r.rate === rawView.frameRate);
  if (savedFrameRate) view.frameRate = savedFrameRate.rate;
  if (
    typeof rawView.confidenceThreshold === "number" &&
    Number.isFinite(rawView.confidenceThreshold) &&
    rawView.confidenceThreshold >= 0 &&
    rawView.confidenceThreshold <= 1
  ) {
    view.confidenceThreshold = rawView.confidenceThreshold;
  }
  for (const key of [
    "speakers",
    "timestamps",
    "pauses",
    "uncertainty",
    "reviewed",
  ] as const) {
    if (typeof rawView[key] === "boolean") view[key] = rawView[key];
  }
  return {
    version: 1,
    language: typeof input.language === "string" ? input.language : "Unknown",
    engine:
      typeof input.engine === "string" ? input.engine : "Imported transcript",
    mediaName:
      typeof input.mediaName === "string" ? input.mediaName : mediaName,
    segments,
    speakerTurns,
    view,
  };
}

export const segmentText = (s: Segment) =>
  s.words.length ? joinWords(s.words.map((w) => w.text)) : s.text;
export function joinWords(words: string[]) {
  return words.reduce((text, word) => {
    const cjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
    return (
      text +
      (text && !(cjk.test(text.slice(-1)) && cjk.test(word[0] ?? ""))
        ? " "
        : "") +
      word
    );
  }, "");
}
export const needsReview = (w: Word, threshold: number) =>
  !w.reviewed && (w.confidence === null || w.confidence < threshold);
export const passageNeedsReview = (s: Segment, threshold: number) =>
  !s.reviewed &&
  (s.words.length ? s.words.some((w) => needsReview(w, threshold)) : true);
export const formatTime = (n: number | null) => {
  if (n === null) return "Untimed";
  return decimalTime(n);
};
export const subtitleTime = (n: number, separator = ",") => {
  const ms = Math.round(n * 1000);
  return `${Math.floor(ms / 3600000)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 60000) % 60)
    .toString()
    .padStart(2, "0")}:${Math.floor((ms / 1000) % 60)
    .toString()
    .padStart(2, "0")}${separator}${(ms % 1000).toString().padStart(3, "0")}`;
};
export function serializeTranscript(t: Transcript) {
  const segments = t.segments.map((s) => ({ ...s, text: segmentText(s) }));
  return {
    ...t,
    text: segments.map((s) => s.text).join("\n"),
    segments,
    words: segments.flatMap((s) => s.words),
  };
}
export function exportTranscript(t: Transcript, kind: "txt" | "srt" | "vtt") {
  if (kind === "txt")
    return t.segments
      .map((s) => `${s.speaker ? s.speaker + ": " : ""}${segmentText(s)}`)
      .join("\n\n");
  if (
    t.segments.some(
      (s) => s.start === null || s.end === null || s.end <= s.start,
    )
  ) {
    throw new Error(
      "Subtitle export needs valid start and end times for every passage. Save as text or JSON instead.",
    );
  }
  return (
    (kind === "vtt" ? "WEBVTT\n\n" : "") +
    t.segments
      .map(
        (s, i) =>
          `${i + 1}\n${subtitleTime(s.start!, kind === "vtt" ? "." : ",")} --> ${subtitleTime(s.end!, kind === "vtt" ? "." : ",")}\n${segmentText(s)}\n`,
      )
      .join("\n")
  );
}
