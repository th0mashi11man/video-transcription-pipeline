import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { open, save, confirm } from "@tauri-apps/plugin-dialog";
import {
  AudioLines,
  CheckCheck,
  FileJson,
  FileText,
  FolderOpen,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  PanelRight,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SkipForward,
  SquareArrowUp,
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
  type TranscriptView,
  defaultView,
} from "./transcript";

import {
  presentTranscript,
  rowHeading,
  rowText,
  rowsToText,
  tokenSeparator,
  speakerName,
  type DisplayToken,
} from "./presentation";
import { transcriptDocx } from "./word-export";
import { transcriptInqScribe } from "./inqscribe-export";
import { videoFrameRates } from "./timecode";
import { availableLanguages } from "./languages";

type Media = { url: string; name: string; path?: string; audio: boolean };
type Job = {
  status: "idle" | "running" | "complete" | "failed" | "cancelled";
  log: string;
  result?: unknown;
  progress?: {
    stage: string;
    label: string;
    detail?: string;
    completed?: number | null;
    total?: number | null;
    unit?: string | null;
  } | null;
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
  const [view, setView] = useState<TranscriptView>({ ...defaultView });
  const [showView, setShowView] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportKind, setExportKind] = useState<
    "docx" | "txt" | "inqscribe" | "srt" | "vtt"
  >("docx");
  const [exportScope, setExportScope] = useState<"all" | "visible">("all");
  const [exportBusy, setExportBusy] = useState(false);
  const [detectedFrameRate, setDetectedFrameRate] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState<boolean | null>(null);
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
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (native)
      invoke<{ ready: boolean; included: boolean }>("credential_status")
        .then((status) => {
          setConnected(status.ready);
          setIncludedAccess(status.included);
        })
        .catch((e) => setError(message(e)));
    if (native)
      invoke<boolean>("engine_status")
        .then(setEngineReady)
        .catch(() => setEngineReady(false));
  }, []);
  useEffect(() => {
    if (!settings && !exportOpen) return;
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
  }, [settings, exportOpen]);
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
          setTranscript({
            ...normalizeTranscript(next.result, media?.name),
            view,
          });
          setEngineReady(true);
          setSample(false);
          setSelected(null);
          revision.current++;
          setDirty(true);
          setNotice("Transcript ready.");
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
  }, [busy, media?.name, view]);
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
  useEffect(() => {
    let cancelled = false;
    setDetectedFrameRate(null);
    if (native && media?.path && !media.audio) {
      invoke<number | null>("media_frame_rate")
        .then((rate) => {
          const match = videoFrameRates.find(
            (r) => rate !== null && Math.abs(r.rate - rate) < 0.01,
          );
          if (!cancelled && match) {
            setDetectedFrameRate(match.label);
            if (view.frameRate !== match.rate) changeView("frameRate", match.rate);
          }
        })
        .catch(() => {}); // Unknown rates remain a user choice in Export.
    }
    return () => {
      cancelled = true;
    };
  }, [media?.path, engineReady]);

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
    } else setNotice("Recording opened.");
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
      setView({
        ...(parsed.view ?? defaultView),
        ...(detectedFrameRate ? {
          frameRate: videoFrameRates.find((r) => r.label === detectedFrameRate)!.rate,
        } : {}),
      });
      setThreshold(parsed.view?.confidenceThreshold ?? 0.8);
      setSelected(null);
      setSample(false);
      setDirty(false);
      revision.current++;
      setNotice(media ? "Transcript opened." : "Open its recording to listen.");
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
  async function writeFile(
    content: string | Uint8Array,
    extension: string,
    suffix = "reviewed",
  ) {
    const name =
      (transcript?.mediaName || media?.name || "transcript").replace(
        /\.[^.]+$/,
        "",
      ) + `.${suffix}.${extension}`;
    if (native) {
      const path = await save({
        defaultPath: name,
        filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
      });
      if (!path) return false;
      if (typeof content === "string")
        await invoke("write_document", { path, content });
      else
        await invoke("write_word_document", {
          path,
          content: Array.from(content),
        });
    } else {
      const url = URL.createObjectURL(
        new Blob(
          [
            typeof content === "string"
              ? content
              : (content.slice().buffer as ArrayBuffer),
          ],
          {
            type:
              extension === "json"
                ? "application/json"
                : extension === "docx"
                  ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  : "text/plain;charset=utf-8",
          },
        ),
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
          JSON.stringify(serializeTranscript({ ...transcript, view }), null, 2),
          "json",
        )
      ) {
        if (rev === revision.current) setDirty(false);
        setNotice("Saved.");
      }
    } catch (e) {
      setError(message(e));
    }
  }
  function select(segment: number, word: number | null) {
    const s = transcript!.segments[segment];
    setSelected({ segment, word });
    setShowInspector(true);
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
      const turn = presentTranscript(transcript, view, threshold).find(
        (row) =>
          row.kind === "turn" &&
          row.tokens.some(
            (token) =>
              token.segment === selected.segment &&
              token.word === selected.word,
          ),
      );
      for (const token of turn?.tokens ?? []) {
        if (token.kind !== "word") continue;
        const segment = next.segments[token.segment];
        if (token.word === null) segment.reviewed = true;
        else segment.words[token.word].reviewed = true;
      }
      for (const index of turn?.segments ?? []) {
        const segment = next.segments[index];
        if (segment.words.length)
          segment.reviewed = segment.words.every((word) => word.reviewed);
      }
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
      setNotice("No words need review.");
      return;
    }
    setReviewOnly(false);
    setQuery("");
    select(next.segment, next.word);
    window.setTimeout(
      () =>
        document
          .querySelector(`[data-segments~="${next.segment}"]`)
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
      setJob({ status: "running", log: "Starting local transcription…",
        progress: { stage: "starting", label: "Starting transcription",
          detail: "Checking the local engine and models." } });
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
  const activeSegment =
    transcript?.segments.findIndex(
      (s) =>
        s.start !== null && s.end !== null && now >= s.start && now < s.end,
    ) ?? -1;
  const knownSpeakers = speakerIds.filter(Boolean);
  const currentConfidence = currentWord?.confidence;
  const projectName = (
    transcript?.mediaName ||
    media?.name ||
    "Untitled"
  ).replace(/\.[^.]+$/, "");

  useEffect(() => {
    if (followPlayback && playing && activeSegment >= 0) {
      document
        .querySelector(`[data-segments~="${activeSegment}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeSegment, followPlayback, playing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (settings || exportOpen) {
        if (event.key === 'Escape') { event.preventDefault(); setSettings(false); setExportOpen(false); }
        return;
      }
      const target = event.target as HTMLElement;
      const editing =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        if (!busy) { if (event.shiftKey) void chooseTranscript(); else void chooseMedia(); }
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        if (!busy) void saveTranscript();
      } else if (
        !editing &&
        (!target.closest("button, a, summary") ||
          !!target.closest(".word,.pause")) &&
        event.code === "Space" &&
        media &&
        !sample
      ) {
        event.preventDefault();
        void togglePlayback();
      } else if (!editing && event.altKey && event.key === "ArrowRight") {
        event.preventDefault();
        nextIssue();
      } else if (event.key === "Escape") {
        setSettings(false);
        setExportOpen(false);
        setShowView(false);
      }
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
    setView({ ...defaultView });
    setThreshold(0.8);
    setSelected(null);
    setDirty(false);
    setError("");
  }

  const rows = transcript ? presentTranscript(transcript, view, threshold) : [];
  const matching = new Set(
    rows
      .filter(
        (row) =>
          row.kind === "turn" &&
          (!reviewOnly ||
            row.tokens.some((token) =>
              token.word !== null
                ? needsReview(
                    transcript!.segments[token.segment].words[token.word],
                    threshold,
                  )
                : !transcript!.segments[token.segment].reviewed,
            )) &&
          (rowText(row, view) + " " + speakerName(row.speaker))
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
      )
      .map((row) => row.id),
  );
  const shownRows = rows.filter((row, index) =>
    row.kind === "turn"
      ? matching.has(row.id)
      : matching.has(rows[index - 1]?.id) && matching.has(rows[index + 1]?.id),
  );
  const progress = job.progress;
  const progressFraction = progress?.total && progress.completed != null
    ? Math.max(0, Math.min(1, progress.completed / progress.total))
    : undefined;

  function changeView<K extends keyof TranscriptView>(
    key: K,
    value: TranscriptView[K],
  ) {
    setView((old) => ({ ...old, [key]: value }));
    if (transcript) {
      revision.current++;
      setDirty(true);
    }
  }
  async function performExport() {
    if (!transcript) return;
    setExportBusy(true);
    setError("");
    try {
      const outputRows = exportScope === "visible" ? shownRows : rows;
      const content =
        exportKind === "docx"
          ? await transcriptDocx(projectName, outputRows, view)
          : exportKind === "txt"
            ? rowsToText(outputRows, view)
            : exportKind === "inqscribe"
              ? transcriptInqScribe(outputRows, view)
              : exportTranscript(transcript, exportKind);
      if (
        await writeFile(
          content,
          exportKind === "inqscribe" ? "txt" : exportKind,
          exportKind === "inqscribe" ? "inqscribe" : "reviewed",
        )
      ) {
        setExportOpen(false);
        setNotice("Exported.");
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setExportBusy(false);
    }
  }
  async function playPause(token: DisplayToken) {
    if (!media || sample || token.start === null || token.end === null) return;
    clip.current = {
      start: Math.max(0, token.start - 0.5),
      end: Math.min(duration || Infinity, token.end + 0.5),
    };
    if (player.current) {
      player.current.currentTime = clip.current.start;
      try {
        await player.current.play();
      } catch (e) {
        setError(message(e));
      }
    }
  }

  return (
    <div
      className={`mac-app ${native && navigator.platform.includes("Mac") ? "native-mac" : ""}`}
    >
      <header className="mac-toolbar" data-tauri-drag-region>
        <div className="toolbar-actions" role="group" aria-label="Project actions">
          <button
            title="Open project (⌘⇧O)"
            aria-label="Open transcript"
            disabled={busy}
            onClick={chooseTranscript}
          >
            <FolderOpen size={18} />
          </button>
          <button
            title="Save project (⌘S)"
            aria-label="Save project"
            disabled={!transcript || busy}
            onClick={saveTranscript}
          >
            <Save size={18} />
          </button>
        </div>
        <div className="document-title">
          <h1>{projectName}</h1>
          {dirty && <span>Edited</span>}
          {sample && <span>Sample</span>}
        </div>
        <div className="toolbar-actions">
          <button
            title="Export transcript"
            aria-label="Export transcript"
            disabled={!transcript || busy}
            onClick={() => setExportOpen(true)}
          >
            <SquareArrowUp size={19} />
          </button>
          <span className="toolbar-separator" />
          <button
            title="Inspector"
            aria-label="Toggle inspector"
            aria-pressed={showInspector}
            onClick={() => setShowInspector(!showInspector)}
          >
            <PanelRight size={19} />
          </button>
          <button
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettings(true)}
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>
      {error && (
        <div className="message error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {notice && (
        <div className="message notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            <X size={14} />
          </button>
        </div>
      )}
      <main className={`mac-split ${showInspector ? "with-inspector" : ""}`}>
        <aside className="source-sidebar" aria-label="Recording">
          <div className="section-header">
            <h2>Recording</h2>
            <button
              title="Change recording"
              aria-label="Choose a different recording"
              disabled={busy}
              onClick={chooseMedia}
            >
              <FolderOpen size={15} />
            </button>
          </div>
          <div className={`media-player ${media?.audio ? "audio" : ""}`}>
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
                    setError("Unable to play this file. Try MP4, WAV, or MP3.")
                  }
                />
                {media.audio && (
                  <div className="audio-display">
                    <AudioLines size={43} strokeWidth={1.3} />
                    <span>{media.name}</span>
                  </div>
                )}
              </>
            ) : (
              <button className="open-recording" onClick={chooseMedia}>
                <FolderOpen size={31} strokeWidth={1.2} />
                <span>Open recording…</span>
              </button>
            )}
          </div>
          <div className="transport">
            <button
              aria-label="Back 3 seconds"
              title="Back 3 seconds"
              disabled={!media}
              onClick={() => seekTo(now - 3)}
            >
              <RotateCcw size={17} />
            </button>
            <button
              className="play"
              aria-label={playing ? "Pause recording" : "Play recording"}
              title="Play or pause (Space)"
              disabled={!media}
              onClick={togglePlayback}
            >
              {playing ? (
                <Pause size={20} fill="currentColor" />
              ) : (
                <Play size={20} fill="currentColor" />
              )}
            </button>
            <button
              aria-label="Forward 3 seconds"
              title="Forward 3 seconds"
              disabled={!media}
              onClick={() => seekTo(now + 3)}
            >
              <RotateCw size={17} />
            </button>
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
          </div>
          <input
            className="scrubber"
            aria-label="Recording position"
            type="range"
            min="0"
            max={duration || 1}
            step=".01"
            value={Math.min(now, duration || 1)}
            disabled={!media}
            onChange={(e) => seekTo(Number(e.target.value))}
          />
          <div className="time-row">
            <span>{formatTime(now)}</span>
            <span>{formatTime(duration)}</span>
            <button
              aria-label={muted ? "Unmute recording" : "Mute recording"}
              disabled={!media}
              onClick={() => setMuted(!muted)}
            >
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
            </button>
          </div>
          <div className="sidebar-group">
            <label>
              Model
              <select
                value={model}
                disabled={busy}
                onChange={(e) => {
                  setModel(e.target.value);
                  if (!availableLanguages(e.target.value).some((l) => l.code === language))
                    setLanguage("");
                }}
              >
                <option value="tiny">Tiny</option>
                <option value="base">Base</option>
                <option value="small">Small</option>
                <option value="medium">Medium</option>
                <option value="large-v3">Large v3</option>
                <option value="turbo">Turbo</option>
              </select>
            </label>
            <label>
              Language
              <select
                aria-label="Language"
                value={language}
                disabled={busy}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="">Detect automatically</option>
                {availableLanguages(model).map(({ code, name }) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={speakers}
                disabled={busy}
                onChange={(e) => setSpeakers(e.target.checked)}
              />
              Identify speakers
            </label>
            <button
              className="primary"
              disabled={!native || !media || busy}
              onClick={transcribe}
            >
              {busy ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <AudioLines size={14} />
              )}{" "}
              {busy
                  ? "Working…"
                  : transcript
                    ? "Transcribe again"
                    : "Transcribe"}
            </button>
            {busy && (
              <>
                <div className="job-progress" role="status" aria-live="polite">
                  <strong>{progress?.label || "Starting transcription"}</strong>
                  {progress?.detail && <p>{progress.detail}</p>}
                  <progress
                    aria-label={progress?.label || "Transcription progress"}
                    value={progressFraction}
                    max={1}
                  />
                  {progressFraction !== undefined && (
                    <span>
                      {progress?.unit === "files"
                        ? `${progress.completed} of ${progress.total} files`
                        : `${Math.round(progressFraction * 100)}%`}
                    </span>
                  )}
                </div>
                <button
                  className="link"
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
              </>
            )}
            {!busy && native && engineReady === false && (
              <p className="footnote">
                Engine and models download on first use.
              </p>
            )}
            {!native && (
              <p className="footnote">
                Transcription requires the desktop app.
              </p>
            )}
          </div>
          {job.status !== "idle" && (
            <details className="activity" open={job.status === "failed"}>
              <summary>Activity</summary>
              <pre>{job.log}</pre>
            </details>
          )}
        </aside>
        <section className="transcript-pane" aria-label="Transcript">
          <div className="transcript-toolbar">
            <div className="search">
              <Search size={14} />
              <input
                aria-label="Search transcript"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
              />
              {query && (
                <button aria-label="Clear search" onClick={() => setQuery("")}>
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              className="filter-button"
              aria-label="Filter to needs review"
              aria-pressed={reviewOnly}
              disabled={!transcript}
              onClick={() => setReviewOnly(!reviewOnly)}
            >
              <ListFilter size={15} />
              <span>{totalIssues}</span>
            </button>
            <div className="view-menu">
              <button
                aria-label="Transcript display options"
                title="Display options"
                aria-expanded={showView}
                onClick={() => setShowView(!showView)}
              >
                <MoreHorizontal size={19} />
              </button>
              {showView && (
                <div className="popover">
                  <h3>Display</h3>
                  {(
                    [
                      ["speakers", "Speakers"],
                      ["timestamps", "Turn timestamps"],
                      ["pauses", "Pauses"],
                      ["uncertainty", "Uncertainty"],
                      ["reviewed", "Review marks"],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="check-row" key={key}>
                      <input
                        type="checkbox"
                        checked={view[key]}
                        onChange={(e) => changeView(key, e.target.checked)}
                      />
                      {label}
                    </label>
                  ))}
                  <label className="threshold">
                    Confidence
                    <select
                      aria-label="Confidence threshold"
                      value={threshold}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        setThreshold(value);
                        setView((old) => ({
                          ...old,
                          confidenceThreshold: value,
                        }));
                        if (transcript) {
                          revision.current++;
                          setDirty(true);
                        }
                      }}
                    >
                      {[0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((v) => (
                        <option key={v} value={v}>
                          {Math.round(v * 100)}%
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={followPlayback}
                      onChange={(e) => setFollowPlayback(e.target.checked)}
                    />
                    Follow playback
                  </label>
                  <button className="link" onClick={() => setShowView(false)}>
                    Done
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="transcript-scroll">
            {!transcript ? (
              <div className="empty-transcript">
                {busy ? (
                  <>
                    <LoaderCircle size={28} className="spin" />
                    <p>{progress?.label || "Starting transcription"}</p>
                  </>
                ) : (
                  <>
                    <FileText size={38} strokeWidth={1} />
                    <p>Open a recording or transcript.</p>
                    <button onClick={chooseTranscript}>Open transcript…</button>
                    <button className="link" onClick={showSample}>
                      Sample
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                {shownRows.length === 0 && (
                  <div className="empty-transcript">
                    <p>
                      {query || reviewOnly
                        ? "No matching turns."
                        : "No speech detected."}
                    </p>
                  </div>
                )}
                {shownRows.map((row) => (
                  <article
                    key={row.id}
                    id={`row-${row.id}`}
                    data-segments={row.segments.join(" ")}
                    className={`turn ${row.kind === "pause" ? "pause-row" : ""} ${row.segments.includes(activeSegment) && playing ? "playing" : ""}`}
                  >
                    {rowHeading(row, view) && (
                      <div className="turn-heading">
                        <button
                          onClick={() => {
                            const token = row.tokens.find(
                              (t) => t.kind === "word",
                            );
                            if (token) select(token.segment, token.word);
                          }}
                        >
                          {rowHeading(row, view)}
                        </button>
                      </div>
                    )}
                    <p className="turn-text">
                      {row.tokens.map((token, index) => (
                        <span
                          key={`${token.kind}-${token.segment}-${token.word}-${index}`}
                        >
                          {tokenSeparator(row.tokens[index - 1], token)}
                          {token.kind === "pause" ? (
                            <button
                              className="pause"
                              aria-label={`Pause ${token.text}`}
                              title="Listen to pause"
                              onClick={() => playPause(token)}
                            >
                              {token.text}
                            </button>
                          ) : (
                            <button
                              className={`word ${token.uncertainty === "low" ? "uncertain" : token.uncertainty === "unknown" ? "unscored" : ""} ${selected?.segment === token.segment && selected.word === token.word ? "selected" : ""} ${!sample && media && token.start !== null && token.end !== null && now >= token.start && now < token.end ? "current" : ""}`}
                              aria-label={`${token.text}${token.reviewed ? ", reviewed" : ""}`}
                              title={
                                token.uncertainty === "unknown"
                                  ? "No confidence score"
                                  : token.word !== null
                                    ? `${Math.round((transcript.segments[token.segment].words[token.word].confidence ?? 0) * 100)}% confidence`
                                    : undefined
                              }
                              onClick={() => select(token.segment, token.word)}
                            >
                              {token.text}
                              {view.reviewed && token.reviewed && (
                                <sup className="review-mark">✓</sup>
                              )}
                            </button>
                          )}
                        </span>
                      ))}
                    </p>
                  </article>
                ))}
              </>
            )}
          </div>
          {transcript && (
            <div className="transcript-status">
              <span>{words.length} words</span>
              {view.uncertainty && (
                <span>
                  <i />
                  Uncertainty
                </span>
              )}
              {view.reviewed && <span>✓ Reviewed</span>}
              <button className="link" onClick={nextIssue}>
                Next issue <SkipForward size={12} />
              </button>
            </div>
          )}
        </section>
        {showInspector && (
          <aside className="inspector" aria-label="Review">
            <div className="section-header">
              <h2>Review</h2>
              <button
                aria-label="Close inspector"
                onClick={() => setShowInspector(false)}
              >
                <X size={14} />
              </button>
            </div>
            {selected && currentSegment ? (
              <>
                <h3>{currentWord?.text || segmentText(currentSegment)}</h3>
                {typeof currentConfidence === "number" && (
                  <p className="confidence">
                    {Math.round(currentConfidence * 100)}% confidence
                    {currentWord?.reviewed ? " · Reviewed" : ""}
                  </p>
                )}
                <button
                  className="replay"
                  aria-label="Replay context"
                  disabled={!media || sample || currentSegment.start === null}
                  onClick={replay}
                >
                  <Play size={14} />
                  Replay context
                </button>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={loop}
                    onChange={(e) => setLoop(e.target.checked)}
                  />
                  Loop
                </label>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    updateSelected();
                  }}
                >
                  <label htmlFor="correction">Correction</label>
                  <textarea
                    id="correction"
                    aria-label="Correction"
                    rows={3}
                    value={draft}
                    disabled={busy}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        updateSelected();
                      }
                    }}
                  />
                  {currentWord &&
                    currentWord.text !== currentWord.originalText && (
                      <p className="footnote">
                        Original: {currentWord.originalText}
                      </p>
                    )}
                  <button
                    className="primary"
                    type="submit"
                    aria-label="Save correction"
                    disabled={busy || !draft.trim()}
                  >
                    Save correction
                  </button>
                </form>
                <button onClick={() => updateSelected(true)} disabled={busy}>
                  <CheckCheck size={14} />
                  Mark turn reviewed
                </button>
                <button className="link" onClick={nextIssue}>
                  Next issue
                  <SkipForward size={13} />
                </button>
              </>
            ) : (
              <p className="footnote">Select a word.</p>
            )}
          </aside>
        )}
      </main>
      {exportOpen && (
        <div className="sheet-backdrop">
          <section
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-title"
          >
            <h2 id="export-title">Export transcript</h2>
            <label>
              Format
              <select
                aria-label="Export format"
                value={exportKind}
                onChange={(e) =>
                  setExportKind(e.target.value as typeof exportKind)
                }
              >
                <option value="docx">Word document (.docx)</option>
                <option value="txt">Plain text (.txt)</option>
                <option value="inqscribe">InqScribe (.txt)</option>
                <optgroup label="Captions">
                  <option value="srt">SubRip (.srt)</option>
                  <option value="vtt">WebVTT (.vtt)</option>
                </optgroup>
              </select>
            </label>
            {exportKind === "inqscribe" && (
              <label>
                Frame rate
                <select
                  aria-label="Export frame rate"
                  value={view.frameRate}
                  onChange={(e) => changeView("frameRate", Number(e.target.value))}
                >
                  {videoFrameRates.map(({ label, rate }) => (
                    <option key={label} value={rate}>
                      {label} fps{label === "29.97" || label === "59.94" ? " (non-drop)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Content
              <select
                aria-label="Export scope"
                value={exportScope}
                onChange={(e) =>
                  setExportScope(e.target.value as typeof exportScope)
                }
                disabled={exportKind === "srt" || exportKind === "vtt"}
              >
                <option value="all">All turns</option>
                <option value="visible">Current view</option>
              </select>
            </label>
            {(exportKind === "docx" ||
              exportKind === "txt" ||
              exportKind === "inqscribe") && (
              <p className="footnote">
                Uses the current transcript display settings.
                {(exportKind === "txt" || exportKind === "inqscribe") &&
                view.uncertainty
                  ? " Uncertain text is marked with ⟦ ⟧."
                  : ""}
              </p>
            )}
            {exportKind === "inqscribe" && (
              <p className="footnote">
                {!detectedFrameRate ? "Choose the recording’s frame rate. " : ""}
                In InqScribe: File → Import → Tab-delimited Text, {videoFrameRates.find((r) => r.rate === view.frameRate)?.label}
                {" "}fps.
              </p>
            )}
            <footer>
              <button
                disabled={exportBusy}
                onClick={() => setExportOpen(false)}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={exportBusy}
                onClick={performExport}
              >
                {exportBusy ? "Exporting…" : "Export"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {settings && (
        <div className="sheet-backdrop">
          <section
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <h2 id="settings-title">Settings</h2>
            <p className="credential-status">
              <ShieldCheck size={16} />
              {connected ? "Speaker access ready" : "Speaker access required"}
            </p>
            {!includedAccess && (
              <details open={!connected}>
                <summary>Speaker credential</summary>
                <div className="setup-links">
                  <button className="link" onClick={() => setupLink("token")}>
                    Create token
                  </button>
                  <button
                    className="link"
                    onClick={() => setupLink("community")}
                  >
                    Speaker model
                  </button>
                  <button
                    className="link"
                    onClick={() => setupLink("segmentation")}
                  >
                    Segmentation model
                  </button>
                </div>
                <input
                  type="password"
                  aria-label="Hugging Face token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Read token"
                  autoComplete="off"
                />
                <button
                  disabled={!native || !token.trim() || tokenBusy || busy}
                  onClick={storeToken}
                >
                  Save securely
                </button>
              </details>
            )}
            <details>
              <summary>Advanced</summary>
              <label>
                Python executable
                <input
                  value={python}
                  onChange={(e) => setPython(e.target.value)}
                  placeholder="Automatic"
                  disabled={busy}
                />
              </label>
            </details>
            <footer>
              <button className="primary" onClick={() => setSettings(false)}>
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
