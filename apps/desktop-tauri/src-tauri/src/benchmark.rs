use std::{path::PathBuf, thread, time::Duration};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::{runtime_host::RuntimeHost, shell_services};

#[derive(Clone)]
pub struct BenchmarkConfig {
    pub scenario: String,
    pub output_path: PathBuf,
    pub stabilization_ms: u64,
}

pub fn config_from_environment() -> Result<Option<BenchmarkConfig>, String> {
    let scenario = std::env::var("SCR_RESOURCE_BENCHMARK_SCENARIO").ok();
    let output_path = std::env::var_os("SCR_RESOURCE_BENCHMARK_OUTPUT").map(PathBuf::from);
    let user_data = std::env::var_os("SCR_RESOURCE_BENCHMARK_USER_DATA");
    if scenario.is_none() && output_path.is_none() && user_data.is_none() {
        return Ok(None);
    }
    let scenario = scenario.ok_or_else(|| "Tauri benchmark scenario is missing.".to_string())?;
    if scenario != "R0-shell" && scenario != "R1-runtime" {
        return Err(format!(
            "Tauri benchmark scenario is unsupported: {scenario}"
        ));
    }
    let output_path =
        output_path.ok_or_else(|| "Tauri benchmark output path is missing.".to_string())?;
    if user_data.is_none() {
        return Err("Tauri benchmark user-data path is missing.".into());
    }
    let stabilization_ms = std::env::var("SCR_RESOURCE_BENCHMARK_STABILIZE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30_000)
        .clamp(1_000, 120_000);
    Ok(Some(BenchmarkConfig {
        scenario,
        output_path,
        stabilization_ms,
    }))
}

pub fn start(app: AppHandle, runtime: RuntimeHost, config: BenchmarkConfig) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    thread::spawn(move || {
        let result = run(&runtime, &config);
        match result {
            Ok(report) => {
                let write = write_json(&config.output_path, &report);
                let _ = runtime.shutdown();
                app.exit(if write.is_ok() { 0 } else { 1 });
            }
            Err(error) => {
                let failure_path =
                    PathBuf::from(format!("{}.failure.txt", config.output_path.display()));
                if let Some(parent) = failure_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&failure_path, format!("{error}\n"));
                let _ = runtime.shutdown();
                app.exit(1);
            }
        }
    });
}

fn run(runtime: &RuntimeHost, config: &BenchmarkConfig) -> Result<Value, String> {
    let startup_ready_ms = runtime.uptime_ms();
    thread::sleep(Duration::from_millis(config.stabilization_ms));
    let mut samples = Vec::<Value>::new();
    for index in 0..5 {
        samples.push(shell_services::resource_snapshot(runtime, None)?);
        if index < 4 {
            thread::sleep(Duration::from_secs(2));
        }
    }

    let product_private = metric_values(&samples, "productPrivateBytes");
    let shell_private = metric_values(&samples, "shellPrivateBytes");
    let product_working = metric_values(&samples, "productWorkingSetBytes");
    let process_counts = metric_values(&samples, "processCount");
    let generated_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| format!("Could not format benchmark timestamp: {error}"))?;
    Ok(json!({
        "schemaVersion": "scr.resource-benchmark/v1",
        "scenario": config.scenario,
        "generatedAt": generated_at,
        "startupReadyMs": startup_ready_ms,
        "stabilizationMs": config.stabilization_ms,
        "samples": samples,
        "summary": {
            "sampleCount": 5,
            "productPrivateMedianBytes": median(&product_private),
            "productPrivateMaxBytes": max(&product_private),
            "shellPrivateMedianBytes": median(&shell_private),
            "shellPrivateMaxBytes": max(&shell_private),
            "productWorkingSetMedianBytes": median(&product_working),
            "productWorkingSetMaxBytes": max(&product_working),
            "processCountMedian": median(&process_counts),
            "processCountMax": max(&process_counts)
        }
    }))
}

fn metric_values(samples: &[Value], key: &str) -> Vec<u64> {
    samples
        .iter()
        .filter_map(|sample| sample.get("totals"))
        .filter_map(|totals| totals.get(key))
        .filter_map(Value::as_u64)
        .collect()
}

fn median(values: &[u64]) -> u64 {
    if values.is_empty() {
        return 0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        (sorted[middle - 1] / 2)
            + (sorted[middle] / 2)
            + ((sorted[middle - 1] % 2 + sorted[middle] % 2) / 2)
    }
}

fn max(values: &[u64]) -> u64 {
    values.iter().copied().max().unwrap_or(0)
}

fn write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create benchmark output directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not serialize benchmark report: {error}"))?;
    std::fs::write(path, bytes)
        .map_err(|error| format!("Could not write benchmark report: {error}"))
}
