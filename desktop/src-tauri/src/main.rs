#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod engine;

use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
use tauri_plugin_opener::OpenerExt;

fn run_step(
    mut command: Command,
    shared: &Arc<Mutex<Job>>,
    log: &Arc<Mutex<fs::File>>,
    token: Option<String>,
) -> Result<bool, String> {
    {
        let mut job = shared.lock().map_err(|e| e.to_string())?;
        if job.status != "running" {
            return Ok(false);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        if let Some(stdout) = child.stdout.take() {
            capture_log(stdout, Arc::clone(log), token.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            capture_log(stderr, Arc::clone(log), token);
        }
        job.child = Some(child);
    }
    loop {
        std::thread::sleep(Duration::from_millis(150));
        let mut job = shared.lock().map_err(|e| e.to_string())?;
        if job.status != "running" {
            return Ok(false);
        }
        let exit = job
            .child
            .as_mut()
            .ok_or("The engine process was stopped.")?
            .try_wait()
            .map_err(|e| e.to_string())?;
        if let Some(exit) = exit {
            job.child = None;
            return Ok(exit.success());
        }
    }
}
fn log_line(log: &Arc<Mutex<fs::File>>, message: &str) {
    if let Ok(mut file) = log.lock() {
        let _ = writeln!(file, "{message}");
    }
}

#[tauri::command]
fn engine_status(app: tauri::AppHandle) -> Result<bool, String> {
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    if resources.join("engine/uv").is_file() || resources.join("engine/uv.exe").is_file() {
        return Ok(engine::Engine::new(
            &resources,
            &app.path().app_local_data_dir().map_err(|e| e.to_string())?,
            &app.path().app_cache_dir().map_err(|e| e.to_string())?,
        )?
        .ready());
    }
    Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../.venv/bin/python")
        .is_file())
}

#[derive(Clone, Serialize)]
struct JobStatus {
    status: String,
    log: String,
    result: Option<serde_json::Value>,
}
struct Job {
    status: String,
    child: Option<Child>,
    directory: Option<PathBuf>,
}
impl Default for Job {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            child: None,
            directory: None,
        }
    }
}
#[derive(Clone, Default)]
struct AppState {
    job: Arc<Mutex<Job>>,
    media: Arc<Mutex<Option<PathBuf>>>,
}

fn capture_log(
    stream: impl Read + Send + 'static,
    file: Arc<Mutex<fs::File>>,
    token: Option<String>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                _ => {}
            }
            let mut text = String::from_utf8_lossy(&line).into_owned();
            if let Some(token) = &token {
                text = text.replace(token, "[redacted]");
            }
            if let Ok(mut file) = file.lock() {
                let _ = file.write_all(text.as_bytes());
            }
        }
    });
}

fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("se.transcriptstudio.desktop", "hugging-face")
        .map_err(|e| format!("Cannot access the credential vault: {e}"))
}
fn stored_token() -> Result<Option<String>, String> {
    match credential()?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Cannot read the saved token: {e}")),
    }
}
#[tauri::command]
fn token_status(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(resolve_token(&app)?.is_some())
}

fn included_token(app: &tauri::AppHandle) -> Option<String> {
    let path = app
        .path()
        .resource_dir()
        .ok()?
        .join("private/huggingface-token");
    let value = fs::read_to_string(path).ok()?;
    let token = value.trim();
    if token.starts_with("hf_") && token.len() >= 10 && !token.chars().any(char::is_whitespace) {
        Some(token.to_owned())
    } else {
        None
    }
}

fn resolve_token(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    // Personal builds work immediately, including on a recipient's computer.
    // Standard/public builds have no included credential and use the OS vault.
    if let Some(token) = included_token(app) {
        return Ok(Some(token));
    }
    stored_token()
}

#[derive(Serialize)]
struct CredentialStatus {
    ready: bool,
    included: bool,
}

