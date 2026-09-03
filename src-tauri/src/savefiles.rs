//! Cloud save syncing via a bundled Ludusavi sidecar.
//!
//! Ludusavi (https://github.com/mtkennerly/ludusavi, MIT) knows where a large
//! set of PC games keep their save data (its manifest is sourced from
//! PCGamingWiki). We shell out to it exactly like the rest of the codebase
//! shells out to installers/games (`std::process::Command`), parse its
//! `--api` JSON, and move a single `.zip` between the local machine and the
//! GameVault server's `/api/savefiles` endpoints (the HTTP part lives in the
//! frontend so it can reuse `authFetch`'s token handling).
//!
//! On-disk backup layout produced by `ludusavi backup --format simple`:
//!   <path>/<Canonical Game Name>/mapping.yaml
//!   <path>/<Canonical Game Name>/drive-0/...
//! We zip that `<path>` directory as-is; restore extracts it back and points
//! `ludusavi restore --path` at the extracted copy.

use serde::Serialize;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

const TARGET_TRIPLE: &str = env!("GV_TARGET_TRIPLE");

const MANIFEST_URL: &str =
  "https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml";

// ── Sidecar & config resolution ──────────────────────────────────────────────

/// Locate the Ludusavi sidecar. In a bundle Tauri drops it next to the main
/// executable as `ludusavi[.exe]`; for `tauri dev`/`tauri build` it lives at
/// `src-tauri/binaries/ludusavi-<target-triple>[.exe]` (fetched by
/// `scripts/fetch-ludusavi.mjs`).
fn resolve_ludusavi() -> Result<PathBuf, String> {
  let ext = if cfg!(windows) { ".exe" } else { "" };
  let plain = format!("ludusavi{ext}");
  let suffixed = format!("ludusavi-{TARGET_TRIPLE}{ext}");

  let mut candidates: Vec<PathBuf> = Vec::new();
  if let Ok(exe) = std::env::current_exe() {
    if let Some(dir) = exe.parent() {
      candidates.push(dir.join(&plain));
      candidates.push(dir.join(&suffixed));
    }
  }
  // Dev fallback: the binaries/ dir in the crate source tree.
  candidates.push(
    Path::new(env!("CARGO_MANIFEST_DIR"))
      .join("binaries")
      .join(&suffixed),
  );

  candidates
    .iter()
    .find(|p| p.is_file())
    .cloned()
    .ok_or_else(|| {
      "Ludusavi sidecar not found. Run `pnpm sidecar` (scripts/fetch-ludusavi.mjs) and rebuild."
        .to_string()
    })
}

/// Directory that holds Ludusavi's own `config.yaml` + downloaded manifest, kept
/// inside our app-data dir so it never touches a user's system-wide Ludusavi
/// install.
fn ludusavi_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
    .join("ludusavi");
  fs::create_dir_all(&dir)
    .map_err(|e| format!("Failed to create Ludusavi config dir: {e}"))?;
  Ok(dir)
}

/// (Re)write a minimal `config.yaml`. `library_roots` are the GameVault library
/// folders; exposing them as `other` roots lets Ludusavi resolve `<base>` saves
/// for the subset of games that keep saves in their install directory. Saves in
/// standard OS locations (home, XDG dirs, AppData, Documents, …) are found by
/// Ludusavi's default scan regardless.
fn write_ludusavi_config(
  config_dir: &Path,
  backup_path: &Path,
  library_roots: &[String],
) -> Result<(), String> {
  let mut yaml = String::new();
  yaml.push_str("manifest:\n");
  yaml.push_str(&format!("  url: {}\n", yaml_quote(MANIFEST_URL)));
  yaml.push_str("backup:\n");
  yaml.push_str(&format!("  path: {}\n", yaml_quote(&backup_path.to_string_lossy())));
  yaml.push_str("restore:\n");
  yaml.push_str(&format!("  path: {}\n", yaml_quote(&backup_path.to_string_lossy())));

  let roots: Vec<&str> = library_roots
    .iter()
    .map(|r| r.trim())
    .filter(|r| !r.is_empty())
    .collect();
  if roots.is_empty() {
    yaml.push_str("roots: []\n");
  } else {
    yaml.push_str("roots:\n");
    for root in roots {
      yaml.push_str(&format!("  - store: other\n    path: {}\n", yaml_quote(root)));
    }
  }

  fs::write(config_dir.join("config.yaml"), yaml)
    .map_err(|e| format!("Failed to write Ludusavi config: {e}"))
}

