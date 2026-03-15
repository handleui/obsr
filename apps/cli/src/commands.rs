use crate::cli::{
    AppCli, AuthSubcommand, Command, InstallSubcommand, ObserveCommand, SettingsSubcommand,
};
use crate::auth::AuthService;
use crate::config;
use crate::credentials::clear_credentials;
use crate::error::{AppError, ErrorCode};
use crate::output::{
    OutputMode, print_auth_login, print_auth_login_prompt, print_auth_logout, print_auth_status,
    print_stub,
};

pub async fn execute(cli: AppCli) -> Result<(), AppError> {
    match cli.command {
        Command::Auth(auth) => match auth.command {
            AuthSubcommand::Login(args) => {
                let mode = if args.json {
                    OutputMode::Json
                } else {
                    OutputMode::Human
                };
                let service = AuthService::new()?;
                let device = service.start_login(args.force).await?;
                print_auth_login_prompt(&device, mode);
                let result = service.complete_login(device).await?;
                print_auth_login(&result, mode);
                Ok(())
            }
            AuthSubcommand::Logout(args) => {
                let mode = if args.json {
                    OutputMode::Json
                } else {
                    OutputMode::Human
                };
                let result = match AuthService::new() {
                    Ok(service) => service.logout()?,
                    Err(error) if error.code() == ErrorCode::InvalidConfiguration => {
                        crate::auth::LogoutResult {
                            cleared: clear_credentials()?,
                            api_url: config::api_url(),
                        }
                    }
                    Err(error) => return Err(error),
                };
                print_auth_logout(&result, mode);
                Ok(())
            }
            AuthSubcommand::Status(args) => {
                let mode = if args.json {
                    OutputMode::Json
                } else {
                    OutputMode::Human
                };
                let service = AuthService::new()?;
                let result = service.status().await?;
                print_auth_status(&result, mode);
                Ok(())
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
