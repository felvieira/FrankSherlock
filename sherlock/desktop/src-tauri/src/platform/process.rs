use std::path::PathBuf;

/// Build a `Command` that suppresses console-window creation on Windows.
///
/// On Windows, GUI applications that spawn child processes via `Command::new`
/// cause a visible console window to flash. The `CREATE_NO_WINDOW` flag
/// prevents this. On Linux/macOS this is a no-op wrapper around `Command::new`.
pub fn silent_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Find an executable by name on the system PATH.
///
/// Uses the `which` crate for cross-platform lookup
/// (handles PATHEXT on Windows automatically).
#[allow(dead_code)]
pub fn find_executable(name: &str) -> Option<PathBuf> {
    which::which(name).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_executable_known() {
        // Every OS has some basic executable we can test with
        #[cfg(target_os = "windows")]
        let name = "cmd";
        #[cfg(not(target_os = "windows"))]
        let name = "sh";

        let result = find_executable(name);
        assert!(result.is_some(), "should find '{name}' on PATH");
    }

    #[test]
    fn find_executable_nonexistent() {
        let result = find_executable("this_executable_does_not_exist_xyz123");
        assert!(result.is_none());
    }

    #[test]
    fn silent_command_creates_valid_command() {
        #[cfg(target_os = "windows")]
        let program = "cmd";
        #[cfg(not(target_os = "windows"))]
        let program = "echo";

        let cmd = silent_command(program);
        // Just verify it returns a valid Command that can be configured
        let _ = cmd;
    }
}
