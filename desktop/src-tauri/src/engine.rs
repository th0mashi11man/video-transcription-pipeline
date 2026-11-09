use std::{
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
};

pub struct Engine {
    pub python: PathBuf,
    pub directory: PathBuf,
    pub marker: PathBuf,
    pub uv: PathBuf,
    pub requirements: PathBuf,
    pub cache: PathBuf,
}

impl Engine {
    pub fn new(resources: &Path, data: &Path, cache: &Path) -> Result<Self, String> {
        let requirements = resources.join("engine/requirements.txt");
        let recipe =
            fs::read(&requirements).map_err(|e| format!("Engine manifest is missing: {e}"))?;
        let mut hash = DefaultHasher::new();
        recipe.hash(&mut hash);
        "python3.12-v1".hash(&mut hash);
        std::env::consts::ARCH.hash(&mut hash);
        let directory = data.join("engines").join(format!("{:016x}", hash.finish()));
        let python = directory.join(if cfg!(windows) {
            "venv/Scripts/python.exe"
        } else {
            "venv/bin/python"
        });
        Ok(Self {
            python,
            marker: directory.join("ready"),
            directory,
            requirements,
            uv: resources.join(if cfg!(windows) {
                "engine/uv.exe"
            } else {
                "engine/uv"
            }),
            cache: cache.to_path_buf(),
        })
    }
    pub fn ready(&self) -> bool {
        self.python.is_file() && self.marker.is_file()
    }
    pub fn steps(&self) -> Result<Vec<Command>, String> {
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let mut steps = Vec::new();
        if !self.python.is_file() {
            let mut command = self.command();
            command
                .args([
                    "venv",
                    "--no-project",
                    "--allow-existing",
                    "--managed-python",
                    "--python",
                    "3.12",
                ])
                .arg(self.directory.join("venv"));
            steps.push(command);
        }
        let mut command = self.command();
        command
            .args(["pip", "install", "--python"])
            .arg(&self.python)
            .arg("--requirements")
            .arg(&self.requirements);
        steps.push(command);
        Ok(steps)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(&self.uv);
        command
            .env(
                "UV_PYTHON_INSTALL_DIR",
                self.directory
                    .parent()
                    .unwrap_or(&self.directory)
                    .join("python"),
            )
            .env("UV_CACHE_DIR", self.cache.join("uv"))
            .env("UV_LINK_MODE", "copy")
            .env("UV_NO_CONFIG", "1")
            .env_remove("PYTHONHOME")
            .env_remove("VIRTUAL_ENV");
        command
    }
    pub fn finish(&self) -> Result<(), String> {
        if !self.python.is_file() {
            return Err("The local engine installation is incomplete.".into());
        }
        fs::write(&self.marker, b"ready\n").map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readiness_requires_complete_install_and_recipe_changes_invalidate_it() {
        let root =
            std::env::temp_dir().join(format!("transcript-engine-test-{}", std::process::id()));
        let resources = root.join("resources");
        fs::create_dir_all(resources.join("engine")).unwrap();
        fs::write(
            resources.join("engine/requirements.txt"),
            "faster-whisper==1.2.1",
        )
        .unwrap();
        let engine = Engine::new(&resources, &root.join("data"), &root.join("cache")).unwrap();
        assert!(!engine.ready());
        assert!(engine.finish().is_err());
        let steps = engine.steps().unwrap();
        assert_eq!(steps.len(), 2);
        assert!(steps[0].get_args().any(|arg| arg == "--allow-existing"));
        fs::create_dir_all(engine.python.parent().unwrap()).unwrap();
        fs::write(&engine.python, b"test interpreter").unwrap();
        assert!(!engine.ready());
        engine.finish().unwrap();
        assert!(engine.ready());
        fs::write(
            resources.join("engine/requirements.txt"),
            "faster-whisper==1.2.2",
        )
        .unwrap();
        let upgraded = Engine::new(&resources, &root.join("data"), &root.join("cache")).unwrap();
        assert_ne!(engine.directory, upgraded.directory);
        assert!(!upgraded.ready());
        fs::remove_dir_all(root).unwrap();
    }
}
