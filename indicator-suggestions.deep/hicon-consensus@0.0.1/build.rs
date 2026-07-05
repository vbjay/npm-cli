fn main() {
  // Configuración de napi-rs
  napi_build::setup();
  
  // Establecer la versión mínima de macOS para la compilación
  // Esto ayuda a evitar problemas de compatibilidad
  #[cfg(target_os = "macos")]
  {
    println!("cargo:rustc-env=MACOSX_DEPLOYMENT_TARGET=11.0");
  }
}