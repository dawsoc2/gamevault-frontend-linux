use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Tokens extracted from the identity provider's redirect back to the
/// server after a successful SSO login.
#[derive(Clone, serde::Serialize)]
pub(crate) struct OAuthTokens {
  access_token: String,
  refresh_token: Option<String>,
}

/// Looks for `access_token`/`refresh_token` in a URL's query string or
/// fragment. Mirrors the parsing the web build does client-side in
/// Login.tsx, since the server redirects to the same shapes either way.
fn extract_tokens(url: &tauri::Url) -> Option<OAuthTokens> {
  let mut access = None;
  let mut refresh = None;

  for (key, value) in url.query_pairs() {
    match key.as_ref() {
      "access_token" => access = Some(value.into_owned()),
      "refresh_token" => refresh = Some(value.into_owned()),
      _ => {}
    }
  }

  if access.is_none() {
    if let Some(fragment) = url.fragment() {
      for (key, value) in url::form_urlencoded::parse(fragment.as_bytes()) {
        match key.as_ref() {
          "access_token" => access = Some(value.into_owned()),
          "refresh_token" => refresh = Some(value.into_owned()),
          _ => {}
        }
      }
    }
  }

  access.map(|access_token| OAuthTokens {
    access_token,
    refresh_token: refresh,
  })
}

/// Runs the SSO login flow in a separate window instead of navigating the
/// main window there. The main window's Tauri capabilities (dialog, fs) are
/// scoped to local app content; navigating it to the remote server's own
/// site would permanently strand it without those permissions for the rest
/// of the session. The popup gets no capability grants at all (it isn't
/// listed in any capability's "windows"), so it can never invoke dialog/fs
/// regardless of what content it displays.
///
/// This command MUST stay `async`. Tauri runs sync commands inline on the
/// main thread, and building a `WebviewWindow` from the main thread
/// deadlocks on Windows and Linux: `.build()` blocks waiting for the
/// webview's controller to initialize, but that init is driven by the very
/// event loop the blocked thread would otherwise be pumping. An `async`
/// command is spawned off the main thread, so `.build()` can dispatch the
/// creation to a free event loop and wait on it safely. (WebKitGTK happened
/// to tolerate the sync version, so this only surfaced once we built for
/// Windows / WebView2.)
#[tauri::command]
pub(crate) async fn oauth2_login(app: tauri::AppHandle, server: String) -> Result<(), String> {
  if let Some(existing) = app.get_webview_window("oauth") {
    let _ = existing.set_focus();
    return Ok(());
  }

  let login_url: tauri::Url = format!("{}/api/auth/oauth2/login", server.trim_end_matches('/'))
    .parse()
    .map_err(|e| format!("invalid server url: {e}"))?;

  let app_handle = app.clone();
  WebviewWindowBuilder::new(&app, "oauth", WebviewUrl::External(login_url))
    .title("Sign in")
    .inner_size(480.0, 720.0)
    .on_navigation(move |url| {
      if let Some(tokens) = extract_tokens(url) {
        let _ = app_handle.emit("oauth2-callback", tokens);
        // Close off the event loop, not from inside this navigation
        // callback: the callback runs on the main (UI) thread on Windows,
        // and closing the window synchronously from here re-enters the
        // event loop while it is mid-dispatch. Spawning hands the close to
        // a free turn of the loop once this handler returns.
        let close_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
          if let Some(window) = close_handle.get_webview_window("oauth") {
            let _ = window.close();
          }
        });
        return false;
      }
      true
    })
    .build()
    .map_err(|e| e.to_string())?;

  Ok(())
}
