use crate::cli::{
    AppCli, AuthSubcommand, Command, InstallSubcommand, ObserveCommand, SettingsSubcommand,
};
use crate::error::AppError;
use crate::output::{OutputMode, print_stub};

pub async fn execute(cli: AppCli) -> Result<(), AppError> {
    match cli.command {
        Command::Auth(auth) => match auth.command {
            AuthSubcommand::Login(args) => {
                let _ = args;
                Err(AppError::not_implemented("auth login"))
            }
            AuthSubcommand::Logout(args) => {
                let _ = args;
                Err(AppError::not_implemented("auth logout"))
            }
            AuthSubcommand::Status(args) => {
                let _ = args;
                Err(AppError::not_implemented("auth status"))
            }
        },
        Command::Observe(args) => execute_observe(args),
        Command::Settings(settings) => match settings.command {
            SettingsSubcommand::Get(args) => {
                let _ = args;
                Err(AppError::not_implemented("settings get"))
            }
            SettingsSubcommand::Set(args) => {
                let _ = args;
                Err(AppError::not_implemented("settings set"))
            }
            SettingsSubcommand::List(args) => {
                let _ = args;
                Err(AppError::not_implemented("settings list"))
            }
            SettingsSubcommand::Edit(args) => {
                let _ = args;
                Err(AppError::not_implemented("settings edit"))
            }
        },
        Command::Install(install) => match install.command {
            Some(InstallSubcommand::Status(args)) => {
                let _ = args;
                Err(AppError::not_implemented("install status"))
            }
            None => {
                let mode = if install.json {
                    OutputMode::Json
                } else {
                    OutputMode::Human
                };
                print_stub(
                    "install",
                    "install command scaffold is ready; implementation pending",
                    mode,
                );
                Ok(())
            }
        },
    }
}

fn execute_observe(args: ObserveCommand) -> Result<(), AppError> {
    let _ = args;
    Err(AppError::not_implemented("observe"))
}
