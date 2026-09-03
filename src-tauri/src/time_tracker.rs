use crate::games::{list_installed_games, collect_launch_candidates};
use crate::settings::load_settings;
use crate::state::{tracker_config, tracker_stop_tx, TrackerConfig};
use crate::util::{is_ignored_executable, path_key};
use log::{debug, info, warn};
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use sysinfo::System;
use tokio::sync::watch;

#[tauri::command]
pub(crate) fn start_game_time_tracker(
  app: tauri::AppHandle,
  server_url: String,
  user_id: i64,
  access_token: String,
  download_path: Option<String>,
  download_paths: Option<Vec<String>>,
) -> Result<(), String> {
  if let Ok(mut tx) = tracker_stop_tx().lock() {
    if let Some(sender) = tx.take() {
      let _ = sender.send(true);
    }
  }

  // Build paths list: prefer download_paths if provided and non-empty,
  // otherwise fall back to single download_path
  let paths: Vec<String> = match download_paths {
    Some(ref dps) if !dps.is_empty() => dps.clone(),
    _ => match download_path {
      Some(ref dp) if !dp.is_empty() => vec![dp.clone()],
      _ => Vec::new(),
    },
  };

  info!(
    "time tracker starting: server={} user={} roots={}",
    server_url,
    user_id,
    paths.len()
  );

  let config = TrackerConfig {
    server_url,
    user_id,
    access_token,
    download_paths: paths,
  };

  if let Ok(mut cfg) = tracker_config().lock() {
    *cfg = Some(config);
  }

  let (stop_tx, stop_rx) = watch::channel(false);
  if let Ok(mut tx) = tracker_stop_tx().lock() {
    *tx = Some(stop_tx);
  }

  tauri::async_runtime::spawn(game_time_tracker_loop(stop_rx, app));

  Ok(())
}

#[tauri::command]
pub(crate) fn stop_game_time_tracker() -> Result<(), String> {
  if let Ok(mut tx) = tracker_stop_tx().lock() {
    if let Some(sender) = tx.take() {
      let _ = sender.send(true);
    }
  }
  if let Ok(mut cfg) = tracker_config().lock() {
    *cfg = None;
  }
  Ok(())
}

#[tauri::command]
pub(crate) fn update_tracker_auth(access_token: String) -> Result<(), String> {
  if let Ok(mut cfg) = tracker_config().lock() {
    if let Some(ref mut c) = *cfg {
      c.access_token = access_token;
    }
  }
  Ok(())
}

/// Poll interval in seconds. Defaults to 60; `GAMEVAULT_TRACKER_INTERVAL_SECS`
/// overrides it (minimum 1) for quicker manual verification. Test-only: the
/// server still counts a fixed 1 minute per tick, so a short interval inflates
/// recorded playtime.
fn resolve_interval_secs(raw: Option<String>) -> u64 {
  raw
    .and_then(|v| v.trim().parse::<u64>().ok())
    .filter(|v| *v >= 1)
    .unwrap_or(60)
}

