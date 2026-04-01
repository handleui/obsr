use std::ffi::OsString;

use clap::Parser;

pub mod auth;
pub mod cli;
pub mod commands;
pub mod config;
pub mod credentials;
pub mod error;
pub mod observe;
pub mod output;
pub mod settings;

use cli::AppCli;
use error::AppError;

#[cfg(test)]
pub mod test_support {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    pub fn env_lock() -> MutexGuard<'static, ()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock should work")
    }
}

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
    use std::fs;

    use super::*;

    #[tokio::test]
    async fn dispatches_auth_status_command() {
        let temp_dir = std::env::temp_dir().join(format!(
            "dt-lib-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        fs::create_dir_all(&temp_dir).expect("temp dir should be created");
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));

        run_with_args(["dt", "auth", "status"])
            .await
            .expect("auth status should execute");
    }

    #[tokio::test]
    async fn settings_set_get_and_list_execute() {
        let temp_dir = std::env::temp_dir().join(format!(
            "dt-lib-test-settings-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time should work")
                .as_nanos()
        ));
        fs::create_dir_all(&temp_dir).expect("temp dir should be created");
        let _guard = EnvVarGuard::set("DETENT_HOME", Some(temp_dir.to_str().expect("utf8")));

        run_with_args(["dt", "settings", "set", "theme", "dark"])
            .await
            .expect("settings set should execute");
        run_with_args(["dt", "settings", "get", "theme"])
            .await
            .expect("settings get should execute");
        run_with_args(["dt", "settings", "list"])
            .await
            .expect("settings list should execute");
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

    struct EnvVarGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        key: &'static str,
        original: Option<String>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: Option<&str>) -> Self {
            let lock = crate::test_support::env_lock();
            let original = std::env::var(key).ok();
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
            Self {
                _lock: lock,
                key,
                original,
            }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => unsafe { std::env::set_var(self.key, value) },
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }
}
