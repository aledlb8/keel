//! Windows beyond the main one, and the monitors they sit on.
//!
//! The main window owns Keel's state. Every other window is a *screen*: it shows
//! one deck, mirrors the main window's state, and sends anything you do there
//! back to it. A screen's terminals attach to the panes' Rust terminals the same
//! way the main window's do, so moving a deck between windows restarts nothing.
//!
//! This file makes and places the windows, lists the monitors, and tells the
//! main window when a window moves, gains focus or goes away. Which deck a
//! screen shows is the main window's business, not this file's.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

use crate::pty::MAIN_WINDOW;

/// Labels of screen windows start with this; the rest is the screen's id.
pub const SCREEN_PREFIX: &str = "screen-";

/// Smallest a window is allowed to be, logical pixels. Matches the main window.
const MIN_WIDTH: f64 = 600.0;
const MIN_HEIGHT: f64 = 400.0;

/// A window's place on the desktop, in physical pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
    /// The monitor it was on, by name, when it was saved.
    #[serde(default)]
    pub monitor: Option<String>,
}

/// One monitor, in physical pixels.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// The part not taken by the taskbar.
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: u32,
    pub work_height: u32,
    pub scale: f64,
    pub primary: bool,
}

/// Where to put a window: exactly here, or filling a monitor's work area.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    #[serde(default)]
    pub bounds: Option<Bounds>,
    #[serde(default)]
    pub monitor: Option<String>,
    /// Keep the window above every other window, a pane popped out to watch.
    #[serde(default)]
    pub on_top: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowBoundsEvent {
    label: String,
    bounds: Bounds,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowFocusEvent {
    label: String,
    focused: bool,
}

fn monitor_name(monitor: &tauri::Monitor, index: usize) -> String {
    monitor
        .name()
        .cloned()
        .unwrap_or_else(|| format!("Display {}", index + 1))
}

fn displays_of<R: Runtime>(app: &AppHandle<R>) -> Vec<Display> {
    let primary = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| *monitor.position());
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            let work = monitor.work_area();
            Display {
                name: monitor_name(monitor, index),
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
                work_x: work.position.x,
                work_y: work.position.y,
                work_width: work.size.width,
                work_height: work.size.height,
                scale: monitor.scale_factor(),
                primary: primary == Some(*monitor.position()),
            }
        })
        .collect()
}

/// The monitors attached right now.
#[tauri::command(async)]
pub async fn displays(app: AppHandle) -> Vec<Display> {
    displays_of(&app)
}

/// Where a window is. A macro because `Window` and `WebviewWindow` answer the
/// same questions without sharing a trait for them. Nothing while it is
/// minimized: Windows parks it far off the desktop, which is not a place to
/// come back to.
macro_rules! bounds_of {
    ($window:expr) => {{
        let window = $window;
        (|| {
            if window.is_minimized().unwrap_or(false) {
                return None;
            }
            let position = window.outer_position().ok()?;
            // Inner, because that is what `set_size` takes back.
            let size = window.inner_size().ok()?;
            let maximized = window.is_maximized().unwrap_or(false);
            let monitor = window.current_monitor().ok().flatten().map(|monitor| {
                let index = window
                    .available_monitors()
                    .unwrap_or_default()
                    .iter()
                    .position(|other| other.position() == monitor.position())
                    .unwrap_or(0);
                monitor_name(&monitor, index)
            });
            Some(Bounds {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                maximized,
                monitor,
            })
        })()
    }};
}