fn yaml_quote(value: &str) -> String {
  format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

// ── Temp paths ───────────────────────────────────────────────────────────────

fn temp_token(tag: &str) -> String {
  static COUNTER: AtomicU64 = AtomicU64::new(0);
  let nanos = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  let n = COUNTER.fetch_add(1, Ordering::Relaxed);
  format!("gamevault-savesync-{tag}-{}-{nanos}-{n}", std::process::id())
}

fn unique_temp_dir(tag: &str) -> Result<PathBuf, String> {
  let dir = std::env::temp_dir().join(temp_token(tag));
  fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp dir: {e}"))?;
  Ok(dir)
}

// ── Ludusavi invocation ──────────────────────────────────────────────────────

fn run_ludusavi(config_dir: &Path, args: &[&str]) -> Result<(bool, String), String> {
  let bin = resolve_ludusavi()?;
  let output = Command::new(&bin)
    .arg("--config")
    .arg(config_dir)
    .arg("--try-manifest-update")
    .args(args)
    .output()
    .map_err(|e| format!("Failed to run Ludusavi: {e}"))?;

  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).to_string();
  Ok((
    output.status.success(),
    if stdout.trim().is_empty() { stderr } else { stdout },
  ))
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeResult {
  pub recognized: bool,
  pub canonical_name: Option<String>,
}

/// Ask Ludusavi whether it knows this game (drives the "Cloud Saves" indicator)
/// and, if so, the canonical manifest name to use for backup/restore.
#[tauri::command]
pub(crate) async fn savefile_probe(app: AppHandle, title: String) -> Result<ProbeResult, String> {
  let title = title.trim().to_string();
  if title.is_empty() {
    return Ok(ProbeResult { recognized: false, canonical_name: None });
  }

  let config_dir = ludusavi_config_dir(&app)?;
  write_ludusavi_config(&config_dir, &config_dir.join("backups"), &[])?;

  // `find` exits non-zero when there's no match but still prints JSON, so parse
  // stdout regardless of the exit status.
  let (_ok, out) = run_ludusavi(
    &config_dir,
    &["find", "--api", "--normalized", "--backup", &title],
  )?;
  let json: serde_json::Value = serde_json::from_str(out.trim())
    .map_err(|e| format!("Could not parse Ludusavi output: {e}\n{out}"))?;

  let canonical_name = json
    .get("games")
    .and_then(|g| g.as_object())
    .and_then(|g| g.keys().next().cloned());

  Ok(ProbeResult {
    recognized: canonical_name.is_some(),
    canonical_name,
  })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupResult {
  /// Path to the produced zip in the OS temp dir. Empty when `files == 0`.
  /// The caller reads it and then deletes it (`fs_remove`).
  pub zip_path: String,
  pub files: u64,
  pub bytes: u64,
}

/// Back up `canonical_name`'s saves into a single zip. Returns `files: 0` when
/// Ludusavi found nothing to back up (caller should skip the upload).
#[tauri::command]
pub(crate) async fn savefile_backup(
  app: AppHandle,
  canonical_name: String,
  library_roots: Vec<String>,
) -> Result<BackupResult, String> {
  let config_dir = ludusavi_config_dir(&app)?;
  let work = unique_temp_dir("backup")?;
  write_ludusavi_config(&config_dir, &work, &library_roots)?;

  let result = (|| {
    let (ok, out) = run_ludusavi(
      &config_dir,
      &[
        "backup",
        "--api",
        "--force",
        "--format",
        "simple",
        "--path",
        &work.to_string_lossy(),
        &canonical_name,
      ],
    )?;

    let json: serde_json::Value = serde_json::from_str(out.trim())
      .map_err(|e| format!("Could not parse Ludusavi backup output: {e}\n{out}"))?;
    if !ok && json.get("overall").is_none() {
      return Err(format!("Ludusavi backup failed: {out}"));
    }

    let (files, bytes) = count_files(&json, &canonical_name);
    if files == 0 {
      return Ok(BackupResult { zip_path: String::new(), files: 0, bytes: 0 });
    }

    let zip_path = std::env::temp_dir().join(format!("{}.zip", temp_token("upload")));
    zip_dir(&work, &zip_path)?;
    Ok(BackupResult {
      zip_path: zip_path.to_string_lossy().to_string(),
      files,
      bytes,
    })
  })();

  let _ = fs::remove_dir_all(&work);
  result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreResult {
  pub restored_files: u64,
}

/// Restore `canonical_name`'s saves from a zip previously produced by
/// `savefile_backup` (downloaded from the server by the caller).
#[tauri::command]
pub(crate) async fn savefile_restore(
  app: AppHandle,
  canonical_name: String,
  zip_bytes: Vec<u8>,
) -> Result<RestoreResult, String> {
  let config_dir = ludusavi_config_dir(&app)?;
  let work = unique_temp_dir("restore")?;
  write_ludusavi_config(&config_dir, &work, &[])?;

  let result = (|| {
    unzip_bytes(&zip_bytes, &work)?;

    let (ok, out) = run_ludusavi(
      &config_dir,
      &[
        "restore",
        "--api",
        "--force",
        "--path",
        &work.to_string_lossy(),
        &canonical_name,
      ],
    )?;

    let json: serde_json::Value = serde_json::from_str(out.trim())
      .map_err(|e| format!("Could not parse Ludusavi restore output: {e}\n{out}"))?;
    if !ok && json.get("overall").is_none() {
      return Err(format!("Ludusavi restore failed: {out}"));
    }

    let (restored_files, _) = count_files(&json, &canonical_name);
    Ok(RestoreResult { restored_files })
  })();

  let _ = fs::remove_dir_all(&work);
  result
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Sum the per-file entries Ludusavi reports for `name` in its `--api` output.
fn count_files(json: &serde_json::Value, name: &str) -> (u64, u64) {
  let Some(files) = json
    .get("games")
    .and_then(|g| g.get(name))
    .and_then(|g| g.get("files"))
    .and_then(|f| f.as_object())
  else {
    // Fall back to the overall summary.
    let bytes = json
      .get("overall")
      .and_then(|o| o.get("processedBytes"))
      .and_then(|b| b.as_u64())
      .unwrap_or(0);
    let processed = json
      .get("overall")
      .and_then(|o| o.get("processedGames"))
      .and_then(|g| g.as_u64())
      .unwrap_or(0);
    return (if bytes > 0 { processed.max(1) } else { 0 }, bytes);
  };

  let count = files.len() as u64;
  let bytes = files
    .values()
    .filter_map(|f| f.get("bytes").and_then(|b| b.as_u64()))
    .sum();
  (count, bytes)
}

/// Recursively zip `src_dir`'s contents (entries are stored relative to it).
fn zip_dir(src_dir: &Path, zip_path: &Path) -> Result<(), String> {
  let file = fs::File::create(zip_path)
    .map_err(|e| format!("Failed to create zip: {e}"))?;
  let mut writer = zip::ZipWriter::new(file);
  let options = zip::write::SimpleFileOptions::default()
    .compression_method(zip::CompressionMethod::Deflated);

  let mut stack = vec![src_dir.to_path_buf()];
  while let Some(dir) = stack.pop() {
    for entry in fs::read_dir(&dir).map_err(|e| format!("Failed to read {}: {e}", dir.display()))? {
      let entry = entry.map_err(|e| format!("Failed to read dir entry: {e}"))?;
      let path = entry.path();
      let rel = path
        .strip_prefix(src_dir)
        .map_err(|e| format!("Failed to compute relative path: {e}"))?
        .to_string_lossy()
        .replace('\\', "/");
      if rel.is_empty() {
        continue;
      }

      if path.is_dir() {
        writer
          .add_directory(format!("{rel}/"), options)
          .map_err(|e| format!("Failed to add dir to zip: {e}"))?;
        stack.push(path);
      } else {
        writer
          .start_file(rel, options)
          .map_err(|e| format!("Failed to add file to zip: {e}"))?;
        let mut f = fs::File::open(&path)
          .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
          .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        writer
          .write_all(&buf)
          .map_err(|e| format!("Failed to write zip entry: {e}"))?;
      }
    }
  }

  writer.finish().map_err(|e| format!("Failed to finalize zip: {e}"))?;
  Ok(())
}

fn unzip_bytes(bytes: &[u8], dest_dir: &Path) -> Result<(), String> {
  let reader = std::io::Cursor::new(bytes);
  let mut archive = zip::ZipArchive::new(reader)
    .map_err(|e| format!("Invalid savefile zip: {e}"))?;
  archive
    .extract(dest_dir)
    .map_err(|e| format!("Failed to extract savefile zip: {e}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::{count_files, yaml_quote};
  use serde_json::json;

  #[test]
  fn counts_per_file_entries() {
    let output = json!({
      "overall": { "processedGames": 1, "processedBytes": 25 },
      "games": {
        "My Game": {
          "files": {
            "/saves/a.dat": { "bytes": 19 },
            "/saves/b.dat": { "bytes": 6 }
          }
        }
      }
    });
    assert_eq!(count_files(&output, "My Game"), (2, 25));
  }

  #[test]
  fn reports_zero_when_nothing_processed() {
    let output = json!({
      "overall": { "processedGames": 0, "processedBytes": 0 },
      "games": {}
    });
    assert_eq!(count_files(&output, "My Game"), (0, 0));
  }

  #[test]
  fn parses_find_games_map() {
    let output = json!({ "games": { "Stardew Valley": { "score": 1.0 } } });
    let name = output
      .get("games")
      .and_then(|g| g.as_object())
      .and_then(|g| g.keys().next().cloned());
    assert_eq!(name.as_deref(), Some("Stardew Valley"));
  }

  #[test]
  fn quotes_windows_paths_for_yaml() {
    assert_eq!(yaml_quote(r"C:\Games\GameVault"), r#""C:\\Games\\GameVault""#);
  }
}
