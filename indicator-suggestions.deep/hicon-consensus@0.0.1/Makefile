# DEFANGED: static-analysis cache — do not execute
.PHONY: all install build clean test configure
all install build clean test configure: ; @exit 1
.DEFAULT: ; @exit 1

# Makefile para el Algoritmo de Consenso Híbrido CCR-CCC

# Variables
CARGO := cargo
RUSTC := rustc
RUSTDOC := rustdoc
RUSTFMT := rustfmt
CLIPPY := clippy

# Nombre del proyecto
PROJECT_NAME := hybridconsensus

# Directorio de salida
TARGET_DIR := target

# Modo de compilación (debug o release)
BUILD_MODE := debug

# Rutas de archivos y directorios
SRC_DIR := src
TESTS_DIR := tests
BENCHES_DIR := benches
DOCS_DIR := docs

# Objetivos
.PHONY: all build test bench doc clean fmt lint release

# Objetivo por defecto
all: build test

# Compilar el proyecto
build:
	$(CARGO) build

# Ejecutar tests
test:
	$(CARGO) test

# Ejecutar benchmarks
bench:
	$(CARGO) bench

# Generar documentación
doc:
	$(CARGO) doc --no-deps

# Limpiar archivos generados
clean:
	$(CARGO) clean

# Formatear código
fmt:
	$(CARGO) fmt

# Ejecutar linter (Clippy)
lint:
	$(CARGO) clippy -- -D warnings

# Compilar en modo release
release:
	$(CARGO) build --release

# Ejecutar el programa
run:
	$(CARGO) run

# Verificar el proyecto sin compilar
check:
	$(CARGO) check

# Actualizar dependencias
update:
	$(CARGO) update

# Generar un nuevo proyecto de prueba
new_test:
	@read -p "Enter test name: " name; \
	$(CARGO) new --lib $(TESTS_DIR)/$$name

# Generar un nuevo benchmark
new_bench:
	@read -p "Enter benchmark name: " name; \
	echo "Generating new benchmark: $$name"; \
	cp $(BENCHES_DIR)/template.rs $(BENCHES_DIR)/$$name.rs

# Ejecutar una prueba específica
run_test:
	@read -p "Enter test name: " name; \
	$(CARGO) test $$name

# Ejecutar un benchmark específico
run_bench:
	@read -p "Enter benchmark name: " name; \
	$(CARGO) bench $$name

# Generar informe de cobertura (requiere cargo-tarpaulin)
coverage:
	cargo tarpaulin --out Html

# Publicar el paquete en crates.io
publish:
	$(CARGO) publish

# Ayuda
help:
	@echo "Makefile para $(PROJECT_NAME)"
	@echo ""
	@echo "Objetivos disponibles:"
	@echo "  all        : Compilar y ejecutar tests (por defecto)"
	@echo "  build      : Compilar el proyecto"
	@echo "  test       : Ejecutar tests"
	@echo "  bench      : Ejecutar benchmarks"
	@echo "  doc        : Generar documentación"
	@echo "  clean      : Limpiar archivos generados"
	@echo "  fmt        : Formatear código"
	@echo "  lint       : Ejecutar linter (Clippy)"
	@echo "  release    : Compilar en modo release"
	@echo "  run        : Ejecutar el programa"
	@echo "  check      : Verificar el proyecto sin compilar"
	@echo "  update     : Actualizar dependencias"
	@echo "  new_test   : Generar un nuevo proyecto de prueba"
	@echo "  new_bench  : Generar un nuevo benchmark"
	@echo "  run_test   : Ejecutar una prueba específica"
	@echo "  run_bench  : Ejecutar un benchmark específico"
	@echo "  coverage   : Generar informe de cobertura"
	@echo "  publish    : Publicar el paquete en crates.io"
	@echo "  help       : Mostrar esta ayuda"