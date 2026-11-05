import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import {
  AudioLines,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Download,
  FileAudio,
  FileJson,
  FileText,
  FolderOpen,
  Headphones,
  Keyboard,
  Link,
  ListFilter,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  Pause,
  Play,
  Repeat2,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SkipForward,
  SlidersHorizontal,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { demo } from "./demo";
import {
  exportTranscript,
  formatTime,
  needsReview,
  normalizeTranscript,
  passageNeedsReview,
  segmentText,
  serializeTranscript,
  type Transcript,
} from "./transcript";

type Media = { url: string; name: string; path?: string; audio: boolean };
type Job = {
  status: "idle" | "running" | "complete" | "failed" | "cancelled";
  log: string;
  result?: unknown;
};
const native = isTauri();
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const mediaExtensions = [
  "mp4",
  "mov",
  "m4v",
  "webm",
  "mkv",
  "mp3",
  "m4a",
  "wav",
  "flac",
  "ogg",
  "aac",
  "opus",
];

export default function App() {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [sample, setSample] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [threshold, setThreshold] = useState(0.8);
  const [reviewOnly, setReviewOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<{
    segment: number;
    word: number | null;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [includedAccess, setIncludedAccess] = useState(false);
  const [followPlayback, setFollowPlayback] = useState(true);
  const [settings, setSettings] = useState(false);
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [python, setPython] = useState("");
  const [model, setModel] = useState("small");
  const [language, setLanguage] = useState("");
  const [speakers, setSpeakers] = useState(true);
  const [job, setJob] = useState<Job>({ status: "idle", log: "" });
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const player = useRef<HTMLVideoElement>(null);
  const clip = useRef<{ start: number; end: number } | null>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  const busy = job.status === "running";
  const words = transcript?.segments.flatMap((s) => s.words) ?? [];
  const flagged = words.filter((w) => needsReview(w, threshold)).length;
  const unknown = words.filter((w) => w.confidence === null).length;
  const reviewed = words.filter((w) => w.reviewed).length;
  const speakerIds = [
    ...new Set(transcript?.segments.map((s) => s.speaker) ?? []),
  ];
  const currentSegment =
    selected && transcript ? transcript.segments[selected.segment] : null;
  const currentWord =
    currentSegment && selected?.word !== null
      ? currentSegment.words[selected!.word!]
      : null;

  useEffect(() => {
    if (native)
      invoke<{ ready: boolean; included: boolean }>("credential_status")
        .then((status) => {
          setConnected(status.ready);
          setIncludedAccess(status.included);
        })
        .catch((e) => setError(message(e)));
  }, []);
  useEffect(() => {
    if (!settings) return;
    const lastFocus = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const controls = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary",
        ) ?? [],
      ).filter((el) => el.getClientRects().length > 0);
    controls()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.addEventListener("keydown", trapFocus);
    return () => {
      dialog?.removeEventListener("keydown", trapFocus);
      lastFocus?.focus();
    };
  }, [settings]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirty || busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    let dispose: (() => void) | undefined;
    let disposed = false;
    if (native)
      import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
        getCurrentWindow()
          .onCloseRequested(async (event) => {
            if (!(dirty || busy)) return;
            event.preventDefault();
            if (
              await confirm(
                busy
                  ? "Cancel transcription and close?"
                  : "Close without saving your edits?",
                { title: "Transcript Studio", kind: "warning" },
              )
            ) {
              if (busy) await invoke("cancel_transcription");
              await getCurrentWindow().destroy();
            }
          })
          .then((unlisten) => {
            if (disposed) unlisten();
            else dispose = unlisten;
          });
      });
    return () => {
      disposed = true;
      dispose?.();
      window.removeEventListener("beforeunload", handler);
    };
  }, [dirty, busy]);
  useEffect(() => {
    if (!busy) return;
    let stopped = false;
    const id = window.setInterval(async () => {
      try {
        const next = await invoke<Job>("transcription_status");
        if (stopped) return;
        if (next.status === "complete" && next.result) {
          setTranscript(normalizeTranscript(next.result, media?.name));
          setSample(false);
          setSelected(null);
          revision.current++;
          setDirty(true);
          setNotice("Transcript ready. Start with the highlighted words.");
        }
        if (next.status === "failed")
          setError(
            "Transcription failed. Check the activity log below for the cause.",
          );
        setJob(next);
      } catch (e) {
        if (!stopped) {
          setError(message(e));
          setJob((j) => ({ ...j, status: "failed" }));
        }
      }
    }, 1000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [busy, media?.name]);
  useEffect(
    () => () => {
      if (media?.url.startsWith("blob:")) URL.revokeObjectURL(media.url);
    },
    [media],
  );
  useEffect(() => {
    clip.current = null;
    setNow(0);
    setDuration(0);
  }, [media?.url]);

  async function discard() {
    return (
      !dirty ||
      (native
        ? await confirm(
            "Replace the current transcript without saving your edits?",
            { kind: "warning" },
          )
        : window.confirm(
            "Replace the current transcript without saving your edits?",
          ))
    );
  }
  async function chooseMedia() {
    setError("");
    if (sample && !(await discard())) return;
    if (!native) {
      mediaInput.current?.click();
      return;
    }
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Audio or video", extensions: mediaExtensions }],
      });
      if (typeof path !== "string") return;
      const canonical = await invoke<string>("open_media", { path });
      attachMedia({
        path: canonical,
        url: convertFileSrc(canonical),
        name: canonical.split(/[\\/]/).pop()!,
        audio: /\.(mp3|m4a|wav|flac|ogg|aac|opus)$/i.test(canonical),
      });
    } catch (e) {
      setError(message(e));
    }
  }
  function attachMedia(next: Media) {
    setMedia(next);
    if (
      transcript &&
      !sample &&
      transcript.mediaName &&
      transcript.mediaName !== next.name
    ) {
      setNotice(
        `Attached ${next.name}. Confirm that this is the recording for “${transcript.mediaName}”.`,
      );
    } else
      setNotice(
        "Recording attached. You can transcribe it or open an existing transcript.",
      );
    if (sample) {
      setTranscript(null);
      setSelected(null);
      setSample(false);
      setDirty(false);
    }
  }
  async function loadTranscript(raw: unknown) {
    try {
      const parsed = normalizeTranscript(raw, media?.name);
      if (!(await discard())) return;
      player.current?.pause();
      clip.current = null;
      setTranscript(parsed);
      setSelected(null);
      setSample(false);
      setDirty(false);
      revision.current++;
      setNotice(
        media
          ? "Transcript opened. Check that the attached recording matches."
          : "Transcript opened. Attach its recording to listen alongside it.",
      );
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }
  async function chooseTranscript() {
    if (!native) {
      jsonInput.current?.click();
      return;
    }
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Transcript JSON", extensions: ["json"] }],
      });
      if (typeof path === "string")
        await loadTranscript(
          JSON.parse(await invoke<string>("read_transcript", { path })),
        );
    } catch (e) {
      setError(message(e));
    }
  }
  async function writeFile(content: string, extension: string) {
    const name =
      (transcript?.mediaName || media?.name || "transcript").replace(
        /\.[^.]+$/,
        "",
      ) + `.reviewed.${extension}`;
    if (native) {
      const path = await save({
        defaultPath: name,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (!path) return false;
      await invoke("write_document", { path, content });
    } else {
      const url = URL.createObjectURL(
        new Blob([content], {
          type:
            extension === "json"
              ? "application/json"
              : "text/plain;charset=utf-8",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return true;
  }
  async function saveTranscript() {
    if (!transcript) return;
    const rev = revision.current;
    try {
      if (
        await writeFile(
          JSON.stringify(serializeTranscript(transcript), null, 2),
          "json",
        )
      ) {
        if (rev === revision.current) setDirty(false);
        setNotice(
          "Saved transcript, original wording, confidence scores, and review decisions.",
        );
      }
    } catch (e) {
      setError(message(e));
    }
  }
  async function exportFile(kind: "txt" | "srt" | "vtt") {
    if (!transcript) return;
    try {
      if (await writeFile(exportTranscript(transcript, kind), kind))
        setNotice(
          `${kind.toUpperCase()} exported. Save JSON to preserve your review decisions.`,
        );
    } catch (e) {
      setError(message(e));
    }
  }
  function select(segment: number, word: number | null) {
    const s = transcript!.segments[segment];
    setSelected({ segment, word });
    setDraft(word === null ? segmentText(s) : s.words[word].text);
    clip.current = null;
    const start = word === null ? s.start : s.words[word].start;
    if (!sample && start !== null && player.current) {
      player.current.currentTime = start;
      setNow(start);
    }
  }
  async function replay() {
    if (!currentSegment || !player.current || !media || sample) return;
    const start = currentWord?.start ?? currentSegment.start;
    const end = currentWord?.end ?? currentSegment.end;
    if (start === null || end === null || end <= start) {
      setError(
        "This passage has no usable timing. Use the recording controls to find it.",
      );
      return;
    }
    clip.current = {
      start: Math.max(0, start - 1),
      end: Math.min(duration || Infinity, end + 1),
    };
    player.current.currentTime = clip.current.start;
    try {
      await player.current.play();
    } catch (e) {
      setError(message(e));
    }
  }
  function updateSelected(markPassage = false) {
    if (!selected || !transcript || !currentSegment) return;
    if (!markPassage && !draft.trim()) {
      setError("Enter a correction before saving.");
      return;
    }
    const next = structuredClone(transcript);
    const s = next.segments[selected.segment];
    if (markPassage) {
      s.reviewed = true;
      s.words.forEach((w) => {
        w.reviewed = true;
      });
    } else if (selected.word !== null) {
      s.words[selected.word].text = draft.trim();
      s.words[selected.word].reviewed = true;
    } else {
      s.text = draft.trim();
      s.reviewed = true;
    }
    setTranscript(next);
    revision.current++;
    setDirty(true);
    setError("");
  }
  function nextIssue() {
    if (!transcript) return;
    const issues = transcript.segments.flatMap((s, si) =>
      s.words.length
        ? s.words.flatMap((w, wi) =>
            needsReview(w, threshold)
              ? [{ segment: si, word: wi as number | null }]
              : [],
          )
        : !s.reviewed
          ? [{ segment: si, word: null }]
          : [],
    );
    const next =
      issues.find(
        (p) =>
          !selected ||
          p.segment > selected.segment ||
          (p.segment === selected.segment &&
            (p.word ?? -1) > (selected.word ?? -1)),
      ) ?? issues[0];
    if (!next) {
      setNotice("No flagged words remain at this threshold.");
      return;
    }
    setReviewOnly(false);
    setQuery("");
    select(next.segment, next.word);
    window.setTimeout(
      () =>
        document
          .getElementById(`segment-${next.segment}`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      50,
    );
  }
  async function transcribe() {
    if (!native || !media?.path || !(await discard())) return;
    setError("");
    setNotice("");
    try {
      await invoke("start_transcription", {
        mediaPath: media.path,
        python: python.trim() || null,
        model,
        language: language.trim() || null,
        speakers,
      });
      setJob({ status: "running", log: "Starting local transcription…" });
    } catch (e) {
      setError(message(e));
    }
  }
  async function storeToken() {
    setTokenBusy(true);
    setError("");
    try {
      await invoke("save_token", { token: token.trim() });
      setToken("");
      setConnected(true);
      setNotice(
        "Token saved securely. Model access will be checked when you transcribe.",
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setTokenBusy(false);
    }
  }
  async function setupLink(page: string) {
    const urls: Record<string, string> = {
      token: "https://huggingface.co/settings/tokens",
      community:
        "https://huggingface.co/pyannote/speaker-diarization-community-1",
      segmentation: "https://huggingface.co/pyannote/segmentation-3.0",
    };
    try {
      if (native) await invoke("open_setup_page", { page });
      else window.open(urls[page], "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(message(e));
    }
  }

  const totalIssues =
    flagged +
    (transcript?.segments.filter((s) => !s.words.length && !s.reviewed)
      .length ?? 0);
  const visibleSegments =
    transcript?.segments.filter(
      (s) =>
        (!reviewOnly || passageNeedsReview(s, threshold)) &&
        segmentText(s).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? [];
  const activeSegment =
    transcript?.segments.findIndex(
      (s) =>
        s.start !== null && s.end !== null && now >= s.start && now < s.end,
    ) ?? -1;
  const knownSpeakers = speakerIds.filter(Boolean);
  const currentConfidence = currentWord?.confidence;
  const projectName = (
    media?.name ||
    transcript?.mediaName ||
    "Untitled project"
  ).replace(/\.[^.]+$/, "");

  useEffect(() => {
    if (followPlayback && playing && activeSegment >= 0) {
      document
        .getElementById(`segment-${activeSegment}`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeSegment, followPlayback, playing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveTranscript();
      } else if (
        !editing &&
        !target.closest("button, a, summary") &&
        event.code === "Space" &&
        media &&
        !sample
      ) {
        event.preventDefault();
        void togglePlayback();
      } else if (!editing && event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        nextIssue();
      } else if (event.key === "Escape") setSettings(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function togglePlayback() {
    if (!player.current || !media) return;
    clip.current = null;
    try {
      if (player.current.paused) await player.current.play();
      else player.current.pause();
    } catch (e) {
      setError(message(e));
    }
  }
  function seekTo(seconds: number) {
    if (!player.current || !media) return;
    clip.current = null;
    player.current.currentTime = Math.max(
      0,
      Math.min(duration || Infinity, seconds),
    );
    setNow(player.current.currentTime);
  }
  async function showSample() {
    if (!(await discard())) return;
    player.current?.pause();
    setTranscript(structuredClone(demo));
    setSample(true);
    setSelected(null);
    setDirty(false);
    setError("");
  }

  return (
    <div className="studio-shell">
      <nav className="app-rail" aria-label="Workspace actions">
        <div className="app-mark" title="Transcript Studio">
          <AudioLines size={24} />
        </div>
        <button
          className="rail-button active"
          aria-label="Transcript workspace"
          onClick={() => setSettings(false)}
        >
          <FileText size={21} />
        </button>
        <button
          className="rail-button"
          aria-label="Open recording"
          onClick={chooseMedia}
          disabled={busy}
        >
          <FolderOpen size={21} />
        </button>
        <button
          className="rail-button"
          aria-label="Open transcript"
          onClick={chooseTranscript}
          disabled={busy}
        >
          <FileJson size={21} />
        </button>
        <div className="rail-bottom">
          <button
            className="rail-button"
            aria-label="Settings"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={21} />
          </button>
          <span className="profile-monogram" title="Local workspace">
            TS
          </span>
        </div>
      </nav>
      <div className="studio-main">
        <header className="studio-header">
          <div className="project-identity">
            <span className="project-kicker">
              TRANSCRIPT STUDIO <span>/</span> WORKSPACE
            </span>
            <div className="project-name">
              <h1>{projectName}</h1>
              {dirty ? (
                <span className="document-state unsaved">
                  <span /> Unsaved changes
                </span>
              ) : (
                <span className="document-state">
                  <Check size={12} /> {transcript ? "Saved" : "Local project"}
                </span>
              )}
            </div>
          </div>
          <div className="header-actions">
            <button
              className="quiet-button open-project"
              onClick={chooseTranscript}
              disabled={busy}
            >
              <FolderOpen size={16} /> Open project
            </button>
            <button
              className="quiet-button"
              aria-label="Save project"
              disabled={!transcript || busy}
              onClick={saveTranscript}
            >
              <Save size={16} /> Save <kbd>⌘S</kbd>
            </button>
            <div className="export-control">
              <Download size={15} />
              <select
                aria-label="Export transcript"
                value=""
                disabled={!transcript || busy}
                onChange={(e) => {
                  if (e.target.value)
                    void exportFile(e.target.value as "txt" | "srt" | "vtt");
                }}
              >
                <option value="" disabled>
                  Export
                </option>
                <option value="txt">Plain text</option>
                <option value="srt">SRT subtitles</option>
                <option value="vtt">WebVTT subtitles</option>
              </select>
              <ChevronDown size={12} />
            </div>
          </div>
        </header>
        <div className="workspace-tabs">
          <span className="workspace-tab">
            <FileText size={14} /> Transcript <span className="tab-dot" />
          </span>
          <span className="workspace-description">Listen. Review. Refine.</span>
          <div className="processing-badge">
            <span /> Processed on your computer
          </div>
        </div>
        {error && (
          <div role="alert" className="message-banner error">
            <CircleHelp size={16} />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="message-banner notice">
            <Check size={15} />
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="Dismiss notice"
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <main className="studio-workspace">
          <section className="source-column" aria-label="Recording">
            <div className="panel-label">
              <h2>Recording</h2>
              <button
                className="icon-button"
                aria-label="Choose a different recording"
                onClick={chooseMedia}
                disabled={busy}
              >
                <FolderOpen size={16} />
              </button>
            </div>
            <div className={`media-stage ${media?.audio ? "is-audio" : ""}`}>
              {media ? (
                <>
                  <video
                    ref={player}
                    src={media.url}
                    preload="metadata"
                    muted={muted}
                    playsInline
                    onLoadedMetadata={(e) => {
                      setDuration(
                        Number.isFinite(e.currentTarget.duration)
                          ? e.currentTarget.duration
                          : 0,
                      );
                      e.currentTarget.playbackRate = speed;
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                    onSeeking={() => {
                      const p = player.current;
                      if (
                        p &&
                        clip.current &&
                        (p.currentTime < clip.current.start - 0.2 ||
                          p.currentTime > clip.current.end + 0.2)
                      )
                        clip.current = null;
                    }}
                    onTimeUpdate={(e) => {
                      const p = e.currentTarget;
                      setNow(p.currentTime);
                      if (clip.current && p.currentTime >= clip.current.end) {
                        if (loop) p.currentTime = clip.current.start;
                        else {
                          p.pause();
                          clip.current = null;
                        }
                      }
                    }}
                    onError={() =>
                      setError(
                        "This file cannot be played. Try MP4 video or WAV/MP3 audio supported by your system.",
                      )
                    }
                  />
                  {media.audio && (
                    <div className="audio-identity">
                      <div className="audio-icon">
                        <AudioLines size={46} strokeWidth={1.4} />
                      </div>
                      <span>AUDIO RECORDING</span>
                      <strong>{media.name}</strong>
                      <small>
                        {formatTime(duration)}
                        {knownSpeakers.length
                          ? ` · ${knownSpeakers.length} speaker${knownSpeakers.length === 1 ? "" : "s"}`
                          : ""}
                      </small>
                    </div>
                  )}
                  {!media.audio && (
                    <button
                      className="video-play-overlay"
                      aria-label={playing ? "Pause video" : "Play video"}
                      onClick={togglePlayback}
                    >
                      {playing ? <Pause size={24} /> : <Play size={24} />}
                    </button>
                  )}
                </>
              ) : (
                <div className="source-empty">
                  <div className="audio-icon">
                    <Headphones size={38} strokeWidth={1.3} />
                  </div>
                  <h3>Start with a recording</h3>
                  <p>
                    Open an audio or video file
                    <br />
                    to create your transcript.
                  </p>
                  <button className="primary-button" onClick={chooseMedia}>
                    <Upload size={15} /> Open recording
                  </button>
                  <small>MP4, MOV, MP3, WAV, and more</small>
                </div>
              )}
            </div>
            <div className="playback-block">
              <div className="transport">
                <span className="transport-time">
                  {formatTime(now)} <span>/ {formatTime(duration)}</span>
                </span>
                <div className="transport-buttons">
                  <button
                    className="icon-button"
                    aria-label="Back 3 seconds"
                    disabled={!media}
                    onClick={() => seekTo(now - 3)}
                  >
                    <RotateCcw size={18} />
                    <span className="seconds-label">3</span>
                  </button>
                  <button
                    className="play-button"
                    aria-label={playing ? "Pause recording" : "Play recording"}
                    disabled={!media}
                    onClick={togglePlayback}
                  >
                    {playing ? (
                      <Pause size={19} fill="currentColor" />
                    ) : (
                      <Play size={19} fill="currentColor" />
                    )}
                  </button>
                  <button
                    className="icon-button"
                    aria-label="Forward 3 seconds"
                    disabled={!media}
                    onClick={() => seekTo(now + 3)}
                  >
                    <RotateCw size={18} />
                    <span className="seconds-label">3</span>
                  </button>
                </div>
                <label className="speed-control">
                  <select
                    aria-label="Playback speed"
                    value={speed}
                    onChange={(e) => {
                      const rate = Number(e.target.value);
                      setSpeed(rate);
                      if (player.current) player.current.playbackRate = rate;
                    }}
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => (
                      <option key={s} value={s}>
                        {s}×
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="seek-track">
                <div className="confidence-markers" aria-hidden="true">
                  {!sample &&
                    duration > 0 &&
                    transcript?.segments.flatMap((s, si) =>
                      s.words.map((w, wi) =>
                        needsReview(w, threshold) && w.start !== null ? (
                          <i
                            key={`${si}-${wi}`}
                            style={{
                              left: `${Math.min(100, (w.start / duration) * 100)}%`,
                              width: `${Math.max(0.6, (((w.end ?? w.start) - w.start) / duration) * 100)}%`,
                            }}
                          />
                        ) : null,
                      ),
                    )}
                </div>
                <input
                  aria-label="Recording position"
                  type="range"
                  min="0"
                  max={duration || 1}
                  step="0.01"
                  value={Math.min(now, duration || 1)}
                  disabled={!media}
                  onChange={(e) => seekTo(Number(e.target.value))}
                  style={
                    {
                      "--progress": `${duration ? (now / duration) * 100 : 0}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
              <div className="timeline-caption">
                <span>
                  {transcript && !sample ? (
                    <>
                      <i /> Amber marks need a closer listen
                    </>
                  ) : (
                    "Select a word to jump to its time"
                  )}
                </span>
                <button
                  className="icon-button"
                  aria-label={muted ? "Unmute recording" : "Mute recording"}
                  disabled={!media}
                  onClick={() => setMuted(!muted)}
                >
                  {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                </button>
              </div>
            </div>
            <div className="source-details">
              <div>
                <FileAudio size={15} />
                <span>{media?.name || "No file selected"}</span>
                {media && (
                  <span className="file-type">
                    {media.audio ? "AUDIO" : "VIDEO"}
                  </span>
                )}
              </div>
              <dl>
                <div>
                  <dt>Language</dt>
                  <dd>{transcript?.language || "Auto-detect"}</dd>
                </div>
                <div>
                  <dt>Speakers</dt>
                  <dd>{knownSpeakers.length || "—"}</dd>
                </div>
                <div>
                  <dt>Words</dt>
                  <dd>{transcript ? words.length : "—"}</dd>
                </div>
              </dl>
            </div>
            <div className="transcribe-section">
              <div className="panel-label">
                <h2>Transcription</h2>
                <button
                  className="icon-button"
                  aria-label="Transcription settings"
                  onClick={() => setSettings(true)}
                >
                  <SlidersHorizontal size={16} />
                </button>
              </div>
              <label className="compact-setting">
                Quality
                <select
                  value={model}
                  disabled={busy}
                  onChange={(e) => setModel(e.target.value)}
                >
                  <option value="tiny">Quick · Tiny</option>
                  <option value="base">Fast · Base</option>
                  <option value="small">Balanced · Small</option>
                  <option value="medium">Detailed · Medium</option>
                  <option value="large-v3">Best · Large v3</option>
                  <option value="turbo">Fast & detailed · Turbo</option>
                </select>
              </label>
              <label className="toggle-setting">
                <span>Identify speakers</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={speakers}
                  disabled={busy}
                  onChange={(e) => setSpeakers(e.target.checked)}
                />
              </label>
              <div className={`engine-state ${connected ? "ready" : ""}`}>
                <ShieldCheck size={14} />
                <span>
                  {connected
                    ? includedAccess
                      ? "Speaker access included"
                      : "Speaker access ready"
                    : native
                      ? "Speaker access: set up in Settings"
                      : "Local engine available in desktop app"}
                </span>
              </div>
              <button
                className="primary-button generate-button"
                disabled={!native || !media || busy}
                onClick={transcribe}
              >
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <AudioLines size={17} />
                )}{" "}
                {busy
                  ? "Transcribing…"
                  : transcript
                    ? "Transcribe again"
                    : "Transcribe recording"}
                <ChevronRight size={15} />
              </button>
              {busy && (
                <button
                  className="text-button cancel-job"
                  onClick={async () => {
                    try {
                      await invoke("cancel_transcription");
                      setJob((j) => ({ ...j, status: "cancelled" }));
                    } catch (e) {
                      setError(message(e));
                    }
                  }}
                >
                  Cancel transcription
                </button>
              )}
              {!native && (
                <p className="small-note">
                  Preview mode. Transcription runs in the desktop app.
                </p>
              )}
            </div>
            {job.status !== "idle" && (
              <details className="activity" open={job.status === "failed"}>
                <summary>
                  <span className={busy ? "activity-pulse" : ""} />
                  {busy
                    ? "Transcribing locally"
                    : `Transcription ${job.status}`}
                  <ChevronDown size={13} />
                </summary>
                <pre>{job.log || "Starting the local engine…"}</pre>
              </details>
            )}
            <div className="source-bottom">
              <LockKeyhole size={13} />
              <span>Your recording stays on this device</span>
            </div>
          </section>
          <section className="transcript-column" aria-label="Transcript">
            <div className="transcript-heading">
              <div>
                <h2>Transcript</h2>
                <span>
                  {sample
                    ? "Sample transcript · illustrative scores"
                    : transcript
                      ? `${words.length} words · ${transcript.segments.length} passages`
                      : "Your words, in context"}
                </span>
              </div>
              {transcript && (
                <label className="follow-control">
                  <input
                    type="checkbox"
                    checked={followPlayback}
                    onChange={(e) => setFollowPlayback(e.target.checked)}
                  />
                  Follow playback
                </label>
              )}
            </div>
            {transcript ? (
              <>
                <div className="transcript-tools">
                  <div className="search-field">
                    <Search size={15} />
                    <input
                      aria-label="Search transcript"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Find in transcript…"
                    />
                    {query && (
                      <button
                        className="icon-button"
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                      >
                        <X size={12} />
                      </button>
                    )}
                    <kbd>⌕</kbd>
                  </div>
                  <button
                    className={`review-filter ${reviewOnly ? "is-active" : ""}`}
                    aria-pressed={reviewOnly}
                    onClick={() => setReviewOnly(!reviewOnly)}
                  >
                    <ListFilter size={14} />
                    Needs review<span>{totalIssues}</span>
                  </button>
                </div>
                <div className="transcript-context">
                  <div>
                    <span className="legend-amber" />
                    Below{" "}
                    <select
                      aria-label="Confidence threshold"
                      value={threshold}
                      onChange={(e) => setThreshold(Number(e.target.value))}
                    >
                      {[0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((n) => (
                        <option key={n} value={n}>
                          {Math.round(n * 100)}%
                        </option>
                      ))}
                    </select>{" "}
                    confidence
                  </div>
                  <span>
                    {reviewed} of {words.length} reviewed
                  </span>
                </div>
                <div className="passages-scroll">
                  {visibleSegments.length === 0 && (
                    <div className="no-results">
                      <CheckCheck size={27} />
                      <h3>
                        {query ? "No matching passages" : "All caught up"}
                      </h3>
                      <p>
                        {query
                          ? "Try another word or clear the filters."
                          : "No words need review at this confidence threshold."}
                      </p>
                    </div>
                  )}
                  {transcript.segments.map((s, si) => {
                    if (
                      (reviewOnly && !passageNeedsReview(s, threshold)) ||
                      !segmentText(s)
                        .toLocaleLowerCase()
                        .includes(query.toLocaleLowerCase())
                    )
                      return null;
                    const active = !sample && !!media && activeSegment === si;
                    return (
                      <article
                        id={`segment-${si}`}
                        key={si}
                        className={`passage ${selected?.segment === si ? "is-selected" : ""} ${active ? "is-playing" : ""}`}
                      >
                        <div className="passage-gutter">
                          <button
                            className="timestamp"
                            onClick={() =>
                              select(si, s.words.length ? 0 : null)
                            }
                          >
                            {formatTime(s.start)}
                          </button>
                          <span
                            className={`speaker-dot speaker-${speakerIds.indexOf(s.speaker) % 4}`}
                          />
                        </div>
                        <div className="passage-content">
                          <div className="passage-heading">
                            <span
                              className={`speaker-name speaker-${speakerIds.indexOf(s.speaker) % 4}`}
                            >
                              {s.speaker
                                ? s.speaker.replace("SPEAKER_", "Speaker ")
                                : "Speaker unassigned"}
                            </span>
                            {s.reviewed ? (
                              <span className="passage-reviewed">
                                <Check size={11} />
                                Reviewed
                              </span>
                            ) : (
                              <button
                                className="passage-play"
                                aria-label={`Play passage at ${formatTime(s.start)}`}
                                disabled={!media || sample || s.start === null}
                                onClick={() => {
                                  select(si, s.words.length ? 0 : null);
                                  seekTo(s.start ?? 0);
                                  void player.current
                                    ?.play()
                                    .catch((e) => setError(message(e)));
                                }}
                              >
                                <Play size={11} />
                                Listen
                              </button>
                            )}
                          </div>
                          <p className="passage-text">
                            {s.words.length ? (
                              s.words.map((w, wi) => (
                                <span key={wi}>
                                  {wi > 0 ? " " : ""}
                                  <button
                                    className={`word ${needsReview(w, threshold) ? (w.confidence === null ? "has-no-score" : "is-uncertain") : ""} ${w.reviewed ? "is-reviewed" : ""} ${selected?.segment === si && selected.word === wi ? "is-selected" : ""} ${!sample && media && w.start !== null && w.end !== null && now >= w.start && now < w.end ? "is-current" : ""}`}
                                    aria-label={`${w.text}, ${w.confidence === null ? "confidence unavailable" : `${Math.round(w.confidence * 100)}% confidence`}${w.reviewed ? ", reviewed" : ""}`}
                                    onClick={() => select(si, wi)}
                                  >
                                    {w.text}
                                  </button>
                                </span>
                              ))
                            ) : (
                              <button
                                className="untimed-text"
                                onClick={() => select(si, null)}
                              >
                                {s.text || "(Empty passage)"}
                              </button>
                            )}
                          </p>
                        </div>
                      </article>
                    );
                  })}
                  <div className="transcript-end">
                    <span />
                    <span>
                      {sample ? "END OF SAMPLE" : "END OF TRANSCRIPT"}
                    </span>
                    <span />
                  </div>
                </div>
                <div className="transcript-footer">
                  <span>
                    <i className="legend-amber" />
                    Needs review
                  </span>
                  {unknown > 0 && (
                    <span>
                      <i className="legend-unknown" />
                      No score ({unknown})
                    </span>
                  )}
                  <span>
                    <Check size={12} />
                    Reviewed
                  </span>
                  <button className="text-button" onClick={nextIssue}>
                    Next issue
                    <SkipForward size={13} />
                  </button>
                </div>
              </>
            ) : (
              <div className="transcript-empty">
                <div className="empty-document">
                  <FileText size={40} strokeWidth={1} />
                </div>
                <h2>Ready when you are.</h2>
                <p>
                  Open a recording, then transcribe it.
                  <br />
                  Uncertain words will be highlighted here.
                </p>
                <button className="secondary-button" onClick={chooseMedia}>
                  <FolderOpen size={16} />
                  Open recording
                </button>
                <button
                  className="text-button sample-link"
                  onClick={showSample}
                >
                  Explore a sample
                  <ChevronRight size={14} />
                </button>
                <div className="empty-shortcut">
                  <Headphones size={14} />
                  <span>Already have a transcript?</span>
                  <button className="text-button" onClick={chooseTranscript}>
                    Open JSON
                  </button>
                </div>
              </div>
            )}
          </section>
          <aside className="review-column" aria-label="Word review">
            <div className="panel-label">
              <h2>Review</h2>
              <span className="review-count">{totalIssues} to check</span>
            </div>
            {selected && currentSegment ? (
              <div className="word-editor">
                <div className="selected-label">
                  {currentWord ? "SELECTED WORD" : "SELECTED PASSAGE"}
                  <button
                    className="icon-button"
                    aria-label="Close word editor"
                    onClick={() => setSelected(null)}
                  >
                    <X size={14} />
                  </button>
                </div>
                <h3 className="selected-text">
                  {currentWord?.text || segmentText(currentSegment)}
                </h3>
                <div
                  className={`confidence-readout ${currentConfidence !== null && currentConfidence !== undefined && currentConfidence < threshold ? "low" : ""}`}
                >
                  {currentConfidence === null ||
                  currentConfidence === undefined ? (
                    <>
                      <CircleHelp size={15} />
                      Confidence unavailable
                    </>
                  ) : (
                    <>
                      <span className="confidence-value">
                        {Math.round(currentConfidence * 100)}
                        <small>%</small>
                      </span>
                      <span>model confidence</span>
                    </>
                  )}
                </div>
                {typeof currentConfidence === "number" && (
                  <div
                    className="confidence-meter"
                    style={
                      {
                        "--confidence": `${currentConfidence * 100}%`,
                      } as React.CSSProperties
                    }
                  >
                    <span />
                  </div>
                )}
                <p className="confidence-explanation">
                  {currentWord?.reviewed
                    ? "Reviewed by you. The original model score is kept."
                    : currentConfidence === null ||
                        currentConfidence === undefined
                      ? "No score was supplied. Listen to check this passage."
                      : currentConfidence < threshold
                        ? "A closer listen would help. Check the word in its original context."
                        : "The model is fairly confident. You can still listen and make a correction."}
                </p>
                <div className="review-divider" />
                <div className="review-section-label">
                  LISTEN IN CONTEXT
                  <span>
                    {formatTime(currentWord?.start ?? currentSegment.start)}
                  </span>
                </div>
                <button
                  className="context-button"
                  disabled={!media || sample || currentSegment.start === null}
                  onClick={replay}
                >
                  <Play size={16} fill="currentColor" />
                  Replay context<span>±1s</span>
                </button>
                <label className="toggle-setting loop-setting">
                  <span>
                    <Repeat2 size={14} />
                    Loop this section
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={loop}
                    onChange={(e) => setLoop(e.target.checked)}
                  />
                </label>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    updateSelected();
                  }}
                >
                  <label className="correction-label" htmlFor="word-correction">
                    CORRECT THE TEXT
                  </label>
                  <textarea
                    id="word-correction"
                    aria-label="Correction"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={busy}
                    rows={2}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        updateSelected();
                      }
                    }}
                  />
                  {currentWord &&
                    currentWord.text !== currentWord.originalText && (
                      <p className="original-word">
                        Original: <span>{currentWord.originalText}</span>
                      </p>
                    )}
                  <button
                    type="submit"
                    aria-label="Save correction"
                    className="primary-button save-correction"
                    disabled={busy || !draft.trim()}
                  >
                    <Check size={16} />
                    Save correction<kbd>⌘↵</kbd>
                  </button>
                </form>
                <button
                  className="review-passage-button"
                  disabled={busy}
                  onClick={() => updateSelected(true)}
                >
                  <CheckCheck size={16} />
                  Mark passage reviewed
                </button>
                <button className="next-issue-button" onClick={nextIssue}>
                  Next issue
                  <SkipForward size={15} />
                </button>
              </div>
            ) : (
              <div className="review-empty">
                <div className="review-empty-icon">
                  <Headphones size={26} strokeWidth={1.3} />
                </div>
                <h3>A closer listen.</h3>
                <p>
                  Select a highlighted word to hear it in context and make a
                  correction.
                </p>
                {transcript && totalIssues > 0 && (
                  <button className="secondary-button" onClick={nextIssue}>
                    Review next word
                    <SkipForward size={14} />
                  </button>
                )}
                <div className="review-guide">
                  <span>
                    <i className="legend-amber" />
                    Low confidence
                  </span>
                  <p>Amber highlights point to words worth checking.</p>
                  <span>
                    <Check size={13} />
                    Reviewed
                  </span>
                  <p>Your corrections keep the original timing.</p>
                </div>
              </div>
            )}
            <div className="review-bottom">
              <Keyboard size={14} />
              <div>
                <span>
                  <kbd>Space</kbd> Play / pause
                </span>
                <span>
                  <kbd>⌥ →</kbd> Next issue
                </span>
              </div>
            </div>
          </aside>
        </main>
        <footer className="status-bar">
          <span>
            <span className="status-dot" />
            Local workspace{sample && <b>Sample · no recording linked</b>}
          </span>
          <span>
            {transcript
              ? `${transcript.language} · ${knownSpeakers.length} speaker${knownSpeakers.length === 1 ? "" : "s"}`
              : "Audio & video transcription"}
            <span className="status-separator" />
            Confidence is a review aid, not a guarantee.
          </span>
        </footer>
      </div>
      {settings && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSettings(false);
          }}
        >
          <section
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <header>
              <div>
                <span className="eyebrow">WORKSPACE</span>
                <h2 id="settings-title">Transcription settings</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close settings"
                onClick={() => setSettings(false)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="settings-body">
              <div className="settings-intro">
                <ShieldCheck size={20} />
                <div>
                  <strong>
                    {connected
                      ? includedAccess
                        ? "Speaker access is included"
                        : "Speaker access is ready"
                      : "Speaker access"}
                  </strong>
                  <p>
                    {includedAccess
                      ? "This private build is already connected. No account setup is needed."
                      : connected
                        ? "Your saved credential is used automatically."
                        : "Add a Hugging Face read token to identify speakers."}
                  </p>
                </div>
                {connected && <Check size={17} />}
              </div>
              <div className="settings-fields">
                <label>
                  Language
                  <input
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                    placeholder="Auto-detect, or a code such as en or sv"
                    disabled={busy}
                  />
                </label>
                <label>
                  Python executable
                  <input
                    value={python}
                    onChange={(e) => setPython(e.target.value)}
                    placeholder="Use the local environment automatically"
                    disabled={busy}
                  />
                  <small>
                    Advanced: change this only to use another installed
                    environment.
                  </small>
                </label>
              </div>
              {!includedAccess && (
                <details className="credential-details" open={!connected}>
                  <summary>
                    Speaker credential
                    <ChevronDown size={14} />
                  </summary>
                  <p>
                    Use a free Hugging Face read token with access to the
                    speaker models.
                  </p>
                  <div className="setup-links">
                    <button
                      className="text-button"
                      onClick={() => setupLink("token")}
                    >
                      Create token
                      <Link size={12} />
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setupLink("community")}
                    >
                      Speaker model agreement
                      <Link size={12} />
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setupLink("segmentation")}
                    >
                      Segmentation agreement
                      <Link size={12} />
                    </button>
                  </div>
                  <div className="token-entry">
                    <input
                      type="password"
                      aria-label="Hugging Face token"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="Paste a read token"
                      disabled={!native || busy}
                    />
                    <button
                      className="secondary-button"
                      disabled={!native || !token.trim() || tokenBusy || busy}
                      onClick={storeToken}
                    >
                      {tokenBusy ? "Saving…" : "Save securely"}
                    </button>
                  </div>
                  <p className="small-note">
                    Saved in your operating system credential vault, separately
                    from projects.
                  </p>
                  {connected && (
                    <button
                      className="text-button remove-token"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          await invoke("remove_token");
                          setConnected(false);
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      Remove saved credential
                    </button>
                  )}
                </details>
              )}
              <p className="settings-footnote">
                <LockKeyhole size={13} />
                Audio is processed locally. First use may download the selected
                model.
              </p>
            </div>
            <footer>
              <button
                className="primary-button"
                onClick={() => setSettings(false)}
              >
                Done
              </button>
            </footer>
          </section>
        </div>
      )}
      <input
        ref={mediaInput}
        type="file"
        hidden
        accept="audio/*,video/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            attachMedia({
              name: file.name,
              url: URL.createObjectURL(file),
              audio: file.type.startsWith("audio/"),
            });
          e.target.value = "";
        }}
      />
      <input
        ref={jsonInput}
        type="file"
        hidden
        accept=".json,application/json"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) {
            try {
              await loadTranscript(JSON.parse(await file.text()));
            } catch (err) {
              setError(message(err));
            }
          }
        }}
      />
    </div>
  );
}
