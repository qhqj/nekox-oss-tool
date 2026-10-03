fn main() {
  tauri_build::build();
  // Tauri's normal executable receives a Common Controls v6 manifest; Cargo
  // integration-test executables do not inherit that Windows resource.
  if cfg!(target_os = "windows") && std::env::var_os("CARGO_FEATURE_DESKTOP_INTEGRATION").is_some() {
    println!("cargo:rerun-if-changed=../tests/desktop/windows.manifest");
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
      .join("../tests/desktop/windows.manifest").canonicalize().unwrap();
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
  }
}
