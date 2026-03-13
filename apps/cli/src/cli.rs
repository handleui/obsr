use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Clone, Parser)]
#[command(name = "dt", about = "Detent CLI v1 Rust scaffold")]
pub struct AppCli {
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Command {
    Auth(AuthCommand),
    Observe(ObserveCommand),
    Settings(SettingsCommand),
    Install(InstallCommand),
}

#[derive(Debug, Clone, Args)]
pub struct AuthCommand {
    #[command(subcommand)]
    pub command: AuthSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum AuthSubcommand {
    Login(AuthLoginArgs),
    Logout(AuthLogoutArgs),
    Status(AuthStatusArgs),
}

#[derive(Debug, Clone, Args)]
pub struct AuthLoginArgs {
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub headless: bool,
    #[arg(long)]
    pub force: bool,
}

#[derive(Debug, Clone, Args)]
pub struct AuthLogoutArgs {
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct AuthStatusArgs {
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct ObserveCommand {
    #[arg(long)]
    pub owner: Option<String>,
    #[arg(long)]
    pub repo: Option<String>,
    #[arg(long = "repo-full")]
    pub repo_full: Option<String>,
    #[arg(long)]
    pub project: Option<String>,
    #[arg(long)]
    pub pr: Option<u64>,
    #[arg(long)]
    pub branch: Option<String>,
    #[arg(long)]
    pub run: Option<String>,
    #[arg(long)]
    pub commit: Option<String>,
    #[arg(long)]
    pub watch: bool,
    #[arg(long)]
    pub json: bool,
    #[arg(long)]
    pub ndjson: bool,
    #[arg(long)]
    pub since: Option<String>,
    #[arg(long)]
    pub limit: Option<u32>,
    #[arg(long)]
    pub follow: bool,
    #[arg(long = "poll-interval")]
    pub poll_interval: Option<u64>,
    #[arg(long = "exit-on-idle")]
    pub exit_on_idle: bool,
    #[arg(long = "exit-on-first-entry")]
    pub exit_on_first_entry: bool,
    #[arg(long, value_enum, default_value_t = ObserveType::All)]
    pub r#type: ObserveType,
    #[arg(long, value_enum, default_value_t = ObserveSource::All)]
    pub source: ObserveSource,
    #[arg(long, value_enum, default_value_t = ObserveSeverity::All)]
    pub severity: ObserveSeverity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Default)]
pub enum ObserveType {
    Ci,
    Review,
    #[default]
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Default)]
pub enum ObserveSource {
    Ci,
    PrComment,
    #[default]
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Default)]
pub enum ObserveSeverity {
    Error,
    Warning,
    #[default]
    All,
}

#[derive(Debug, Clone, Args)]
pub struct SettingsCommand {
    #[command(subcommand)]
    pub command: SettingsSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum SettingsSubcommand {
    Get(SettingsGetArgs),
    Set(SettingsSetArgs),
    List(SettingsListArgs),
    Edit(SettingsEditArgs),
}

#[derive(Debug, Clone, Args)]
pub struct SettingsGetArgs {
    pub key: String,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct SettingsSetArgs {
    pub key: String,
    pub value: String,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct SettingsListArgs {
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct SettingsEditArgs {
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct InstallCommand {
    #[command(subcommand)]
    pub command: Option<InstallSubcommand>,
    #[arg(long)]
    pub owner: Option<String>,
    #[arg(long)]
    pub repo: Option<String>,
    #[arg(long)]
    pub json: bool,
}

#[derive(Debug, Clone, Subcommand)]
pub enum InstallSubcommand {
    Status(InstallStatusArgs),
}

#[derive(Debug, Clone, Args)]
pub struct InstallStatusArgs {
    #[arg(long)]
    pub owner: Option<String>,
    #[arg(long)]
    pub repo: Option<String>,
    #[arg(long)]
    pub json: bool,
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::{AppCli, Command, SettingsSubcommand};

    #[test]
    fn parses_auth_status() {
        let parsed = AppCli::try_parse_from(["dt", "auth", "status"]).expect("should parse");

        assert!(matches!(parsed.command, Command::Auth(_)));
    }

    #[test]
    fn parses_observe_with_machine_flags() {
        let parsed = AppCli::try_parse_from([
            "dt",
            "observe",
            "--watch",
            "--ndjson",
            "--repo-full",
            "detent/repo",
        ])
        .expect("should parse");

        assert!(matches!(parsed.command, Command::Observe(_)));
    }

    #[test]
    fn parses_settings_edit() {
        let parsed = AppCli::try_parse_from(["dt", "settings", "edit"]).expect("should parse");

        match parsed.command {
            Command::Settings(settings) => {
                assert!(matches!(settings.command, SettingsSubcommand::Edit(_)));
            }
            _ => panic!("expected settings command"),
        }
    }

    #[test]
    fn rejects_unknown_subcommand() {
        let error = AppCli::try_parse_from(["dt", "unknown"]).expect_err("should fail");

        assert_eq!(error.kind(), clap::error::ErrorKind::InvalidSubcommand);
        assert!(error.to_string().contains("unrecognized subcommand"));
    }
}
