import { normalizeTranscript } from "./transcript";

// Explicit sample estimates for exploring the review UI; never used for real media.
export const demo = normalizeTranscript({
  language: "English",
  engine: "Sample transcript · illustrative scores",
  mediaName: "Review walkthrough",
  segments: [
    {
      start: 0,
      end: 7,
      speaker: "SPEAKER_00",
      words: [
        ["A", 0, 0.2, 0.99],
        ["transcript", 0.2, 0.9, 0.98],
        ["is", 0.9, 1.2, 0.99],
        ["a", 1.2, 1.4, 0.99],
        ["starting", 1.4, 2, 0.94],
        ["point.", 2, 2.7, 0.97],
        ["Listening", 3.1, 3.8, 0.96],
        ["brings", 3.8, 4.3, 0.95],
        ["the", 4.3, 4.5, 0.99],
        ["details", 4.5, 5.2, 0.62],
        ["into", 5.2, 5.6, 0.98],
        ["focus.", 5.6, 6.8, 0.97],
      ],
    },
    {
      start: 7,
      end: 14,
      speaker: "SPEAKER_00",
      words: [
        ["Names,", 7, 7.6, 0.59],
        ["technical", 7.6, 8.3, 0.81],
        ["terms,", 8.3, 8.8, 0.76],
        ["and", 9, 9.3, 0.99],
        ["quiet", 9.3, 9.8, 0.66],
        ["passages", 9.8, 10.7, 0.92],
        ["often", 11, 11.5, 0.95],
        ["need", 11.5, 12, 0.98],
        ["another", 12, 12.6, 0.99],
        ["listen.", 12.6, 13.9, 0.96],
      ],
    },
    {
      start: 14,
      end: 21,
      speaker: "SPEAKER_01",
      words: [
        ["Select", 14, 14.6, 0.99],
        ["a", 14.6, 14.8, 0.99],
        ["word", 14.8, 15.3, 0.98],
        ["to", 15.3, 15.5, 0.99],
        ["review", 15.5, 16.1, 0.94],
        ["its", 16.1, 16.4, 0.98],
        ["context.", 16.4, 17.1, 0.97],
        ["Your", 17.5, 17.9, 0.97],
        ["corrections", 17.9, 18.7, null],
        ["stay", 18.7, 19.2, 0.97],
        ["with", 19.2, 19.6, 0.99],
        ["the", 19.6, 19.8, 0.99],
        ["transcript.", 19.8, 20.9, 0.97],
      ],
    },
  ].map((s) => ({
    ...s,
    words: s.words.map(([text, start, end, confidence]) => ({
      text,
      start,
      end,
      confidence,
    })),
  })),
});
