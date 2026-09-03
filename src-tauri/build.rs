fn main() {
  // Expose the compile target triple at runtime so we can locate the Ludusavi
  // sidecar during `tauri dev`, where Tauri keeps the `-<triple>` suffix on
  // external binaries instead of stripping it like it does for bundles.
  println!(
    "cargo:rustc-env=GV_TARGET_TRIPLE={}",
    std::env::var("TARGET").unwrap_or_default()
  );

  tauri_build::build()
}
