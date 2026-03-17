pub mod client;
pub mod management;
pub mod model_selection;

pub const OLLAMA_BASE: &str = "http://localhost:11434";

pub use client::{ollama_generate, parse_json_response};
pub use management::{
    cleanup_loaded_models, list_installed_models, list_loaded_models, model_satisfies,
    DownloadState,
};
pub use model_selection::recommended_model;
