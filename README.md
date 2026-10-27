# Format

Aplikacja desktopowa (Tauri 2) do konwersji JPG i PNG na WebP. Przeciągasz pliki albo foldery, klikasz "Rozpocznij", a pliki `.webp` zapisują się obok oryginałów.

## Uruchomienie

Wymagania: [Rust](https://rustup.rs) 1.90 lub nowszy, Node.js 18 lub nowszy oraz [zależności Tauri dla Twojego systemu](https://tauri.app/start/prerequisites/).

```bash
npm install
npm run dev        # tryb deweloperski z odświeżaniem
npm run build      # instalator w src-tauri/target/release/bundle
```

Testy rdzenia konwersji (bez okna, bez Tauri):

```bash
cd src-tauri && cargo test --lib
```

## Jak to działa

| Zachowanie | Szczegóły |
|---|---|
| Zapis | `nazwa.webp` w folderze oryginału. Gdy plik istnieje: `nazwa-1.webp`, `nazwa-2.webp`. Nigdy nie nadpisuje, nigdy nie usuwa oryginałów |
| Jakość | Suwak 1 do 100 (domyślnie 80), zapamiętywany między uruchomieniami |
| PNG | Opcja "Bezstratnie dla PNG". Przezroczystość zawsze zostaje zachowana |
| Foldery | Upuszczony folder jest przeszukiwany rekurencyjnie, ukryte pliki są pomijane |
| Orientacja | Obrót z EXIF jest uwzględniany (zdjęcia z telefonu nie lądują bokiem) |
| Metadane | EXIF i profile nie trafiają do WebP (mniejszy plik, prywatność) |
| Błędy | Uszkodzony plik albo brak uprawnień zatrzymuje tylko ten plik. Reszta się konwertuje, a "Spróbuj ponownie" ponawia nieudane |
| Anulowanie | Kończy bieżący plik i zatrzymuje kolejkę. Gotowe pliki zostają |

## Struktura

```
src/                   interfejs (czysty HTML, CSS i JS, bez bundlera)
  index.html
  styles.css           tokeny z Paper + komponenty
  app.js               stany: empty, queue, running, done
  fonts/               Inter (latin i latin-ext), działa offline
src-tauri/
  src/convert.rs       rdzeń: wykrywanie plików, nazwy, kodowanie WebP, testy
  src/lib.rs           polecenia Tauri: inspect_paths, convert_file
  tauri.conf.json      okno 880 x 660, CSP, ikony
  capabilities/        uprawnienia: zdarzenia okna, dialog, opener
icon-source.png        ikona 1024 px (źródło dla `npm run icons`)
```

## Projekt a kod

Ekrany z Paper (plik "format") mają odzwierciedlenie w stanach interfejsu:

| Ekran w Paper | Stan w aplikacji |
|---|---|
| 1 Pusty, 5 Przeciąganie | `data-state="empty"` plus klasa `.is-dragging` |
| 2 Kolejka | `queue` |
| 3 W trakcie | `running` (pasek 60 segmentów) |
| 4 Gotowe | `done` bez błędów (karta z oszczędnością) |
| 6 Błąd | `done` z co najmniej jednym błędem |

Tokeny w `styles.css` mają te same nazwy co w Paper. Zmieniasz kolor w Paper, przepisujesz wartość tokenu i gotowe. W komponentach nie ma kolorów ani odstępów wpisanych wprost.

## Instalatory na wszystkie systemy

Workflow `.github/workflows/release.yml` buduje macOS (Apple Silicon i Intel), Windows i Linux po wypchnięciu tagu `v*`. Bez podpisu kodu macOS i Windows pokażą ostrzeżenie przy pierwszym uruchomieniu. Do dystrybucji publicznej potrzebujesz certyfikatu Apple Developer i (opcjonalnie) certyfikatu podpisującego dla Windows.

## Znane ograniczenia i pomysły

- Miniatury w liście to kolorowe placeholdery. Prawdziwe miniatury wymagają włączenia protokołu `asset` albo generowania zmniejszonych podglądów w Rust.
- Wybór plików przez okno dialogowe nie wybiera folderów (foldery działają przez przeciąganie).
- Brak ciemnego motywu (nie ma go w projekcie).
- Konwersja idzie plik po pliku. Dla bardzo dużych paczek warto dodać równoległość (`rayon`), pamiętając o limicie pamięci przy dużych zdjęciach.
