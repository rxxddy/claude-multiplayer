//! Tray icon. Optionally draws the Claude limits on it as pixel digits
//! (top row = 5-hour usage %, bottom row = weekly %).

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State};

use crate::claude::UsageInfo;
use crate::util::lock;
use crate::{settings, AppState};

const TRAY_ID: &str = "claude-usage";
const ICON_SIZE: usize = 32;

static SHOW_DIGITS: AtomicBool = AtomicBool::new(false);

/// 3x5 bitmaps for 0-9.
const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

fn level_color(pct: i32) -> [u8; 3] {
    match pct {
        p if p < 0 => [120, 117, 110],
        p if p >= 90 => [224, 83, 71],
        p if p >= 70 => [233, 162, 59],
        _ => [217, 119, 87],
    }
}

/// 32x32 RGBA: rounded dark tile with two 2-digit numbers (capped at 99, "--" when unknown).
fn render_usage_icon(session_pct: i32, week_pct: i32) -> Image<'static> {
    const N: usize = ICON_SIZE;
    let mut px = vec![0u8; N * N * 4];
    let mut put = |x: usize, y: usize, c: [u8; 3]| {
        if x < N && y < N {
            let i = (y * N + x) * 4;
            px[i..i + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
        }
    };

    for y in 0..N {
        for x in 0..N {
            #[allow(clippy::cast_possible_wrap)]
            let (dx, dy) = ((x as i32 - 15).abs(), (y as i32 - 15).abs());
            let corner = dx > 11 && dy > 11 && (dx - 11).pow(2) + (dy - 11).pow(2) > 16;
            if !corner {
                put(x, y, [28, 27, 25]);
            }
        }
    }

    let mut draw_number = |value: i32, top: usize| {
        let color = level_color(value);
        let text = if value < 0 {
            "--".to_string()
        } else {
            format!("{:02}", value.min(99))
        };
        for (k, ch) in text.chars().enumerate() {
            let x0 = 6 + k * 11;
            match ch.to_digit(10) {
                Some(d) => {
                    for (row, bits) in DIGITS[d as usize].iter().enumerate() {
                        for col in 0..3 {
                            if bits & (0b100 >> col) == 0 {
                                continue;
                            }
                            for sy in 0..2 {
                                for sx in 0..3 {
                                    put(x0 + col * 3 + sx, top + row * 2 + sy, color);
                                }
                            }
                        }
                    }
                }
                None => {
                    for sx in 0..9 {
                        put(x0 + sx, top + 4, color);
                        put(x0 + sx, top + 5, color);
                    }
                }
            }
        }
    };
    draw_number(session_pct, 4);
    draw_number(week_pct, 18);

    #[allow(clippy::cast_possible_truncation)]
    Image::new_owned(px, N as u32, N as u32)
}

fn tooltip(u: &UsageInfo) -> String {
    if u.session_pct < 0 {
        return "Claude Multiplayer · usage not available yet".to_string();
    }
    let line = |label: &str, pct: i32, reset: &str| {
        let pct = if pct < 0 {
            "--".to_string()
        } else {
            format!("{pct}%")
        };
        if reset.is_empty() {
            format!("{label}: {pct}")
        } else {
            format!("{label}: {pct} · resets {reset}")
        }
    };
    format!(
        "Claude limits\n{}\n{}",
        line("5-hour", u.session_pct, &u.session_reset),
        line("weekly", u.week_pct, &u.week_reset)
    )
}

fn icon(app: &AppHandle, u: &UsageInfo) -> Option<Image<'static>> {
    if SHOW_DIGITS.load(Ordering::SeqCst) {
        Some(render_usage_icon(u.session_pct, u.week_pct))
    } else {
        app.default_window_icon().map(|i| i.clone().to_owned())
    }
}

pub fn ensure(app: &AppHandle, show_digits: bool) -> Result<(), String> {
    SHOW_DIGITS.store(show_digits, Ordering::SeqCst);
    let usage = lock(&app.state::<AppState>().usage).clone();
    if app.tray_by_id(TRAY_ID).is_some() {
        refresh(app, &usage);
        return Ok(());
    }

    let open =
        MenuItem::with_id(app, "open", "Open", true, None::<&str>).map_err(|e| e.to_string())?;
    let quit =
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&open, &quit]).map_err(|e| e.to_string())?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID);
    if let Some(img) = icon(app, &usage) {
        builder = builder.icon(img);
    }
    builder
        .tooltip(tooltip(&usage))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, e| match e.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = e
            {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    promote_icon();
    Ok(())
}

pub fn refresh(app: &AppHandle, u: &UsageInfo) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Some(img) = icon(app, u) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_tooltip(Some(tooltip(u)));
    }
}

/// Windows 11 hides new tray icons in the overflow flyout. Mark ours as "shown on taskbar"
/// (the same flag as Settings > Taskbar > Other system tray icons). Explorer registers the
/// entry a moment after the icon appears, so retry for a few seconds.
fn promote_icon() {
    #[cfg(windows)]
    std::thread::spawn(|| {
        let script = r"Get-ChildItem 'HKCU:\Control Panel\NotifyIconSettings' -ErrorAction SilentlyContinue | ForEach-Object { $p=(Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).ExecutablePath; if ($p -and ($p -like '*claude-multiplayer*' -or $p -like '*claude-cyberdeck*')) { Set-ItemProperty $_.PSPath -Name IsPromoted -Value 1 -Type DWord; 'ok' } }";
        for _ in 0..10 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let promoted = crate::util::silent_command("powershell")
                .args(["-NoProfile", "-Command", script])
                .output()
                .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains("ok"));
            if promoted {
                break;
            }
        }
    });
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false);
        if visible && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

#[tauri::command]
pub fn set_tray_enabled(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<bool, String> {
    {
        let mut cfg = lock(&state.settings);
        cfg.tray_enabled = enabled;
        settings::save(&cfg);
    }
    ensure(&app, enabled)?;
    Ok(enabled)
}
