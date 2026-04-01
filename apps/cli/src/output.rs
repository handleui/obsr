use serde::Serialize;

use crate::auth::{AuthStatus, LoginResult, LogoutResult};
use crate::error::{AppError, ErrorCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Human,
    Json,
}

#[derive(Debug, Serialize)]
pub struct StubOutput<'a> {
    pub status: &'static str,
    pub command: &'a str,
    pub message: &'a str,
}

pub fn print_stub(command: &str, message: &str, mode: OutputMode) {
    let payload = StubOutput {
        status: "ok",
        command,
        message,
    };

    match mode {
        OutputMode::Human => {
            println!("{}", payload.message);
        }
        OutputMode::Json => {
            println!(
                "{}",
                serde_json::to_string(&payload).expect("stub payload should serialize")
            );
        }
    }
}

pub fn print_error(error: &AppError) {
    match error.code() {
        ErrorCode::Display => {
            print!("{}", error.message());
        }
        _ => {
            eprintln!("[{}] {}", error.code().as_str(), error.message());
        }
    }
}

pub fn print_json<T>(value: &T)
where
    T: Serialize,
{
    println!(
        "{}",
        serde_json::to_string(value).expect("output payload should serialize")
    );
}

fn print_json_stderr<T>(value: &T)
where
    T: Serialize,
{
    eprintln!(
        "{}",
        serde_json::to_string(value).expect("output payload should serialize")
    );
}

#[derive(Debug, Serialize)]
struct SettingsEntry<'a> {
    key: &'a str,
    value: &'a str,
}

pub fn print_settings_get(key: &str, value: &str, mode: OutputMode) {
    match mode {
        OutputMode::Human => println!("{key}={value}"),
        OutputMode::Json => print_json(&serde_json::json!({
            "status": "ok",
            "key": key,
            "value": value,
        })),
    }
}

pub fn print_settings_set(key: &str, value: &str, mode: OutputMode) {
    match mode {
        OutputMode::Human => println!("Set {key}={value}"),
        OutputMode::Json => print_json(&serde_json::json!({
            "status": "ok",
            "key": key,
            "value": value,
        })),
    }
}

pub fn print_settings_list(entries: &[(&str, &str)], mode: OutputMode) {
    match mode {
        OutputMode::Human => {
            if entries.is_empty() {
                println!("No settings configured.");
                return;
            }
            for (key, value) in entries {
                println!("{key}={value}");
            }
        }
        OutputMode::Json => {
            let payload = entries
                .iter()
                .map(|(key, value)| SettingsEntry { key, value })
                .collect::<Vec<_>>();
            print_json(&serde_json::json!({
                "status": "ok",
                "settings": payload,
            }));
        }
    }
}

pub fn print_auth_login(result: &LoginResult, mode: OutputMode) {
    match mode {
        OutputMode::Human => {
            let display_name = match (&result.me.first_name, &result.me.last_name) {
                (Some(first), Some(last)) => format!("{first} {last}"),
                (Some(first), None) => first.clone(),
                _ => result.me.email.clone(),
            };
            println!("Logged in as {display_name} <{}>", result.me.email);
        }
        OutputMode::Json => {
            print_json(&serde_json::json!({
                "event": "authenticated",
                "status": "authenticated",
                "api_url": result.api_url,
                "verification_uri": result.device.verification_uri,
                "verification_uri_complete": result.device.verification_uri_complete,
                "user_code": result.device.user_code,
                "expires_at": result.credentials.expires_at,
                "user": result.me,
            }));
        }
    }
}

pub fn print_auth_login_prompt(
    device: &crate::auth::DeviceAuthorizationResponse,
    mode: OutputMode,
) {
    match mode {
        OutputMode::Human => {
            println!("Open this URL to approve Observer CLI:");
            println!("  {}", device.verification_uri_complete);
            println!();
            println!("Or enter code: {}", device.user_code);
            println!();
            println!("Waiting for approval...");
        }
        OutputMode::Json => {
            print_json_stderr(&serde_json::json!({
                "event": "device_authorization",
                "verification_uri": device.verification_uri,
                "verification_uri_complete": device.verification_uri_complete,
                "user_code": device.user_code,
                "expires_in": device.expires_in,
                "interval": device.interval,
            }));
        }
    }
}

pub fn print_auth_logout(result: &LogoutResult, mode: OutputMode) {
    match mode {
        OutputMode::Human => {
            if result.cleared {
                println!("Successfully logged out.");
            } else {
                println!("Not currently logged in.");
            }
        }
        OutputMode::Json => {
            print_json(&serde_json::json!({
                "status": if result.cleared { "logged_out" } else { "unauthenticated" },
                "api_url": result.api_url,
                "cleared": result.cleared,
            }));
        }
    }
}

pub fn print_auth_status(status: &AuthStatus, mode: OutputMode) {
    match mode {
        OutputMode::Human => match status {
            AuthStatus::Unauthenticated { api_url } => {
                println!("Not logged in.");
                println!("Observer: {api_url}");
            }
            AuthStatus::Expired {
                api_url,
                expires_at,
            } => {
                println!("Session expired.");
                println!("Expires at: {}", format_timestamp(*expires_at));
                println!("Observer: {api_url}");
            }
            AuthStatus::Authenticated {
                api_url,
                expires_at,
                me,
            } => {
                let display_name = match (&me.first_name, &me.last_name) {
                    (Some(first), Some(last)) => format!("{first} {last}"),
                    (Some(first), None) => first.clone(),
                    _ => me.email.clone(),
                };
                println!("Authenticated as {display_name} <{}>", me.email);
                println!("User ID: {}", me.user_id);
                println!("Expires at: {}", format_timestamp(*expires_at));
                println!("Observer: {api_url}");
            }
        },
        OutputMode::Json => print_json(status),
    }
}

fn format_timestamp(timestamp_ms: u64) -> String {
    let seconds = timestamp_ms / 1000;
    format!("{seconds}s since UNIX epoch")
}
