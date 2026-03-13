use serde::Serialize;

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
