use std::ffi::OsString;

use clap::Parser;

pub mod cli;
pub mod commands;
pub mod error;
pub mod output;

use cli::AppCli;
use error::AppError;

pub async fn run_with_args<I, T>(args: I) -> Result<(), AppError>
where
    I: IntoIterator<Item = T>,
    T: Into<OsString> + Clone,
{
    let cli = AppCli::try_parse_from(args).map_err(AppError::from_clap)?;
    commands::execute(cli).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dispatches_known_command_tree() {
        let result = run_with_args(["dt", "auth", "status"])
            .await
            .expect_err("auth status is scaffold-only and should return not implemented");

        assert_eq!(result.code().as_str(), "not_implemented");
    }

    #[tokio::test]
    async fn invalid_subcommand_returns_argument_error() {
        let result = run_with_args(["dt", "nope"])
            .await
            .expect_err("invalid subcommand should fail");

        assert_eq!(result.code().as_str(), "invalid_arguments");
        assert!(result.message().contains("unrecognized subcommand"));
        assert_eq!(result.exit_code(), 2);
    }
}