async fn game_time_tracker_loop(mut stop_rx: watch::Receiver<bool>, app: tauri::AppHandle) {
  let interval_secs =
    resolve_interval_secs(std::env::var("GAMEVAULT_TRACKER_INTERVAL_SECS").ok());
  if interval_secs == 60 {
    info!("time tracker poll interval: 60s");
  } else {
    info!(
      "time tracker poll interval overridden to {interval_secs}s via \
       GAMEVAULT_TRACKER_INTERVAL_SECS (test-only: server still counts 1min per tick)"
    );
  }
  let mut interval = tokio::time::interval(Duration::from_secs(interval_secs));
  interval.tick().await;

  loop {
    tokio::select! {
      _ = interval.tick() => {},
      _ = stop_rx.changed() => {
        break;
      }
    }

    let config = match tracker_config().lock() {
      Ok(guard) => match guard.clone() {
        Some(c) => c,
        None => continue,
      },
      Err(_) => continue,
    };

    if config.download_paths.is_empty() || config.server_url.is_empty() {
      continue;
    }

    // Collect installed games from all root paths
    let mut installed = Vec::new();
    for path in &config.download_paths {
      if let Ok(games) = list_installed_games(path.clone()) {
        installed.extend(games);
      }
    }

    debug!(
      "tick: {} installed game(s) across {} root(s)",
      installed.len(),
      config.download_paths.len()
    );

    if installed.is_empty() {
      continue;
    }

    // The ignore list is global; read it once per tick, not once per game.
    let ignored = load_settings(&app).ignored_executables;

    // Index every game's launch candidates once. `by_key` holds resolved
    // (symlink-canonicalized) paths; `by_name` holds file names, for processes
    // whose argv references the binary relatively (e.g. "./BaldursGate").
    let mut by_key: HashMap<PathBuf, Vec<i64>> = HashMap::new();
    let mut by_name: HashMap<OsString, Vec<i64>> = HashMap::new();
    let mut game_titles: HashMap<i64, String> = HashMap::new();

    for game in &installed {
      game_titles
        .entry(game.game_id)
        .or_insert_with(|| game.game_title.clone());

      // The configured installation dir may not exist (e.g. no "Installation"
      // subfolder); fall back to the version dir so the game is still tracked.
      let configured_install = PathBuf::from(&game.installation_directory);
      let mut scan_dir = configured_install.clone();
      if !scan_dir.exists() || !scan_dir.is_dir() {
        scan_dir = PathBuf::from(&game.version_directory);
      }
      if !scan_dir.exists() || !scan_dir.is_dir() {
        continue;
      }

      // Always include the exact launcher the user runs (from the per-game
      // config), then any executables found by scanning the install dir.
      let mut abs_paths: Vec<PathBuf> = Vec::new();
      if let Some(rel_exe) = read_configured_launch_executable(Path::new(&game.version_directory)) {
        let abs = scan_dir.join(rel_exe);
        if abs.exists() && !is_ignored_executable(&abs, &ignored) {
          abs_paths.push(abs);
        }
      }

      let mut candidates = Vec::new();
      if collect_launch_candidates(&scan_dir, &scan_dir, &mut candidates).is_ok() {
        for rel in candidates {
          let abs = scan_dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
          if !is_ignored_executable(&abs, &ignored) {
            abs_paths.push(abs);
          }
        }
      }

      debug!(
        "game {} {:?}: {} candidate exe(s)",
        game.game_id,
        game.game_title,
        abs_paths.len()
      );

      for abs in abs_paths {
        if let Some(name) = abs.file_name() {
          push_unique(by_name.entry(name.to_os_string()).or_default(), game.game_id);
        }
        push_unique(by_key.entry(path_key(&abs)).or_default(), game.game_id);
      }
    }

    if by_key.is_empty() {
      continue;
    }

    let mut sys = System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let procs: Vec<ProcMatchInput> = sys
      .processes()
      .values()
      .map(ProcMatchInput::from_process)
      .collect();

    let running = match_running_games(&by_key, &by_name, &procs);

    if running.is_empty() {
      debug!("tick: no tracked game running");
      continue;
    }

    let mut matched_game_ids: Vec<i64> = Vec::new();
    for (game_id, (pid, hint)) in &running {
      debug!(
        "match: {:?} (game {}) <- pid {} {}",
        game_titles.get(game_id).map(String::as_str).unwrap_or("<unknown>"),
        game_id,
        pid,
        hint
      );
      matched_game_ids.push(*game_id);
    }

    let client = reqwest::Client::new();
    for game_id in matched_game_ids {
      let title = game_titles
        .get(&game_id)
        .map(String::as_str)
        .unwrap_or("<unknown>");
      let url = format!(
        "{}/api/progresses/user/{}/game/{}/increment",
        config.server_url, config.user_id, game_id
      );
      debug!("PUT {url}");
      let result = client
        .put(&url)
        .header("Authorization", format!("Bearer {}", config.access_token))
        .header("Accept", "application/json")
        .send()
        .await;

      match result {
        Ok(resp) if resp.status().is_success() => {
          info!(
            "playtime +1min: {:?} (game {}) -> HTTP {}",
            title,
            game_id,
            resp.status().as_u16()
          );
        }
        Ok(resp) => {
          warn!(
            "playtime NOT recorded: {:?} (game {}) -> HTTP {}; the request reached the \
             server so it was not saved offline",
            title,
            game_id,
            resp.status().as_u16()
          );
        }
        Err(e) => {
          warn!(
            "playtime request failed for {:?} (game {}): {}; saved 1min offline",
            title, game_id, e
          );
          save_offline_time(&config.download_paths, config.user_id, game_id);
        }
      }
    }
  }
}

