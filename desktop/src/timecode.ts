export const videoFrameRates = [
  { label: "23.976", rate: 24000 / 1001 },
  { label: "24", rate: 24 },
  { label: "25", rate: 25 },
  { label: "29.97", rate: 30000 / 1001 },
  { label: "30", rate: 30 },
  { label: "48", rate: 48 },
  { label: "50", rate: 50 },
  { label: "59.94", rate: 60000 / 1001 },
  { label: "60", rate: 60 },
];

export function decimalTime(time: number): string {
  if (!Number.isFinite(time) || time < 0) throw new Error("Invalid time.");
  const tenths = Math.round(time * 10 + 1e-9);
  const seconds = Math.floor(tenths / 10);
  const hms = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  return `${hms}.${tenths % 10}`;
}

// SMPTE non-drop timecode. Fractional rates count frames at the true rate,
// then number them using the nominal rate; frames are not decimal seconds.
export function frameTime(time: number, frameRate: number): string {
  if (
    !Number.isFinite(time) || time < 0 ||
    !Number.isFinite(frameRate) || frameRate < 1
  )
    throw new Error("Invalid time or frame rate.");
  const nominal = Math.round(frameRate);
  const frames = Math.round(time * frameRate + 1e-9);
  const seconds = Math.floor(frames / nominal);
  const hms = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  return hms + "." + String(frames % nominal).padStart(2, "0");
}
