//! Rdzeń konwersji: wykrywanie plików, wybór nazwy wyjściowej i kodowanie do WebP.
//! Nie zależy od Tauri, więc da się go testować osobno (`cargo test`).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageDecoder, ImageReader};
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    /// Ostatnie dwa człony folderu, np. "Klient A / Grafiki" (do wyświetlenia w liście).
    pub folder: String,
    /// "JPG" albo "PNG".
    pub format: String,
    pub size: u64,
}

#[derive(Serialize, Debug)]
pub struct ConvertResult {
    pub output: String,
    pub before: u64,
    pub after: u64,
}

/// Zwraca "JPG" / "PNG" dla obsługiwanych rozszerzeń.
fn format_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some("JPG"),
        "png" => Some("PNG"),
        _ => None,
    }
}

fn folder_label(path: &Path) -> String {
    let parts: Vec<String> = path
        .parent()
        .map(|p| {
            p.components()
                .filter_map(|c| match c {
                    std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let start = parts.len().saturating_sub(2);
    parts[start..].join(" / ")
}

fn info_for(path: &Path) -> Option<FileInfo> {
    let format = format_of(path)?;
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    Some(FileInfo {
        path: path.to_string_lossy().to_string(),
        name: path.file_name()?.to_string_lossy().to_string(),
        folder: folder_label(path),
        format: format.to_string(),
        size: meta.len(),
    })
}

fn walk(dir: &Path, out: &mut Vec<FileInfo>, depth: usize) {
    // Zabezpieczenie przed zbyt głęboką rekurencją (np. pętle dowiązań).
    if depth > 32 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let p = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if p.is_dir() {
            walk(&p, out, depth + 1);
        } else if let Some(info) = info_for(&p) {
            out.push(info);
        }
    }
}

/// Rozwija listę ścieżek (pliki i foldery) do listy obsługiwanych obrazów.
pub fn collect(paths: &[String]) -> Vec<FileInfo> {
    let mut out = Vec::new();
    for raw in paths {
        let p = Path::new(raw);
        if p.is_dir() {
            walk(p, &mut out, 0);
        } else if let Some(info) = info_for(p) {
            out.push(info);
        }
    }
    out
}

/// Zapisuje bajty obok oryginału jako `nazwa.webp`. Gdy plik istnieje: `nazwa-1.webp`, `nazwa-2.webp`...
/// Nigdy nie nadpisuje istniejących plików (`create_new`).
fn write_unique(src: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = src.parent().unwrap_or_else(|| Path::new("."));
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("Nieprawidłowa nazwa pliku")?;
    for n in 0..1000u32 {
        let name = if n == 0 {
            format!("{stem}.webp")
        } else {
            format!("{stem}-{n}.webp")
        };
        let candidate = dir.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(mut f) => {
                f.write_all(bytes).map_err(|e| format!("Błąd zapisu: {e}"))?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(format!(
                    "Brak uprawnień do zapisu w folderze {}",
                    dir.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
                ));
            }
            Err(e) => return Err(format!("Nie można utworzyć pliku: {e}")),
        }
    }
    Err("Zbyt wiele plików o tej samej nazwie".into())
}

/// Konwertuje jeden plik. `quality` 1..=100. `lossless_png` dotyczy tylko plików PNG.
pub fn convert(src: &Path, quality: f32, lossless_png: bool) -> Result<ConvertResult, String> {
    let format = format_of(src).ok_or("Nieobsługiwany format pliku")?;
    let before = fs::metadata(src).map_err(|e| format!("Nie można odczytać pliku: {e}"))?.len();

    let reader = ImageReader::open(src)
        .map_err(|e| format!("Nie można otworzyć pliku: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Nie można rozpoznać formatu: {e}"))?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| format!("Uszkodzony lub nieobsługiwany obraz: {e}"))?;
    // Zachowaj orientację z EXIF (inaczej zdjęcia z telefonu lądują obrócone).
    let orientation = decoder.orientation().ok();
    let mut img = DynamicImage::from_decoder(decoder)
        .map_err(|e| format!("Uszkodzony lub nieobsługiwany obraz: {e}"))?;
    if let Some(o) = orientation {
        img.apply_orientation(o);
    }

    // Enkoder WebP przyjmuje tylko RGB8 / RGBA8.
    let prepared = if img.color().has_alpha() {
        DynamicImage::ImageRgba8(img.to_rgba8())
    } else {
        DynamicImage::ImageRgb8(img.to_rgb8())
    };
    let encoder = webp::Encoder::from_image(&prepared).map_err(|e| format!("Błąd kodowania: {e}"))?;
    let memory = if lossless_png && format == "PNG" {
        encoder.encode_lossless()
    } else {
        encoder.encode(quality.clamp(1.0, 100.0))
    };

    let out = write_unique(src, &memory)?;
    let after = memory.len() as u64;
    Ok(ConvertResult {
        output: out.to_string_lossy().to_string(),
        before,
        after,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb, Rgba};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("format-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn jpg_to_webp_next_to_original_without_overwrite() {
        let d = tmp("jpg");
        let src = d.join("foto.jpg");
        let img: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_fn(400, 300, |x, y| Rgb([(x % 255) as u8, (y % 255) as u8, 128]));
        img.save(&src).unwrap();

        let r1 = convert(&src, 80.0, false).unwrap();
        assert!(r1.output.ends_with("foto.webp"));
        assert!(Path::new(&r1.output).exists());
        assert!(r1.after < r1.before);

        let r2 = convert(&src, 80.0, false).unwrap();
        assert!(r2.output.ends_with("foto-1.webp"), "got {}", r2.output);
        assert!(src.exists(), "oryginał musi zostać");
    }

    #[test]
    fn png_with_alpha_lossless_keeps_alpha() {
        let d = tmp("png");
        let src = d.join("logo.png");
        let img: ImageBuffer<Rgba<u8>, _> = ImageBuffer::from_fn(64, 64, |x, _| Rgba([200, 30, 30, if x < 32 { 255 } else { 0 }]));
        img.save(&src).unwrap();

        let r = convert(&src, 80.0, true).unwrap();
        let bytes = fs::read(&r.output).unwrap();
        let decoded = webp::Decoder::new(&bytes).decode().expect("poprawny WebP");
        assert!(decoded.is_alpha(), "kanał alfa musi zostać");
        let px = |x: usize, y: usize| decoded[(y * 64 + x) * 4 + 3];
        assert_eq!(px(5, 10), 255);
        assert_eq!(px(60, 10), 0);
    }

    #[test]
    fn collect_expands_folders_and_filters() {
        let d = tmp("collect");
        fs::create_dir_all(d.join("sub")).unwrap();
        let img: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_pixel(8, 8, Rgb([1, 2, 3]));
        img.save(d.join("a.png")).unwrap();
        img.save(d.join("sub").join("b.jpg")).unwrap();
        fs::write(d.join("notatka.txt"), "x").unwrap();
        fs::write(d.join("sub").join("c.webp"), "x").unwrap();

        let found = collect(&[d.to_string_lossy().to_string()]);
        let names: Vec<_> = found.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["a.png", "b.jpg"]);
        assert_eq!(found[1].format, "JPG");
    }

    #[test]
    fn broken_file_returns_readable_error() {
        let d = tmp("broken");
        let src = d.join("zepsuty.jpg");
        fs::write(&src, b"to nie jest obraz").unwrap();
        let err = convert(&src, 80.0, false).unwrap_err();
        assert!(err.contains("Uszkodzony") || err.contains("rozpoznać"), "got {err}");
    }
}