fn push_unique(ids: &mut Vec<i64>, id: i64) {
  if !ids.contains(&id) {
    ids.push(id);
  }
}

/// A process reduced to what the matcher needs, computed once per tick: the
/// resolved key of its executable, the resolved keys of any absolute argv
/// entries, and the file names of every argv entry.
struct ProcMatchInput {
  pid: i64,
  exe_key: Option<PathBuf>,
  arg_keys: Vec<PathBuf>,
  arg_names: Vec<OsString>,
}

impl ProcMatchInput {
  fn from_process(process: &sysinfo::Process) -> Self {
    let exe_key = process.exe().map(path_key);
    let mut arg_keys = Vec::new();
    let mut arg_names = Vec::new();
    for arg in process.cmd() {
      let path = Path::new(arg);
      if path.is_absolute() {
        arg_keys.push(path_key(path));
      }
      if let Some(name) = path.file_name() {
        arg_names.push(name.to_os_string());
      }
    }
    Self {
      pid: process.pid().as_u32() as i64,
      exe_key,
      arg_keys,
      arg_names,
    }
  }
}

fn record(running: &mut HashMap<i64, (i64, String)>, ids: &[i64], pid: i64, hint: String) {
  for &id in ids {
    running.entry(id).or_insert_with(|| (pid, hint.clone()));
  }
}

/// Match running processes against the per-game candidate indexes. Returns, per
/// game id, the (pid, hint) of the first process that matched — `hint` is a
/// human-readable path or name for the log line.
fn match_running_games(
  by_key: &HashMap<PathBuf, Vec<i64>>,
  by_name: &HashMap<OsString, Vec<i64>>,
  procs: &[ProcMatchInput],
) -> HashMap<i64, (i64, String)> {
  let mut running: HashMap<i64, (i64, String)> = HashMap::new();

  for proc in procs {
    // Direct binary: the process exe resolves to a candidate.
    if let Some(key) = &proc.exe_key {
      if let Some(ids) = by_key.get(key) {
        record(&mut running, ids, proc.pid, key.display().to_string());
      }
    }
    // Script-launched games run via an interpreter whose argv names the script.
    for key in &proc.arg_keys {
      if let Some(ids) = by_key.get(key) {
        record(&mut running, ids, proc.pid, key.display().to_string());
      }
    }
    // Relative args ("./BaldursGate") can't be resolved — fall back to the name.
    for name in &proc.arg_names {
      if let Some(ids) = by_name.get(name) {
        record(&mut running, ids, proc.pid, name.to_string_lossy().into_owned());
      }
    }
  }

  running
}

fn read_configured_launch_executable(version_dir: &Path) -> Option<PathBuf> {
  let config_path = version_dir.join(".gamevault.game.config.json");
  let content = fs::read_to_string(config_path).ok()?;
  let value: serde_json::Value = serde_json::from_str(&content).ok()?;
  let exe = value.get("launchexecutable")?.as_str()?;
  if exe.trim().is_empty() {
    return None;
  }
  Some(PathBuf::from(exe))
}

