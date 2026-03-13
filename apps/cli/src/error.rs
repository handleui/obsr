#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Display,
    InvalidArguments,
    NotImplemented,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Display => "display",
            Self::InvalidArguments => "invalid_arguments",
            Self::NotImplemented => "not_implemented",
            Self::Internal => "internal_error",
        }
    }
}

#[derive(Debug)]
pub struct AppError {
    code: ErrorCode,
    message: String,
    exit_code: u8,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>, exit_code: u8) -> Self {
        Self {
            code,
            message: message.into(),
            exit_code,
        }
    }

    pub fn from_clap(error: clap::Error) -> Self {
        let kind = error.kind();
        if matches!(
            kind,
            clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
        ) {
            return Self::new(ErrorCode::Display, error.to_string(), 0);
        }

        Self::new(ErrorCode::InvalidArguments, error.to_string(), 2)
    }

    pub fn not_implemented(operation: &str) -> Self {
        Self::new(
            ErrorCode::NotImplemented,
            format!("operation '{operation}' is not implemented in v1 scaffold"),
            3,
        )
    }

    pub fn code(&self) -> ErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn exit_code(&self) -> u8 {
        self.exit_code
    }
}
