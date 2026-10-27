mod convert;

use convert::{ConvertResult, FileInfo};
use std::path::PathBuf;

/// Rozwija upuszczone ścieżki (pliki i foldery) do listy obsługiwanych obrazów.
#[tauri::command]
async fn inspect_paths(paths: Vec<String>) -> Result<Vec<FileInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || convert::collect(&paths))
        .await
        .map_err(|e| e.to_string())
}

/// Konwertuje jeden plik do WebP i zapisuje go obok oryginału.
/// Frontend wywołuje to po kolei dla każdego pliku, dzięki czemu pasek postępu jest prawdziwy.
#[tauri::command]
async fn convert_file(path: String, quality: f32, lossless: bool) -> Result<ConvertResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        convert::convert(&PathBuf::from(path), quality, lossless)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![inspect_paths, convert_file])
        .run(tauri::generate_context!())
        .expect("błąd podczas uruchamiania aplikacji Format");
}
