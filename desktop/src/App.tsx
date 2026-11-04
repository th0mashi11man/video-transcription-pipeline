import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import {
  AudioLines,
  Check,
  ChevronRight,
  Download,
  FileJson,
  FolderOpen,
  Headphones,
  Link,
  LoaderCircle,
  Play,
  Save,
  Settings2,
  ShieldCheck,
  SkipForward,
  Upload,
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
      invoke<boolean>("token_status")
        .then(setConnected)
        .catch((e) => setError(message(e)));
  }, []);
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
    if (speakers && !connected) {
      setSettings(true);
      setError(
        "Connect Hugging Face to use speaker detection, or turn speaker detection off.",
      );
      return;
    }
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

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#">
          <span className="brand-icon">
            <AudioLines size={23} />
          </span>
          <span>
            Transcript <b>Studio</b>
            <small>LISTEN CLOSELY. GET IT RIGHT.</small>
          </span>
        </a>
        <div className="top-actions">
          <span className="local-badge">
            <span /> Local workspace
          </span>
          <button
            className="icon-button"
            aria-label="Settings"
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div>
            <div className="eyebrow">YOUR WORDS, WITH CONTEXT</div>
            <h1>From recording to a reliable transcript.</h1>
            <p>
              Listen, review the uncertain parts, and make every word count.
            </p>
          </div>
          <button className="primary" disabled={busy} onClick={chooseMedia}>
            <FolderOpen size={17} /> Open recording
          </button>
        </div>
        <div className="workspace-toolbar">
          <div className="breadcrumb">
            <Headphones size={16} />
            <span>
              {media?.name ?? transcript?.mediaName ?? "New workspace"}
            </span>
            <ChevronRight size={14} />
            <span className="muted">
              {transcript ? "Review transcript" : "Ready to begin"}
            </span>
            {dirty && <span className="unsaved">Unsaved</span>}
          </div>
          <div className="button-group">
            <button disabled={busy} onClick={chooseTranscript}>
              <FileJson size={16} /> Open transcript
            </button>
            <button disabled={!transcript || busy} onClick={saveTranscript}>
              <Save size={16} /> Save project
            </button>
          </div>
        </div>
        {error && (
          <div role="alert" className="banner error">
            {error}
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="banner notice">
            {notice}
            <button
              className="icon-button"
              aria-label="Dismiss notice"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {settings && (
          <section
            className="settings-panel"
            aria-label="Transcription settings"
          >
            <div className="section-title">
              <div>
                <h2>Transcription settings</h2>
                <p>
                  Whisper recognizes the words. PyAnnote identifies the
                  speakers.
                </p>
              </div>
              <button
                className="icon-button"
                aria-label="Close settings"
                onClick={() => setSettings(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="settings-grid">
              <div className="engine-settings">
                <label>
                  Whisper model
                  <select
                    value={model}
                    disabled={busy}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    <option value="tiny">Tiny · quickest</option>
                    <option value="base">Base · lightweight</option>
                    <option value="small">Small · balanced</option>
                    <option value="medium">Medium · more detail</option>
                    <option value="large-v3">
                      Large v3 · highest accuracy
                    </option>
                    <option value="turbo">Turbo</option>
                  </select>
                </label>
                <label>
                  Language code
                  <input
                    value={language}
                    disabled={busy}
                    onChange={(e) => setLanguage(e.target.value)}
                    placeholder="Auto-detect (or en, sv, …)"
                  />
                </label>
                <label>
                  Python executable
                  <input
                    value={python}
                    disabled={busy}
                    onChange={(e) => setPython(e.target.value)}
                    placeholder="Use the project's .venv automatically"
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={speakers}
                    disabled={busy}
                    onChange={(e) => setSpeakers(e.target.checked)}
                  />{" "}
                  Identify speakers
                </label>
                <p className="help">
                  First use downloads the selected models. Whisper runs on CPU
                  on Apple Silicon; speaker detection can use Metal.
                </p>
              </div>
              <div className="token-setup">
                <div className="token-heading">
                  <ShieldCheck size={20} />
                  <h3>Connect Hugging Face</h3>
                  <span
                    className={
                      connected ? "status-pill connected" : "status-pill"
                    }
                  >
                    {connected ? "Token added" : "Setup needed"}
                  </span>
                </div>
                <p>
                  A free account and read token give PyAnnote access to its
                  speaker models.
                </p>
                <ol>
                  <li>
                    <button
                      className="text-link"
                      onClick={() => setupLink("token")}
                    >
                      Create a read token <Link size={12} />
                    </button>
                    <span>
                      Sign in, choose “Create new token”, then “Read”.
                    </span>
                  </li>
                  <li>
                    Accept the model agreements:
                    <div className="model-links">
                      <button
                        className="text-link"
                        onClick={() => setupLink("community")}
                      >
                        Speaker diarization ↗
                      </button>
                      <button
                        className="text-link"
                        onClick={() => setupLink("segmentation")}
                      >
                        Segmentation ↗
                      </button>
                    </div>
                  </li>
                  <li>
                    Paste your token below. Access is checked on transcription.
                  </li>
                </ol>
                <div className="token-input">
                  <input
                    type="password"
                    aria-label="Hugging Face token"
                    autoComplete="off"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="hf_…"
                    disabled={!native || busy}
                  />
                  <button
                    disabled={!native || !token.trim() || tokenBusy || busy}
                    onClick={storeToken}
                  >
                    {tokenBusy ? "Saving…" : "Save token"}
                  </button>
                </div>
                <p className="help">
                  {native
                    ? "Stored in your operating system’s credential vault. Never saved in a project or activity log."
                    : "Secure token storage is available in the desktop app."}
                </p>
                {connected && (
                  <button
                    className="text-link"
                    disabled={busy}
                    onClick={async () => {
                      try {
                        await invoke("remove_token");
                        setConnected(false);
                        setNotice("Stored token removed.");
                      } catch (e) {
                        setError(message(e));
                      }
                    }}
                  >
                    Remove stored token
                  </button>
                )}
              </div>
            </div>
          </section>
        )}
        <div className="workspace">
          <aside className="recording-panel">
            <div className="panel-heading">
              <h2>
                <span className="section-number">01</span> Recording
              </h2>
              <span className="subtle-tag">
                {media?.audio ? "AUDIO" : "AUDIO / VIDEO"}
              </span>
            </div>
            <div className={`player ${media ? "has-media" : ""}`}>
              {media ? (
                <>
                  <video
                    ref={player}
                    src={media.url}
                    controls
                    preload="metadata"
                    className={media.audio ? "audio-player" : ""}
                    onLoadedMetadata={(e) => {
                      setDuration(
                        Number.isFinite(e.currentTarget.duration)
                          ? e.currentTarget.duration
                          : 0,
                      );
                      e.currentTarget.playbackRate = speed;
                    }}
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
                        "This recording could not be played. Try an MP4 (H.264/AAC) video or WAV/MP3 audio file supported by your system.",
                      )
                    }
                  />
                  {media.audio && (
                    <div className="audio-art">
                      <AudioLines size={60} strokeWidth={1.2} />
                      <span>A little closer to every word.</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="media-empty">
                  <div className="wave-symbol">
                    <AudioLines size={46} strokeWidth={1.3} />
                  </div>
                  <h3>Your recording belongs here</h3>
                  <p>
                    Bring in an interview, a lecture,
                    <br />
                    or a conversation worth keeping.
                  </p>
                  <button onClick={chooseMedia} disabled={busy}>
                    <Upload size={15} /> Choose audio or video
                  </button>
                  <small>MP4, MOV, MP3, WAV, and more</small>
                </div>
              )}
            </div>
            <div className="playback-row">
              <span className="timecode">
                {formatTime(now)} <span>/ {formatTime(duration)}</span>
              </span>
              <label className="speed">
                Speed
                <select
                  aria-label="Playback speed"
                  value={speed}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setSpeed(v);
                    if (player.current) player.current.playbackRate = v;
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
            <div className="generate">
              <div>
                <h3>Make room for the words.</h3>
                <p>
                  Generate a timestamped transcript with word confidence and
                  speaker labels.
                </p>
              </div>
              <button
                className="primary full"
                disabled={!native || !media || busy}
                onClick={transcribe}
              >
                {busy ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <AudioLines size={17} />
                )}
                {busy ? "Transcribing…" : "Transcribe recording"}
              </button>
              <button
                className="text-link"
                disabled={busy}
                onClick={() => setSettings(true)}
              >
                <Settings2 size={13} /> {model} model · speakers{" "}
                {speakers ? "on" : "off"}
                {speakers && !connected ? " · connect Hugging Face" : ""}
              </button>
              {!native && (
                <p className="help">
                  Browser preview: attach media and open transcript JSON to try
                  the editor. Generation runs in the desktop app.
                </p>
              )}
            </div>
            {job.status !== "idle" && (
              <div className="activity">
                <div className="section-title">
                  <h3>Activity · {job.status}</h3>
                  {busy && (
                    <button
                      onClick={async () => {
                        try {
                          await invoke("cancel_transcription");
                          setJob((j) => ({ ...j, status: "cancelled" }));
                        } catch (e) {
                          setError(message(e));
                        }
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                <pre>{job.log || "Waiting for the local engine…"}</pre>
              </div>
            )}
            <div className="privacy-note">
              <ShieldCheck size={18} />
              <div>
                <b>Stays on your computer</b>
                <p>
                  Audio is processed locally. An internet connection is used to
                  download models.
                </p>
              </div>
            </div>
          </aside>
          <section className="transcript-panel">
            <div className="panel-heading">
              <h2>
                <span className="section-number">02</span> Transcript
              </h2>
              <div className="export-group">
                <Download size={14} />
                <select
                  aria-label="Export transcript"
                  disabled={!transcript || busy}
                  value=""
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
              </div>
            </div>
            {transcript ? (
              <>
                <div className="transcript-meta">
                  <span>
                    {sample ? "SAMPLE · NO RECORDING" : transcript.language}{" "}
                    <span className="dot">·</span> {transcript.segments.length}{" "}
                    passages
                  </span>
                  <span>
                    {words.length} words <span className="dot">·</span>{" "}
                    {reviewed} reviewed
                  </span>
                </div>
                <div className="review-toolbar">
                  <button
                    className={reviewOnly ? "filter active" : "filter"}
                    onClick={() => setReviewOnly(!reviewOnly)}
                  >
                    <span className="amber-dot" /> Needs review{" "}
                    <b>
                      {flagged +
                        transcript.segments.filter(
                          (s) => !s.words.length && !s.reviewed,
                        ).length}
                    </b>
                  </button>
                  <label className="threshold">
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
                    </select>
                  </label>
                  <button className="next-button" onClick={nextIssue}>
                    Next issue <SkipForward size={14} />
                  </button>
                </div>
                <div className="search-row">
                  <input
                    aria-label="Search transcript"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Find in transcript…"
                  />
                  <span className="help">
                    {unknown
                      ? `${unknown} words without confidence`
                      : transcript.engine}
                  </span>
                </div>
                <div className="transcript-scroll">
                  {transcript.segments.filter(
                    (s) =>
                      (!reviewOnly || passageNeedsReview(s, threshold)) &&
                      segmentText(s)
                        .toLocaleLowerCase()
                        .includes(query.toLocaleLowerCase()),
                  ).length === 0 && (
                    <div className="no-results">
                      No passages match this view.
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
                    const active =
                      now >= (s.start ?? Infinity) &&
                      now < (s.end ?? -Infinity) &&
                      !!media;
                    return (
                      <article
                        id={`segment-${si}`}
                        key={si}
                        className={`passage ${selected?.segment === si ? "selected-passage" : ""} ${active ? "playing-passage" : ""}`}
                      >
                        <div className="passage-meta">
                          <button
                            className="timestamp"
                            onClick={() =>
                              select(si, s.words.length ? 0 : null)
                            }
                          >
                            {formatTime(s.start)}
                          </button>
                          <span
                            className={`speaker speaker-${speakerIds.indexOf(s.speaker) % 2}`}
                          >
                            {s.speaker
                              ? s.speaker.replace("SPEAKER_", "Speaker ")
                              : "Speaker unassigned"}
                          </span>
                          {s.reviewed && (
                            <span className="reviewed-label">
                              <Check size={12} /> Reviewed
                            </span>
                          )}
                        </div>
                        <div className="passage-text">
                          {s.words.length ? (
                            s.words.map((w, wi) => (
                              <button
                                key={wi}
                                aria-label={`${w.text}, ${w.confidence === null ? "confidence unavailable" : `${Math.round(w.confidence * 100)}% confidence`}${w.reviewed ? ", reviewed" : ""}`}
                                title={`${w.confidence === null ? "Confidence unavailable" : `${Math.round(w.confidence * 100)}% model confidence`}${w.reviewed ? " · Reviewed" : ""}`}
                                className={`word ${needsReview(w, threshold) ? (w.confidence === null ? "unknown-word" : "uncertain-word") : ""} ${w.reviewed ? "reviewed-word" : ""} ${selected?.segment === si && selected.word === wi ? "selected-word" : ""} ${media && w.start !== null && w.end !== null && now >= w.start && now < w.end ? "playing-word" : ""}`}
                                onClick={() => select(si, wi)}
                              >
                                {w.text}
                              </button>
                            ))
                          ) : (
                            <button
                              className="untimed-text"
                              onClick={() => select(si, null)}
                            >
                              {s.text || "(Empty passage)"}
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
                <div className="legend">
                  <span>
                    <i className="amber-dot" /> Low confidence
                  </span>
                  <span>
                    <i className="unknown-dot" /> Unavailable
                  </span>
                  <span>
                    <Check size={13} /> Reviewed
                  </span>
                  <span>Click a word to listen & edit</span>
                </div>
              </>
            ) : (
              <div className="transcript-empty">
                <div className="paper-icon">
                  <div />
                  <div />
                  <div />
                  <div />
                </div>
                <div className="eyebrow">A CLEARER PICTURE, WORD BY WORD</div>
                <h2>The first draft is just the beginning.</h2>
                <p>
                  Your transcript will appear here, with uncertain words
                  <br className="wide-only" /> highlighted so you know where to
                  listen closer.
                </p>
                <div className="empty-steps">
                  <span>
                    <i>1</i> Add a recording
                  </span>
                  <ChevronRight size={14} />
                  <span>
                    <i>2</i> Transcribe
                  </span>
                  <ChevronRight size={14} />
                  <span>
                    <i>3</i> Listen & refine
                  </span>
                </div>
                <button
                  className="sample-button"
                  onClick={async () => {
                    if (!(await discard())) return;
                    setTranscript(structuredClone(demo));
                    setSample(true);
                    setSelected(null);
                    setDirty(false);
                    setError("");
                  }}
                >
                  Explore a sample transcript <ChevronRight size={15} />
                </button>
              </div>
            )}
            {selected && currentSegment && (
              <div className="editor">
                <div className="section-title">
                  <h3>
                    {currentWord ? "Review word" : "Review passage"}{" "}
                    <span className="editor-confidence">
                      {currentWord
                        ? currentWord.confidence === null
                          ? "Confidence unavailable"
                          : `${Math.round(currentWord.confidence * 100)}% model confidence`
                        : "No word-level timing"}
                    </span>
                  </h3>
                  <button
                    className="icon-button"
                    aria-label="Close word editor"
                    onClick={() => setSelected(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
                {currentWord &&
                  currentWord.text !== currentWord.originalText && (
                    <p className="help">Original: {currentWord.originalText}</p>
                  )}
                <div className="editor-controls">
                  <button
                    disabled={!media || sample || currentSegment.start === null}
                    onClick={replay}
                  >
                    <Play size={15} /> Replay context
                  </button>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={loop}
                      onChange={(e) => setLoop(e.target.checked)}
                    />{" "}
                    Loop
                  </label>
                  <span className="help">1 second of context on each side</span>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    updateSelected();
                  }}
                >
                  <input
                    aria-label="Correction"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={busy}
                  />
                  <button
                    type="submit"
                    className="primary"
                    disabled={busy || !draft.trim()}
                  >
                    <Check size={16} /> Save correction
                  </button>
                </form>
                <div className="editor-bottom">
                  <button
                    className="text-link"
                    disabled={busy}
                    onClick={() => updateSelected(true)}
                  >
                    <Check size={14} /> Mark whole passage reviewed
                  </button>
                  <button className="text-link" onClick={nextIssue}>
                    Next issue <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
        <footer>
          <span>Made for a more careful kind of listening.</span>
          <span>
            Model confidence is a review aid. Always verify important details.
          </span>
        </footer>
      </main>
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