/// Bounds that still land on a monitor that is attached. A window saved on a
/// monitor that is gone, or half off the desktop, is put on one that is here.
fn visible_bounds(bounds: &Bounds, displays: &[Display]) -> Option<Bounds> {
    let centre_x = bounds.x + (bounds.width / 2) as i32;
    let centre_y = bounds.y + (bounds.height / 2) as i32;
    let home = displays.iter().find(|display| {
        centre_x >= display.work_x
            && centre_x < display.work_x + display.work_width as i32
            && centre_y >= display.work_y
            && centre_y < display.work_y + display.work_height as i32
    })?;
    let width = bounds.width.min(home.work_width);
    let height = bounds.height.min(home.work_height);
    let x = bounds
        .x
        .clamp(home.work_x, home.work_x + (home.work_width - width) as i32);
    let y = bounds.y.clamp(
        home.work_y,
        home.work_y + (home.work_height - height) as i32,
    );
    Some(Bounds {
        x,
        y,
        width,
        height,
        maximized: bounds.maximized,
        monitor: Some(home.name.clone()),
    })
}

/// Put a window where `placement` says. Exact bounds win if they still fit on
/// an attached monitor; otherwise it fills the named monitor's work area, or
/// failing that the primary one.
fn place<R: Runtime>(window: &WebviewWindow<R>, placement: &Placement) {
    if let Some(on_top) = placement.on_top {
        let _ = window.set_always_on_top(on_top);
    }
    let displays = displays_of(window.app_handle());
    if let Some(bounds) = placement
        .bounds
        .as_ref()
        .and_then(|bounds| visible_bounds(bounds, &displays))
    {
        let _ = window.unmaximize();
        let _ = window.set_position(PhysicalPosition::new(bounds.x, bounds.y));
        let _ = window.set_size(PhysicalSize::new(bounds.width, bounds.height));
        if bounds.maximized {
            let _ = window.maximize();
        }
        return;
    }
    let target = placement
        .monitor
        .as_ref()
        .and_then(|name| displays.iter().find(|display| &display.name == name))
        .or_else(|| displays.iter().find(|display| display.primary))
        .or_else(|| displays.first());
    if let Some(display) = target {
        let _ = window.unmaximize();
        let _ = window.set_position(PhysicalPosition::new(display.work_x, display.work_y));
        let _ = window.set_size(PhysicalSize::new(display.work_width, display.work_height));
        let _ = window.maximize();
    }
}

fn screen_label(id: &str) -> Result<String, String> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
    if valid {
        Ok(format!("{SCREEN_PREFIX}{id}"))
    } else {
        Err("invalid screen id".into())
    }
}

/// Open the window for screen `id`, or bring it forward if it is open, and
/// put it where `placement` says.
#[tauri::command(async)]
pub async fn screen_open(app: AppHandle, id: String, placement: Placement) -> Result<(), String> {
    let label = screen_label(&id)?;
    if let Some(window) = app.get_webview_window(&label) {
        place(&window, &placement);
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    // Built hidden so it never flashes at the default place first.
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Keel")
        .inner_size(1200.0, 800.0)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .background_color(tauri::window::Color(0, 0, 0, 0))
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|err| format!("could not open a window: {err}"))?;
    #[cfg(windows)]
    crate::disable_browser_accelerator_keys(&window);
    place(&window, &placement);
    window
        .show()
        .map_err(|err| format!("could not show the window: {err}"))?;
    let _ = window.set_focus();
    Ok(())
}

/// Close screen `id`'s window. Its deck is already back with the main window.
#[tauri::command(async)]
pub async fn screen_close(app: AppHandle, id: String) -> Result<(), String> {
    let label = screen_label(&id)?;
    if let Some(window) = app.get_webview_window(&label) {
        window
            .destroy()
            .map_err(|err| format!("could not close the window: {err}"))?;
    }
    Ok(())
}

/// Put any Keel window somewhere. The main window uses it to come back where
/// it was left.
#[tauri::command(async)]
pub async fn window_place(
    app: AppHandle,
    label: String,
    placement: Placement,
) -> Result<(), String> {
    if label != MAIN_WINDOW && !label.starts_with(SCREEN_PREFIX) {
        return Err("not a Keel window".into());
    }
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window named {label}"))?;
    place(&window, &placement);
    Ok(())
}