#[tauri::command]
fn credential_status(app: tauri::AppHandle) -> Result<CredentialStatus, String> {
    if included_token(&app).is_some() {
        return Ok(CredentialStatus {
            ready: true,
            included: true,
        });
    }
    Ok(CredentialStatus {
        ready: stored_token()?.is_some(),
        included: false,
    })
}
#[tauri::command]
fn save_token(token: String) -> Result<(), String> {
    if !token.starts_with("hf_") || token.len() < 10 || token.chars().any(char::is_whitespace) {
        return Err("Paste a Hugging Face token beginning with hf_.".into());
    }
    credential()?
        .set_password(&token)
        .map_err(|e| format!("Cannot save the token securely: {e}"))
}
#[tauri::command]
fn remove_token() -> Result<(), String> {
    match credential()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
#[tauri::command]
fn open_setup_page(app: tauri::AppHandle, page: String) -> Result<(), String> {
    let url = match page.as_str() {
        "token" => "https://huggingface.co/settings/tokens",
        "community" => "https://huggingface.co/pyannote/speaker-diarization-community-1",
        "segmentation" => "https://huggingface.co/pyannote/segmentation-3.0",
        _ => return Err("Unknown setup page.".into()),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn open_media(
    app: tauri::AppHandle,
    state: State<AppState>,
    path: PathBuf,
) -> Result<String, String> {
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.is_file() {
        return Err("Choose a media file.".into());
    }
    let mut selected = state.media.lock().map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|e| e.to_string())?;
    *selected = Some(canonical.clone());
    Ok(canonical.to_string_lossy().into_owned())
}
#[tauri::command]
async fn media_frame_rate(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<f64>, String> {
    let media = state.media.lock().map_err(|e| e.to_string())?.clone();
    let Some(media) = media else { return Ok(None) };
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let python = if resources.join("engine/requirements.txt").is_file() {
        let engine = engine::Engine::new(
            &resources,
            &app.path().app_local_data_dir().map_err(|e| e.to_string())?,
            &app.path().app_cache_dir().map_err(|e| e.to_string())?,
        )?;
        if !engine.ready() {
            return Ok(None);
        }
        engine.python
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(if cfg!(windows) {
            "../../.venv/Scripts/python.exe"
        } else {
            "../../.venv/bin/python"
        })
    };
    // PyAV is already part of the local engine. Read stream metadata only;
    // no engine/model download or video decoding is needed for this request.
    tauri::async_runtime::spawn_blocking(move || {
        let output = Command::new(python)
            .args(["-I", "-c", FRAME_RATE_PROBE])
            .arg(media)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let rate: f64 = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse()
            .ok()?;
        (rate.is_finite() && rate > 0.0).then_some(rate)
    })
    .await
    .map_err(|e| e.to_string())
}
const FRAME_RATE_PROBE: &str = r#"
import av, sys
with av.open(sys.argv[1]) as media:
    video = next((s for s in media.streams.video
                  if not s.disposition & av.stream.Disposition.attached_pic), None)
    rate = (video.average_rate or video.guessed_rate) if video else None
    if rate:
        print(float(rate))
"#;
#[tauri::command]
fn read_transcript(path: PathBuf) -> Result<String, String> {
    if path.extension().and_then(|x| x.to_str()) != Some("json") {
        return Err("Choose a JSON transcript.".into());
    }
    if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 50_000_000 {
        return Err("Transcript exceeds the 50 MB limit.".into());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}
#[tauri::command]
fn write_document(path: PathBuf, content: String) -> Result<(), String> {
    if !matches!(
        path.extension().and_then(|s| s.to_str()),
        Some("json" | "txt" | "srt" | "vtt")
    ) {
        return Err("Save as JSON, TXT, SRT, or VTT.".into());
    }
    fs::write(path, content).map_err(|e| e.to_string())
}
#[tauri::command]
fn write_word_document(path: PathBuf, content: Vec<u8>) -> Result<(), String> {
    if path.extension().and_then(|s| s.to_str()) != Some("docx") {
        return Err("Choose a .docx file.".into());
    }
    if content.len() > 50_000_000 || !content.starts_with(b"PK") {
        return Err("Invalid Word document.".into());
    }
    fs::write(path, content).map_err(|e| e.to_string())
}
#[tauri::command]
fn start_transcription(
    app: tauri::AppHandle,
    state: State<AppState>,
    media_path: PathBuf,
    python: Option<String>,
    model: String,
    language: Option<String>,
    speakers: bool,
) -> Result<(), String> {
    let media_path = media_path.canonicalize().map_err(|e| e.to_string())?;
    if state.media.lock().map_err(|e| e.to_string())?.as_ref() != Some(&media_path) {
        return Err("Open this recording in the app before transcribing it.".into());
    }
    if !["tiny", "base", "small", "medium", "large-v3", "turbo"].contains(&model.as_str()) {
        return Err("Unsupported model.".into());
    }
    let mut job = state.job.lock().map_err(|e| e.to_string())?;
    if job.status == "running" {
        return Err("A transcription is already running.".into());
    }
    let token = if speakers {
        Some(resolve_token(&app)?.ok_or(
            "Speaker access is missing. Add a credential in Settings or use a private app build.",
        )?)
    } else {
        None
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let packaged_source = resources.join("python");
    let source = if packaged_source.join("video_transcription").is_dir() {
        packaged_source
    } else {
        root.join("src")
    };
    let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let downloadable = python.is_none()
        && (resources.join("engine/uv").is_file() || resources.join("engine/uv.exe").is_file());
    let engine = if downloadable {
        Some(engine::Engine::new(&resources, &data, &cache)?)
    } else {
        None
    };
    let project_python = root.join(if cfg!(windows) {
        ".venv/Scripts/python.exe"
    } else {
        ".venv/bin/python"
    });
    let executable = python.unwrap_or_else(|| {
        engine
            .as_ref()
            .map(|e| e.python.to_string_lossy().into_owned())
            .unwrap_or_else(|| {
                if project_python.exists() {
                    project_python.to_string_lossy().into_owned()
                } else {
                    "python3".into()
                }
            })
    });
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("jobs")
        .join(id.to_string());
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let log = fs::File::create(directory.join("activity.log")).map_err(|e| e.to_string())?;
    let log = Arc::new(Mutex::new(log));
    let mut command = Command::new(executable);
    command
        .env_remove("PYTHONHOME")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env_remove("VIRTUAL_ENV");
    command
        .arg("-u")
        .arg("-m")
        .arg("video_transcription.whisper")
        .arg(&media_path)
        .arg("--output-dir")
        .arg(&directory)
        .arg("--result-file")
        .arg(directory.join("result.json"))
        .arg("--model")
        .arg(model)
        .arg("--cleanup-audio")
        .env("PYTHONPATH", source)
        .env("PYTHONUNBUFFERED", "1")
        .env("PYANNOTE_METRICS_ENABLED", "0")
        .env("HF_HOME", cache.join("models"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(lang) = language.filter(|x| !x.is_empty()) {
        command.arg("--language").arg(lang);
    }
    if let Some(token) = &token {
        command.env("HF_TOKEN", token);
    } else {
        command.arg("--no-diarize");
    }
    job.directory = Some(directory);
    job.status = "running".into();
    let shared = Arc::clone(&state.job);
    std::thread::spawn(move || {
        let outcome = (|| -> Result<bool, String> {
            if let Some(engine) = engine {
                if !engine.ready() {
                    log_line(&log, "Downloading the local engine. First use only…");
                    for step in engine.steps()? {
                        if !run_step(step, &shared, &log, None)? {
                            return Ok(false);
                        }
                    }
                    // A cancelled setup never becomes a completed installation.
                    if shared.lock().map_err(|e| e.to_string())?.status != "running" {
                        return Ok(false);
                    }
                    engine.finish()?;
                    log_line(&log, "Local engine ready.");
                }
            }
            log_line(&log, "Transcribing. Models download locally on first use…");
            run_step(command, &shared, &log, token)
        })();
        if let Err(error) = &outcome {
            log_line(&log, &format!("Engine error: {error}"));
        }
        if let Ok(mut job) = shared.lock() {
            if job.status == "running" {
                job.status = if matches!(outcome, Ok(true)) {
                    "complete"
                } else {
                    "failed"
                }
                .into();
                if let Some(mut child) = job.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
    Ok(())
}
#[tauri::command]
fn transcription_status(state: State<AppState>) -> Result<JobStatus, String> {
    let job = state.job.lock().map_err(|e| e.to_string())?;
    let mut log = String::new();
    let mut result = None;
    if let Some(dir) = &job.directory {
        if let Ok(mut file) = fs::File::open(dir.join("activity.log")) {
            let len = file.metadata().map_err(|e| e.to_string())?.len();
            let _ = file.seek(SeekFrom::Start(len.saturating_sub(8000)));
            let mut bytes = Vec::new();
            let _ = file.read_to_end(&mut bytes);
            log = String::from_utf8_lossy(&bytes).into_owned();
        }
        if job.status == "complete" {
            let data = fs::read_to_string(dir.join("result.json"))
                .map_err(|e| format!("Cannot read transcription result: {e}"))?;
            result = Some(serde_json::from_str(&data).map_err(|e| e.to_string())?);
        }
    }
    Ok(JobStatus {
        status: job.status.clone(),
        log,
        result,
    })
}
#[tauri::command]
fn cancel_transcription(state: State<AppState>) -> Result<(), String> {
    let mut job = state.job.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = job.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    if job.status == "running" {
        job.status = "cancelled".into();
    }
    Ok(())
}
fn main() {
    // Optional provisioning command uses the same installation plan as the UI.
    // It is also useful for checking first-use setup without opening a window.
    if std::env::args().nth(1).as_deref() == Some("--prepare-engine") {
        let outcome = (|| -> Result<(), String> {
            let destination = std::env::args()
                .nth(2)
                .ok_or("Supply a local engine data directory.")?;
            let executable = std::env::current_exe().map_err(|e| e.to_string())?;
            let resources = executable
                .parent()
                .and_then(|p| p.parent())
                .ok_or("Cannot locate app resources.")?
                .join("Resources");
            let data = PathBuf::from(destination);
            let engine = engine::Engine::new(&resources, &data, &data.join("cache"))?;
            if !engine.ready() {
                for mut command in engine.steps()? {
                    if !command.status().map_err(|e| e.to_string())?.success() {
                        return Err(
                            "Engine download failed. Check the connection and retry.".into()
                        );
                    }
                }
                engine.finish()?;
            }
            println!("Engine ready: {}", engine.python.display());
            Ok(())
        })();
        if let Err(error) = outcome {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    // Allows secure provisioning without placing credentials in arguments,
    // shell history, or files. The desktop setup uses save_token directly.
    if std::env::args().nth(1).as_deref() == Some("--store-token-stdin") {
        let mut token = String::new();
        let outcome = std::io::stdin()
            .read_line(&mut token)
            .map_err(|e| e.to_string())
            .and_then(|_| save_token(token.trim().to_owned()));
        match outcome {
            Ok(()) => println!("Hugging Face token saved in the credential vault."),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            token_status,
            credential_status,
            save_token,
            remove_token,
            open_setup_page,
            open_media,
            media_frame_rate,
            read_transcript,
            write_document,
            write_word_document,
            engine_status,
            start_transcription,
            transcription_status,
            cancel_transcription
        ])
        .build(tauri::generate_context!())
        .expect("Unable to build Transcript Studio")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = cancel_transcription(app.state::<AppState>());
            }
        });
}
