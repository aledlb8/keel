fn main() {
    // tauri-build embeds icons/icon.ico into the exe's resources but only asks
    // to rerun when tauri.conf.json or capabilities change, so a new icon would
    // otherwise keep shipping the old one baked into the binary.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
