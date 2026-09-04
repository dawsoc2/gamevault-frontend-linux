use std::env;

// Drop-in replacement for unrar_sys 0.5.8's build.rs, applied by
// `scripts/build-rc.sh` when cross-compiling the Windows RC from Linux.
//
// Upstream keys off `cfg!(windows)` / `#[cfg(windows)]`, which evaluate for the
// build *host*. Cross-compiling to Windows from Linux then (a) skips isnt.cpp,
// which defines WinNT() / IsWindows11OrGreater() -> undefined-symbol at link,
// and (b) links the wrong system libraries. This version keys off the
// CARGO_CFG_TARGET_* variables cargo sets for the *target*.

fn main() {
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let target_windows = target_os == "windows";

    if target_windows {
        println!("cargo:rustc-link-lib=powrprof");
        println!("cargo:rustc-link-lib=shell32");
        if target_env == "gnu" {
            println!("cargo:rustc-link-lib=pthread");
        }
    } else {
        println!("cargo:rustc-link-lib=pthread");
    }

    let mut files: Vec<String> = [
        "strlist", "strfn", "pathfn", "smallfn", "global", "file", "filefn",
        "filcreat", "archive", "arcread", "unicode", "system", "crypt", "crc",
        "rawread", "encname", "match", "timefn", "rdwrfn", "consio", "options",
        "errhnd", "rarvm", "secpassword", "rijndael", "getbits", "sha1",
        "sha256", "blake2s", "hash", "extinfo", "extract", "volume", "list",
        "find", "unpack", "headers", "threadpool", "rs16", "cmddata", "ui",
        "filestr", "scantree", "dll", "qopen",
    ]
    .iter()
    .map(|&s| format!("vendor/unrar/{s}.cpp"))
    .collect();

    if target_windows {
        files.push("vendor/unrar/isnt.cpp".to_string());
    }

    cc::Build::new()
        .cpp(true)
        .opt_level(2)
        .std("c++14")
        .cpp_link_stdlib(None)
        .warnings(false)
        .extra_warnings(false)
        .flag_if_supported("-stdlib=libc++")
        .flag_if_supported("-fPIC")
        .flag_if_supported("-Wno-switch")
        .flag_if_supported("-Wno-parentheses")
        .flag_if_supported("-Wno-macro-redefined")
        .flag_if_supported("-Wno-dangling-else")
        .flag_if_supported("-Wno-logical-op-parentheses")
        .flag_if_supported("-Wno-unused-parameter")
        .flag_if_supported("-Wno-unused-variable")
        .flag_if_supported("-Wno-unused-function")
        .flag_if_supported("-Wno-missing-braces")
        .flag_if_supported("-Wno-unknown-pragmas")
        .flag_if_supported("-Wno-deprecated-declarations")
        .define("_FILE_OFFSET_BITS", Some("64"))
        .define("_LARGEFILE_SOURCE", None)
        .define("RAR_SMP", None)
        .define("RARDLL", None)
        .files(&files)
        .compile("libunrar.a");
}
