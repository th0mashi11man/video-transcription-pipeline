//! Manual native-panel check: cargo run --example export-sheet-check -- <name> <kind>
//! This example is not part of the distributed app.
#[path = "../src/export_panel.rs"]
mod export_panel;
#[cfg(target_os = "macos")]
use tauri::Manager;
#[cfg(target_os = "macos")]
fn main() {
    let name = std::env::args()
        .nth(1)
        .unwrap_or("Transcript export check".into());
    let kind = std::env::args().nth(2).unwrap_or("docx".into());
    tauri::Builder::default()
        .on_page_load(|webview, event| {
            if matches!(event.event(), tauri::webview::PageLoadEvent::Finished) {
                let _=webview.eval("document.body.innerHTML='<p style=\"font:16px -apple-system;padding:32px\">Native export sheet check</p>'");
            }
        })
        .setup(move |app| {
            let window=app.get_webview_window("main").unwrap();
            let app=app.handle().clone();
            if std::env::args().any(|s|s=="--automatic") {
                let probe_app=app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let copy=probe_app.clone();
                    probe_app.run_on_main_thread(move || {
                        use objc2::msg_send;
                        use objc2_foundation::MainThreadMarker;
                        use objc2_app_kit::{NSApplication, NSSavePanel, NSPopUpButton};
                        let marker=MainThreadMarker::new().unwrap();
                        let app=NSApplication::sharedApplication(marker);
                        let windows=app.windows();
                        let panel=windows.iter().find_map(|w|w.downcast::<NSSavePanel>().ok());
                        let Some(panel)=panel else { eprintln!("FAIL: Native export sheet was not displayed");copy.exit(1);return; };
                        let view=panel.accessoryView().expect("Export accessory view");
                        let children=view.subviews();
                        let controls:Vec<_>=children.iter().filter_map(|c|c.downcast::<NSPopUpButton>().ok()).collect();
                        assert_eq!(controls.len(),3);
                        let format=&controls[0];let scope=&controls[1];let rate=&controls[2];
                        for (index,extension) in ["docx","txt","txt","srt","vtt"].iter().enumerate() {
                            format.selectItemAtIndex(index as isize);
                            unsafe { let _:()=msg_send![&*format.target().unwrap(),formatChanged: &**format]; }
                            #[allow(deprecated)]
                            let extensions=panel.allowedFileTypes().unwrap();
                            assert_eq!(extensions.objectAtIndex(0).to_string(),*extension);
                            assert_eq!(scope.isEnabled(),index<3);
                            assert_eq!(rate.isEnabled(),index==2);
                        }
                        format.selectItemAtIndex(2);
                        unsafe { let _:()=msg_send![&*format.target().unwrap(),formatChanged: &**format]; }
                        scope.selectItemAtIndex(1);rate.selectItemAtIndex(3);
                        println!("PASS: Native sheet, five formats, extension filters, scope and frame-rate controls. Window: {}",panel.windowNumber());
                        // The remote macOS save service owns the Export button. Automatic mode
                        // verifies controls, then exits without choosing or writing a file.
                        let copy=copy.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_secs(10));
                            copy.exit(0);
                        });
                    }).unwrap();
                });
            }
            tauri::async_runtime::spawn(async move {
                std::thread::sleep(std::time::Duration::from_secs(2));
                let result=export_panel::export_panel(window,name,kind,"all".into(),25.).await;
                println!("Export result: {}",match result {Ok(value)=>serde_json::to_string(&value).unwrap(),Err(error)=>error});
                app.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!()).expect("Cannot run native export check");
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("The native export sheet check requires macOS.");
}