fn save_offline_time(download_paths: &[String], user_id: i64, game_id: i64) {
  let mut installed = Vec::new();
  for path in download_paths {
    if let Ok(games) = list_installed_games(path.to_string()) {
      installed.extend(games);
    }
  }

  let target = match installed.iter().find(|g| g.game_id == game_id) {
    Some(g) => g,
    None => return,
  };

  let offline_file = PathBuf::from(&target.version_directory).join(".gamevault.offline_time.json");

  let mut current_minutes: i64 = 0;
  if offline_file.exists() {
    if let Ok(content) = fs::read_to_string(&offline_file) {
      if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
        current_minutes = json.get("accumulated_minutes").and_then(|v| v.as_i64()).unwrap_or(0);
      }
    }
  }

  let data = serde_json::json!({
    "user_id": user_id,
    "game_id": game_id,
    "accumulated_minutes": current_minutes + 1
  });

  let _ = fs::write(&offline_file, serde_json::to_string(&data).unwrap_or_default());
}

// ── Offline time tracking commands ────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OfflineTimeFile {
  path: String,
  user_id: i64,
  game_id: i64,
  accumulated_minutes: i64,
}

#[tauri::command]
pub(crate) fn get_offline_time_files(selected_root: String) -> Result<Vec<OfflineTimeFile>, String> {
  let candidate = PathBuf::from(&selected_root).join("GameVault");
  let base = if candidate.exists() { candidate } else { PathBuf::from(&selected_root) };

  let mut results = Vec::new();
  walk_offline_time_files(&base, &mut results)
    .map_err(|e| format!("Failed to scan for offline time files: {e}"))?;
  Ok(results)
}

fn walk_offline_time_files(dir: &Path, results: &mut Vec<OfflineTimeFile>) -> std::io::Result<()> {
  if !dir.exists() || !dir.is_dir() {
    return Ok(());
  }
  for entry in fs::read_dir(dir)? {
    let entry = entry?;
    let path = entry.path();
    if path.is_dir() {
      let name = entry.file_name().to_string_lossy().to_string();
      if name == ".cache" || name == "Download" || name == "Extraction" {
        continue;
      }
      walk_offline_time_files(&path, results)?;
    } else if entry.file_name() == ".gamevault.offline_time.json" {
      if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
          let user_id = json.get("user_id").and_then(|v| v.as_i64()).unwrap_or(0);
          let game_id = json.get("game_id").and_then(|v| v.as_i64()).unwrap_or(0);
          let accumulated_minutes = json.get("accumulated_minutes").and_then(|v| v.as_i64()).unwrap_or(0);
          results.push(OfflineTimeFile {
            path: path.to_string_lossy().to_string(),
            user_id,
            game_id,
            accumulated_minutes,
          });
        }
      }
    }
  }
  Ok(())
}

#[tauri::command]
pub(crate) fn delete_offline_time_file(path: String) -> Result<(), String> {
  let p = Path::new(&path);
  if p.exists() {
    fs::remove_file(p).map_err(|e| format!("Failed to delete offline time file: {e}"))?;
  }
  Ok(())
}

#[tauri::command]
pub(crate) async fn sync_offline_time(
  server_url: String,
  access_token: String,
  user_id: i64,
  game_id: i64,
  minutes: i64,
) -> Result<bool, String> {
  let url = format!(
    "{}/api/progresses/user/{}/game/{}/increment/{}",
    server_url, user_id, game_id, minutes
  );
  let client = reqwest::Client::new();
  let resp = client
    .put(&url)
    .header("Authorization", format!("Bearer {}", access_token))
    .header("Accept", "application/json")
    .send()
    .await
    .map_err(|e| format!("Sync request failed: {e}"))?;
  let ok = resp.status().is_success();
  if ok {
    info!("offline playtime synced: game {game_id} +{minutes}min -> HTTP {}", resp.status().as_u16());
  } else {
    warn!(
      "offline playtime sync rejected: game {game_id} +{minutes}min -> HTTP {}",
      resp.status().as_u16()
    );
  }
  Ok(ok)
}