/// Keep a Keel window above every other window, or stop.
#[tauri::command(async)]
pub async fn window_on_top(app: AppHandle, label: String, on_top: bool) -> Result<(), String> {
    if !label.starts_with(SCREEN_PREFIX) {
        return Err("only screens float".into());
    }
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window named {label}"))?;
    window
        .set_always_on_top(on_top)
        .map_err(|err| err.to_string())
}

/// Bring a Keel window forward and give it the keyboard.
#[tauri::command(async)]
pub async fn window_focus(app: AppHandle, label: String) -> Result<(), String> {
    if label != MAIN_WINDOW && !label.starts_with(SCREEN_PREFIX) {
        return Err("not a Keel window".into());
    }
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| format!("no window named {label}"))?;
    let _ = window.unminimize();
    window.set_focus().map_err(|err| err.to_string())
}

/// Where every Keel window is right now, by label.
#[tauri::command(async)]
pub async fn window_bounds(app: AppHandle) -> Vec<(String, Bounds)> {
    app.webview_windows()
        .into_iter()
        .filter_map(|(label, window)| Some((label, bounds_of!(&window)?)))
        .collect()
}

/// Tell the main window about moves, focus and closes in any Keel window.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let label = window.label().to_string();
    let app = window.app_handle();
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(bounds) = bounds_of!(window) {
                let _ = app.emit_to(
                    MAIN_WINDOW,
                    "window:bounds",
                    WindowBoundsEvent { label, bounds },
                );
            }
        }
        WindowEvent::Focused(focused) => {
            let _ = app.emit_to(
                MAIN_WINDOW,
                "window:focus",
                WindowFocusEvent {
                    label,
                    focused: *focused,
                },
            );
        }
        WindowEvent::Destroyed if label.starts_with(SCREEN_PREFIX) => {
            let _ = app.emit_to(MAIN_WINDOW, "screen:closed", label);
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(name: &str, x: i32, width: u32) -> Display {
        Display {
            name: name.into(),
            x,
            y: 0,
            width,
            height: 1080,
            work_x: x,
            work_y: 0,
            work_width: width,
            work_height: 1040,
            scale: 1.0,
            primary: x == 0,
        }
    }

    fn bounds(x: i32, y: i32, width: u32, height: u32) -> Bounds {
        Bounds {
            x,
            y,
            width,
            height,
            maximized: false,
            monitor: None,
        }
    }

    #[test]
    fn bounds_on_an_attached_monitor_are_kept() {
        let displays = [display("A", 0, 1920), display("B", 1920, 2560)];
        let placed = visible_bounds(&bounds(2000, 100, 1200, 800), &displays).unwrap();
        assert_eq!(
            (placed.x, placed.y, placed.width, placed.height),
            (2000, 100, 1200, 800)
        );
        assert_eq!(placed.monitor.as_deref(), Some("B"));
    }

    #[test]
    fn bounds_on_a_monitor_that_is_gone_are_dropped() {
        let displays = [display("A", 0, 1920)];
        assert!(visible_bounds(&bounds(2000, 100, 1200, 800), &displays).is_none());
    }

    #[test]
    fn bounds_hanging_off_a_monitor_are_pulled_onto_it() {
        let displays = [display("A", 0, 1920)];
        let placed = visible_bounds(&bounds(1200, 600, 1000, 800), &displays).unwrap();
        assert_eq!((placed.x, placed.y), (920, 240));
    }

    #[test]
    fn bounds_bigger_than_the_monitor_shrink_to_it() {
        let displays = [display("A", 0, 1920)];
        let placed = visible_bounds(&bounds(-100, -100, 2200, 1300), &displays).unwrap();
        assert_eq!(
            (placed.x, placed.y, placed.width, placed.height),
            (0, 0, 1920, 1040)
        );
    }

    #[test]
    fn only_screen_ids_that_are_safe_labels_are_accepted() {
        assert_eq!(screen_label("abc_1-2").unwrap(), "screen-abc_1-2");
        assert!(screen_label("").is_err());
        assert!(screen_label("../main").is_err());
        assert!(screen_label("a b").is_err());
    }
}
