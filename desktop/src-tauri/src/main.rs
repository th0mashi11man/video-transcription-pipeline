#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
    let bundled_python = resources.join(if cfg!(windows) {
        "runtime/python.exe"
    } else {
        "runtime/bin/python3"
    });
    let project_python = root.join(if cfg!(windows) {
        ".venv/Scripts/python.exe"
    } else {
        ".venv/bin/python"
    });
    let default_python = if bundled_python.is_file() {
        bundled_python.clone()
    } else {
        project_python
    };
    let use_bundled_python = python.is_none() && bundled_python.is_file();
    let executable = python.unwrap_or_else(|| {
        if default_python.exists() {
            default_python.to_string_lossy().into_owned()
        } else {
            "python3".into()
        }
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
    if use_bundled_python {
        command
            .env("PYTHONHOME", resources.join("runtime"))
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env_remove("VIRTUAL_ENV");
    }
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
    let mut child = command.spawn().map_err(|e| format!("Could not start Python: {e}. Install the Python environment described in README and choose its executable in Settings."))?;
    if let Some(stdout) = child.stdout.take() {
        capture_log(stdout, Arc::clone(&log), token.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        capture_log(stderr, log, token);
    }
    job.child = Some(child);
    job.directory = Some(directory);
    job.status = "running".into();
    let shared = Arc::clone(&state.job);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(300));
        let Ok(mut job) = shared.lock() else { break };
        if job.status != "running" {
            break;
        }
        let result = job.child.as_mut().map(|child| child.try_wait());
        match result {
            Some(Ok(Some(exit))) => {
                job.status = if exit.success() { "complete" } else { "failed" }.into();
                job.child = None;
                break;
            }
            Some(Err(_)) => {
                if let Some(mut child) = job.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                job.status = "failed".into();
                break;
            }
            _ => {}
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
            read_transcript,
            write_document,
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
