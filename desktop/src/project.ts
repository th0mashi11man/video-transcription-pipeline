import { defaultView, normalizeTranscript, serializeTranscript, type Transcript, type TranscriptView } from './transcript';

export type ProjectOptions = { model: string; language: string; speakers: boolean; followPlayback: boolean };
export const defaultOptions: ProjectOptions = { model: 'small', language: '', speakers: true, followPlayback: true };
export type Project = {
  format: 'transcript-studio-project';
  version: 1;
  transcript: ReturnType<typeof serializeTranscript> | null;
  recording: { path: string; name: string } | null;
  view: TranscriptView;
  options: ProjectOptions;
};
export type RecentProject = { path: string; name: string };
export type OpenedProject = { transcript: Transcript | null; recording: Project['recording']; view: TranscriptView; options: ProjectOptions; legacy: boolean };
export function readProject(raw: unknown): OpenedProject {
  const data = raw as Partial<Project> | null;
  if (data?.format !== 'transcript-studio-project') {
    const transcript = normalizeTranscript(raw);
    return { transcript, recording: null, view: transcript.view ?? { ...defaultView }, options: { ...defaultOptions }, legacy: true };
  }
  if (data.version !== 1) throw new Error('This project needs a newer version of Transcript Studio.');
  if (!data.transcript && !data.recording) throw new Error('This project contains no recording or transcript.');
  const transcript = data.transcript ? normalizeTranscript(data.transcript) : null;
  if (data.recording && (typeof data.recording.path !== 'string' || typeof data.recording.name !== 'string')) throw new Error('The project’s recording link is invalid.');
  // Use the transcript normalizer to validate the display options as well.
  const view = normalizeTranscript({ segments: [], view: data.view ?? transcript?.view }).view ?? { ...defaultView };
  const options = data.options;
  return {
    transcript, recording: data.recording ?? null, view, legacy: false,
    options: {
      model: ['tiny', 'base', 'small', 'medium', 'large-v3', 'turbo'].includes(options?.model ?? '') ? options!.model : 'small',
      language: typeof options?.language === 'string' ? options.language : '',
      speakers: typeof options?.speakers === 'boolean' ? options.speakers : true,
      followPlayback: typeof options?.followPlayback === 'boolean' ? options.followPlayback : true,
    },
  };
}
export function makeProject(transcript: Transcript | null, recording: Project['recording'], view: TranscriptView, options: ProjectOptions): Project {
  return { format: 'transcript-studio-project', version: 1, transcript: transcript ? serializeTranscript({ ...transcript, view }) : null, recording, view, options };
}

/** Serialize writes so a slow autosave can never overwrite a more recent explicit save. */
export class SaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(write: () => Promise<T>): Promise<T> {
    const next = this.tail.then(write, write);
    this.tail = next.catch(() => {});
    return next;
  }
}
