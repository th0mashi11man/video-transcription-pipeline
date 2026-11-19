use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChoice {
    path: String,
    kind: String,
    scope: String,
    frame_rate: f64,
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc2::{define_class, msg_send, rc::Retained, sel, DefinedClass, MainThreadOnly};
    use objc2_app_kit::{
        NSModalResponseOK, NSPopUpButton, NSSavePanel, NSTextAlignment, NSTextField, NSView,
        NSWindow,
    };
    use objc2_foundation::{
        MainThreadMarker, NSArray, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString,
    };
    const KINDS: [&str; 5] = ["docx", "txt", "inqscribe", "srt", "vtt"];
    const RATES: [f64; 9] = [
        24000. / 1001.,
        24.,
        25.,
        30000. / 1001.,
        30.,
        48.,
        50.,
        60000. / 1001.,
        60.,
    ];
    struct Controls {
        panel: Retained<NSSavePanel>,
        format: Retained<NSPopUpButton>,
        scope: Retained<NSPopUpButton>,
        rate: Retained<NSPopUpButton>,
    }
    define_class!(
        #[unsafe(super=NSObject)]
        #[thread_kind=MainThreadOnly]
        #[ivars=Controls]
        struct ExportTarget;
        unsafe impl NSObjectProtocol for ExportTarget {}
        impl ExportTarget {
            #[unsafe(method(formatChanged:))]
            fn changed(&self, _sender: &NSPopUpButton) { self.update(); }
        }
    );
    impl ExportTarget {
        fn update(&self) {
            let c = self.ivars();
            let index = c.format.indexOfSelectedItem() as usize;
            let extension = match index {
                0 => "docx",
                3 => "srt",
                4 => "vtt",
                _ => "txt",
            };
            #[allow(deprecated)]
            c.panel
                .setAllowedFileTypes(Some(&NSArray::from_retained_slice(&[NSString::from_str(
                    extension,
                )])));
            c.scope.setEnabled(index < 3);
            if index >= 3 {
                c.scope.selectItemAtIndex(0);
            }
            c.rate.setEnabled(index == 2);
        }
    }
    fn rect(x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))
    }
    fn dropdown(
        m: MainThreadMarker,
        view: &NSView,
        label: &str,
        y: f64,
        items: &[&str],
        selected: usize,
    ) -> Retained<NSPopUpButton> {
        let text = NSTextField::labelWithString(&NSString::from_str(label), m);
        text.setFrame(rect(12., y + 4., 94., 22.));
        text.setAlignment(NSTextAlignment::Right);
        let control = NSPopUpButton::initWithFrame_pullsDown(
            NSPopUpButton::alloc(m),
            rect(116., y, 250., 28.),
            false,
        );
        for item in items {
            control.addItemWithTitle(&NSString::from_str(item));
        }
        control.selectItemAtIndex(selected as isize);
        view.addSubview(&text);
        view.addSubview(&control);
        control
    }
    pub async fn show(
        window: tauri::WebviewWindow,
        name: String,
        kind: String,
        scope: String,
        frame_rate: f64,
    ) -> Result<Option<ExportChoice>, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        let clone = window.clone();
        window
            .run_on_main_thread(move || {
                let result = (|| -> Result<(), String> {
                    let mtm = MainThreadMarker::new().ok_or("Cannot show the export sheet.")?;
                    let ptr = clone.ns_window().map_err(|e| e.to_string())?;
                    // Tauri owns this NSWindow; the sheet completion retains only the panel and its controls.
                    let parent = unsafe { &*(ptr as *const NSWindow) };
                    let panel = NSSavePanel::savePanel(mtm);
                    panel.setTitle(Some(&NSString::from_str("Export Transcript")));
                    panel.setPrompt(Some(&NSString::from_str("Export")));
                    panel.setCanCreateDirectories(true);
                    panel.setShowsTagField(false);
                    panel.setExtensionHidden(false);
                    panel.setNameFieldStringValue(&NSString::from_str(&name));
                    let view = NSView::initWithFrame(NSView::alloc(mtm), rect(0., 0., 380., 112.));
                    let format = dropdown(
                        mtm,
                        &view,
                        "Format:",
                        76.,
                        &[
                            "Word document (.docx)",
                            "Plain text (.txt)",
                            "InqScribe (.txt)",
                            "SubRip captions (.srt)",
                            "WebVTT captions (.vtt)",
                        ],
                        KINDS.iter().position(|k| *k == kind).unwrap_or(0),
                    );
                    let scope = dropdown(
                        mtm,
                        &view,
                        "Content:",
                        40.,
                        &["All turns", "Current view"],
                        usize::from(scope == "visible"),
                    );
                    let rate = dropdown(
                        mtm,
                        &view,
                        "Frame rate:",
                        4.,
                        &[
                            "23.976 fps",
                            "24 fps",
                            "25 fps",
                            "29.97 fps (non-drop)",
                            "30 fps",
                            "48 fps",
                            "50 fps",
                            "59.94 fps (non-drop)",
                            "60 fps",
                        ],
                        RATES
                            .iter()
                            .position(|r| (r - frame_rate).abs() < 0.001)
                            .unwrap_or(2),
                    );
                    let allocated = ExportTarget::alloc(mtm).set_ivars(Controls {
                        panel: panel.clone(),
                        format: format.clone(),
                        scope: scope.clone(),
                        rate: rate.clone(),
                    });
                    let target: Retained<ExportTarget> =
                        unsafe { msg_send![super(allocated), init] };
                    unsafe {
                        format.setTarget(Some(&target));
                        format.setAction(Some(sel!(formatChanged:)));
                    }
                    target.update();
                    panel.setAccessoryView(Some(&view));
                    let completion_panel = panel.clone();
                    let completion_tx = tx.clone();
                    let completion = block2::RcBlock::new(move |response| {
                        let c = target.ivars(); // Keep the target alive for every format change until the sheet closes.
                        let choice = if response == NSModalResponseOK {
                            completion_panel
                                .URL()
                                .and_then(|url| url.path())
                                .map(|path| ExportChoice {
                                    path: path.to_string(),
                                    kind: KINDS[c.format.indexOfSelectedItem() as usize].into(),
                                    scope: if c.scope.indexOfSelectedItem() == 1
                                        && c.format.indexOfSelectedItem() < 3
                                    {
                                        "visible"
                                    } else {
                                        "all"
                                    }
                                    .into(),
                                    frame_rate: RATES[c.rate.indexOfSelectedItem() as usize],
                                })
                        } else {
                            None
                        };
                        completion_panel.orderOut(None);
                        let _ = completion_tx.send(Ok(choice));
                    });
                    panel.beginSheetModalForWindow_completionHandler(parent, &completion);
                    Ok(())
                })();
                if let Err(error) = result {
                    let _ = tx.send(Err(error));
                }
            })
            .map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
            .await
            .map_err(|e| e.to_string())?
    }
}
#[tauri::command]
pub async fn export_panel(
    window: tauri::WebviewWindow,
    name: String,
    kind: String,
    scope: String,
    frame_rate: f64,
) -> Result<Option<ExportChoice>, String> {
    #[cfg(target_os = "macos")]
    {
        mac::show(window, name, kind, scope, frame_rate).await
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, name, kind, scope, frame_rate);
        Err("This export sheet requires macOS.".into())
    }
}
