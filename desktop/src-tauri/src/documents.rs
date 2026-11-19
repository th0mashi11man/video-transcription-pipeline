use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::menu::{MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

#[derive(Default)]
pub struct Document {
    pub path: Option<PathBuf>,
    pub initial: Option<String>,
    pub occupied: bool,
    pub ready: bool,
}
#[derive(Default)]
pub struct Documents {
    pub windows: Mutex<HashMap<String, Document>>,
    pub quitting: Mutex<bool>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Recent {
    pub path: String,
    name: String,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn stamp(bytes: &[u8]) -> String {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Choose a folder for this file.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    temporary.write_all(bytes).map_err(err)?;
    temporary.as_file().sync_all().map_err(err)?;
    temporary.persist(path).map_err(err)?;
    Ok(())
}
fn recent_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let folder = app.path().app_local_data_dir().map_err(err)?;
    fs::create_dir_all(&folder).map_err(err)?;
    Ok(folder.join("recent-projects.json"))
}
pub fn recent(app: &tauri::AppHandle) -> Vec<Recent> {
    recent_file(app)
        .ok()
        .and_then(|p| fs::read(p).ok())
        .and_then(|v| serde_json::from_slice::<Vec<Recent>>(&v).ok())
        .unwrap_or_default()
}
fn remember(app: &tauri::AppHandle, path: &Path) {
    let path = path.to_string_lossy().into_owned();
    let mut items = recent(app);
    items.retain(|r| r.path != path);
    items.insert(
        0,
        Recent {
            name: Path::new(&path)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            path,
        },
    );
    items.truncate(10);
    if let Ok(file) = recent_file(app) {
        let _ = atomic_write(&file, &serde_json::to_vec(&items).unwrap());
    }
    let _ = refresh_recents(app);
    let _ = app.emit("recents-changed", ());
}
#[tauri::command]
pub fn recent_projects(app: tauri::AppHandle) -> Vec<Recent> {
    recent(&app)
}
#[tauri::command]
pub fn clear_recent_projects(app: tauri::AppHandle) -> Result<(), String> {
    atomic_write(&recent_file(&app)?, b"[]")?;
    refresh_recents(&app).map_err(err)?;
    app.emit("recents-changed", ()).map_err(err)
}
pub fn refresh_recents(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let Some(tauri::menu::MenuItemKind::Submenu(sub)) = menu.get("file").and_then(|m| match m {
        tauri::menu::MenuItemKind::Submenu(s) => s.get("recent"),
        _ => None,
    }) else {
        return Ok(());
    };
    for item in sub.items()? {
        sub.remove(&item)?;
    }
    let recents = recent(app);
    for (index, recent) in recents.iter().enumerate() {
        sub.append(&MenuItemBuilder::with_id(format!("recent-{index}"), &recent.name).build(app)?)?;
    }
    if recents.is_empty() {
        sub.append(
            &MenuItemBuilder::new("No Recent Projects")
                .enabled(false)
                .build(app)?,
        )?;
    } else {
        sub.append(&tauri::menu::PredefinedMenuItem::separator(app)?)?;
        sub.append(&MenuItemBuilder::with_id("clear-recents", "Clear Menu").build(app)?)?;
    }
    Ok(())
}
pub fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let application = SubmenuBuilder::new(app, "Transcript Studio")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(
            &MenuItemBuilder::with_id("quit", "Quit Transcript Studio")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()?;
    let recents = Submenu::with_id(app, "recent", "Open Recent", true)?;
    let file = SubmenuBuilder::with_id(app, "file", "File")
        .item(
            &MenuItemBuilder::with_id("new", "New Project")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("open", "Open…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(&recents)
        .separator()
        .close_window()
        .item(
            &MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .enabled(false)
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("duplicate", "Duplicate…")
                .accelerator("CmdOrCtrl+Shift+S")
                .enabled(false)
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("export", "Export As…")
                .accelerator("CmdOrCtrl+Shift+E")
                .enabled(false)
                .build(app)?,
        )
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;
    #[cfg(target_os = "macos")]
    window.set_as_windows_menu_for_nsapp()?;
    app.set_menu(
        MenuBuilder::new(app)
            .items(&[&application, &file, &edit, &window])
            .build()?,
    )?;
    refresh_recents(app)
}
pub fn update_menu(app: &tauri::AppHandle, occupied: bool, can_export: bool) {
    if let Some(menu) = app.menu() {
        for (id, enabled) in [
            ("save", occupied),
            ("duplicate", occupied),
            ("export", can_export),
        ] {
            if let Some(tauri::menu::MenuItemKind::MenuItem(item)) =
                menu.get("file").and_then(|m| match m {
                    tauri::menu::MenuItemKind::Submenu(s) => s.get(id),
                    _ => None,
                })
            {
                let _ = item.set_enabled(enabled);
            }
        }
    }
}
#[tauri::command]
pub fn document_state(
    window: WebviewWindow,
    occupied: bool,
    can_export: bool,
    title: String,
    edited: bool,
) -> Result<(), String> {
    let app = window.app_handle();
    app.state::<Documents>()
        .windows
        .lock()
        .map_err(err)?
        .entry(window.label().into())
        .or_default()
        .occupied = occupied;
    window.set_title(&title).map_err(err)?;
    #[cfg(target_os = "macos")]
    {
        let clone = window.clone();
        window
            .run_on_main_thread(move || unsafe {
                if let Ok(ptr) = clone.ns_window() {
                    let ns = &*(ptr as *const objc2_app_kit::NSWindow);
                    ns.setDocumentEdited(edited);
                }
            })
            .map_err(err)?;
    }
    if window.is_focused().unwrap_or(false) {
        update_menu(app, occupied, can_export);
    }
    Ok(())
}
#[tauri::command]
pub fn window_bootstrap(window: WebviewWindow) -> Option<String> {
    let state = window.state::<Documents>();
    let mut all = state.windows.lock().ok()?;
    let document = all.entry(window.label().into()).or_default();
    document.ready = true;
    document.initial.take()
}
#[tauri::command]
pub fn new_project_window(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    if let Some(path) = path.as_ref().filter(|p| p.as_str() != "__open_dialog__") {
        let canonical = Path::new(path).canonicalize().map_err(err)?;
        for (label, doc) in app.state::<Documents>().windows.lock().map_err(err)?.iter() {
            if doc.path.as_ref() == Some(&canonical) {
                if let Some(w) = app.get_webview_window(label) {
                    w.set_focus().map_err(err)?;
                    return Ok(());
                }
            }
        }
    }
    let id = format!(
        "project-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    app.state::<Documents>()
        .windows
        .lock()
        .map_err(err)?
        .insert(
            id.clone(),
            Document {
                initial: path,
                ..Default::default()
            },
        );
    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &id, tauri::WebviewUrl::App("index.html".into()))
            .title("Untitled — Transcript Studio")
            .inner_size(1280., 850.)
            .min_inner_size(950., 650.);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    builder.build().map_err(err)?;
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    content: String,
    path: String,
    revision: String,
    recording_path: Option<String>,
    recording_exists: bool,
}
#[tauri::command]
pub fn read_project(window: WebviewWindow, path: PathBuf) -> Result<Loaded, String> {
    let path = path.canonicalize().map_err(err)?;
    if !matches!(
        path.extension().and_then(|v| v.to_str()),
        Some("tstudio" | "json")
    ) {
        return Err("Choose a Transcript Studio project or transcript.".into());
    }
    if fs::metadata(&path).map_err(err)?.len() > 50_000_000 {
        return Err("This project exceeds the 50 MB limit.".into());
    }
    let bytes = fs::read(&path).map_err(err)?;
    let data: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "This file is not a readable transcript or project.")?;
    let project = data["format"] == "transcript-studio-project";
    if project {
        if data["version"] != 1 {
            return Err("This project needs a newer version of Transcript Studio.".into());
        }
        if !data["transcript"].is_null() && !data["transcript"]["segments"].is_array() {
            return Err("This project’s transcript cannot be read.".into());
        }
        if data["recording"].is_null() && data["transcript"].is_null() {
            return Err("This project is empty.".into());
        }
    }
    let recording = data["recording"]["path"].as_str().map(|p| {
        let p = PathBuf::from(p);
        if p.is_absolute() {
            p
        } else {
            path.parent().unwrap().join(p)
        }
    });
    let recording_exists = recording.as_ref().is_some_and(|p| p.is_file());
    if project {
        let app = window.app_handle();
        let docs = app.state::<Documents>();
        let mut all = docs.windows.lock().map_err(err)?;
        if all
            .iter()
            .any(|(label, doc)| label != window.label() && doc.path.as_ref() == Some(&path))
        {
            return Err("This project is already open in another window.".into());
        }
        all.entry(window.label().into()).or_default().path = Some(path.clone());
        drop(all);
        remember(app, &path);
    }
    Ok(Loaded {
        content: String::from_utf8(bytes.clone()).map_err(err)?,
        revision: stamp(&bytes),
        path: path.to_string_lossy().into_owned(),
        recording_path: recording.map(|p| p.to_string_lossy().into_owned()),
        recording_exists,
    })
}
#[derive(Serialize)]
pub struct Saved {
    path: String,
    revision: String,
}
fn validate_revision(path: &Path, expected: Option<&str>) -> Result<(), String> {
    if let Some(expected) = expected {
        if fs::read(path).ok().map(|b| stamp(&b)).as_deref() != Some(expected) {
            return Err("This project changed outside this window. Use File → Duplicate to preserve your edits in a separate file.".into());
        }
    }
    Ok(())
}
fn project_bytes(content: &str, parent: &Path) -> Result<Vec<u8>, String> {
    let mut data: serde_json::Value = serde_json::from_str(content).map_err(err)?;
    if data["format"] != "transcript-studio-project" || data["version"] != 1 {
        return Err("Invalid project.".into());
    }
    if let Some(recording) = data["recording"]["path"].as_str().map(PathBuf::from) {
        if let Ok(relative) = recording.strip_prefix(parent) {
            data["recording"]["path"] = relative.to_string_lossy().into_owned().into();
        }
    }
    let bytes = serde_json::to_vec_pretty(&data).map_err(err)?;
    if bytes.len() > 50_000_000 {
        return Err("Project exceeds the 50 MB limit.".into());
    }
    Ok(bytes)
}
pub fn route_open(app: &tauri::AppHandle, path: String) -> Result<(), String> {
    let docs = app.state::<Documents>();
    let mut all = docs.windows.lock().map_err(err)?;
    if let Some(window) = app.webview_windows().values().find(|w| {
        all.get(w.label())
            .map(|d| !d.occupied && d.initial.is_none())
            .unwrap_or(true)
    }) {
        let doc = all.entry(window.label().into()).or_default();
        if doc.ready {
            window.emit("open-path", &path).map_err(err)?;
        } else {
            doc.initial = Some(path);
        }
        window.set_focus().map_err(err)?;
        return Ok(());
    }
    drop(all);
    new_project_window(app.clone(), Some(path))
}
#[tauri::command]
pub fn write_project(
    window: WebviewWindow,
    path: PathBuf,
    content: String,
    expected_revision: Option<String>,
    duplicate: bool,
) -> Result<Saved, String> {
    if path.extension().and_then(|v| v.to_str()) != Some("tstudio") {
        return Err("Save projects with the .tstudio extension.".into());
    }
    let parent = path
        .parent()
        .ok_or("Choose a project folder.")?
        .canonicalize()
        .map_err(err)?;
    let path = parent.join(path.file_name().ok_or("Enter a project name.")?);
    let docs = window.state::<Documents>();
    let mut all = docs.windows.lock().map_err(err)?;
    if all.iter().any(|(label, doc)| {
        (duplicate || label != window.label()) && doc.path.as_ref() == Some(&path)
    }) {
        return Err("This project is already open. Choose another name.".into());
    }
    validate_revision(&path, expected_revision.as_deref())?;
    let bytes = project_bytes(&content, &parent)?;
    atomic_write(&path, &bytes)?;
    if !duplicate {
        all.entry(window.label().into()).or_default().path = Some(path.clone());
    }
    drop(all);
    remember(window.app_handle(), &path);
    Ok(Saved {
        path: path.to_string_lossy().into_owned(),
        revision: stamp(&bytes),
    })
}
#[tauri::command]
pub async fn confirm_close(window: WebviewWindow, title: String) -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .message(format!("Do you want to save the changes to “{title}”?"))
            .title("Transcript Studio")
            .parent(&window)
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "Save".into(),
                "Don’t Save".into(),
                "Cancel".into(),
            ))
            .blocking_show_with_result()
    })
    .await
    .map_err(err)?;
    Ok(match result {
        MessageDialogResult::Yes => "save",
        MessageDialogResult::No => "discard",
        MessageDialogResult::Custom(ref s) if s == "Save" => "save",
        MessageDialogResult::Custom(ref s) if s == "Don’t Save" => "discard",
        _ => "cancel",
    }
    .into())
}
pub fn close_next(app: &tauri::AppHandle) {
    let windows = app.webview_windows();
    if let Some(w) = windows.values().find(|w| {
        app.state::<Documents>()
            .windows
            .lock()
            .unwrap()
            .contains_key(w.label())
    }) {
        let _ = w.close();
    } else {
        app.exit(0);
    }
}
#[tauri::command]
pub fn cancel_quit(app: tauri::AppHandle) {
    if let Ok(mut q) = app.state::<Documents>().quitting.lock() {
        *q = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changed_or_deleted_projects_are_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.tstudio");
        atomic_write(&path, b"original").unwrap();
        let expected = stamp(b"original");
        assert!(validate_revision(&path, Some(&expected)).is_ok());
        atomic_write(&path, b"external edit").unwrap();
        assert!(validate_revision(&path, Some(&expected)).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"external edit");
        fs::remove_file(&path).unwrap();
        assert!(validate_revision(&path, Some(&expected)).is_err());
    }
    #[test]
    fn recordings_inside_the_project_folder_move_with_the_project() {
        let content = r#"{"format":"transcript-studio-project","version":1,"recording":{"path":"/project/media/interview.mov","name":"interview.mov"}}"#;
        let data: serde_json::Value =
            serde_json::from_slice(&project_bytes(content, Path::new("/project")).unwrap())
                .unwrap();
        assert_eq!(data["recording"]["path"], "media/interview.mov");
        let outside: serde_json::Value =
            serde_json::from_slice(&project_bytes(content, Path::new("/other")).unwrap()).unwrap();
        assert_eq!(outside["recording"]["path"], "/project/media/interview.mov");
    }
    #[test]
    fn failed_save_leaves_existing_file_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.tstudio");
        atomic_write(&path, b"original").unwrap();
        assert!(atomic_write(&path.join("invalid"), b"new").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
    }
    #[test]
    fn atomic_replacement_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.tstudio");
        atomic_write(&path, b"original").unwrap();
        let first = stamp(&fs::read(&path).unwrap());
        atomic_write(&path, b"replacement").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert_ne!(first, stamp(b"replacement"));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
