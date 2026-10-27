// Ukrywa konsolę w wydaniu na Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    format_lib::run()
}