#[cfg(test)]
mod tests {
  use super::{match_running_games, resolve_interval_secs, ProcMatchInput};
  use std::collections::HashMap;
  use std::ffi::OsString;
  use std::path::{Path, PathBuf};

  #[test]
  fn interval_defaults_to_60_when_unset() {
    assert_eq!(resolve_interval_secs(None), 60);
  }

  #[test]
  fn interval_honors_a_valid_override() {
    assert_eq!(resolve_interval_secs(Some(" 5 ".to_string())), 5);
  }

  #[test]
  fn interval_rejects_zero_and_garbage() {
    assert_eq!(resolve_interval_secs(Some("0".to_string())), 60);
    assert_eq!(resolve_interval_secs(Some("nonsense".to_string())), 60);
    assert_eq!(resolve_interval_secs(Some("-3".to_string())), 60);
  }

  fn proc(pid: i64, exe: Option<&str>, args: &[&str]) -> ProcMatchInput {
    ProcMatchInput {
      pid,
      exe_key: exe.map(PathBuf::from),
      arg_keys: args
        .iter()
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .map(PathBuf::from)
        .collect(),
      arg_names: args
        .iter()
        .filter_map(|a| Path::new(a).file_name().map(|n| n.to_os_string()))
        .collect(),
    }
  }

  fn index(entries: &[(&str, i64)]) -> (HashMap<PathBuf, Vec<i64>>, HashMap<OsString, Vec<i64>>) {
    let mut by_key: HashMap<PathBuf, Vec<i64>> = HashMap::new();
    let mut by_name: HashMap<OsString, Vec<i64>> = HashMap::new();
    for (path, id) in entries {
      let p = PathBuf::from(path);
      if let Some(name) = p.file_name() {
        by_name.entry(name.to_os_string()).or_default().push(*id);
      }
      by_key.entry(p).or_default().push(*id);
    }
    (by_key, by_name)
  }

  #[test]
  fn matches_a_directly_launched_binary() {
    let (by_key, by_name) = index(&[("/games/bg/game/BaldursGate", 7)]);
    let procs = [proc(101, Some("/games/bg/game/BaldursGate"), &["./BaldursGate"])];
    let running = match_running_games(&by_key, &by_name, &procs);
    assert_eq!(running.get(&7).map(|(pid, _)| *pid), Some(101));
  }

  #[test]
  fn matches_a_script_named_in_absolute_argv() {
    let (by_key, by_name) = index(&[("/games/bg/start.sh", 7)]);
    let procs = [proc(102, Some("/usr/bin/bash"), &["/bin/bash", "/games/bg/start.sh"])];
    let running = match_running_games(&by_key, &by_name, &procs);
    assert!(running.contains_key(&7));
  }

  #[test]
  fn matches_a_relative_argv_by_file_name() {
    let (by_key, by_name) = index(&[("/games/bg/game/BaldursGate", 7)]);
    // exe unknown (e.g. root-owned) — only the relative argv is visible.
    let procs = [proc(103, None, &["./BaldursGate"])];
    let running = match_running_games(&by_key, &by_name, &procs);
    assert!(running.contains_key(&7));
  }

  #[test]
  fn no_match_when_nothing_relevant_runs() {
    let (by_key, by_name) = index(&[("/games/bg/game/BaldursGate", 7)]);
    let procs = [
      proc(1, Some("/usr/bin/firefox"), &["firefox"]),
      proc(2, Some("/usr/lib/systemd/systemd"), &["/sbin/init"]),
    ];
    assert!(match_running_games(&by_key, &by_name, &procs).is_empty());
  }

  #[test]
  fn a_shared_basename_matches_every_owning_game() {
    let (by_key, by_name) = index(&[("/games/a/run.sh", 1), ("/games/b/run.sh", 2)]);
    let procs = [proc(200, Some("/usr/bin/bash"), &["bash", "./run.sh"])];
    let running = match_running_games(&by_key, &by_name, &procs);
    assert!(running.contains_key(&1) && running.contains_key(&2));
  }
}
