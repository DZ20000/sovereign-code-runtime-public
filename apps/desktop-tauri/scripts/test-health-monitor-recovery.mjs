import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Compile the production loop with deterministic platform doubles: no live Shell restart.
const source = readFileSync(new URL('../src-tauri/src/runtime_health.rs', import.meta.url), 'utf8');
const start = source.indexOf('fn restart_through_guardian(');
const end = source.indexOf('\n#[cfg(test)]', start);
assert(start >= 0 && end > start, 'Production health monitor entry point must be present');
const threshold = Number(/const RUNTIME_PING_FAILURES_BEFORE_RESTART: u8 = (\d+);/u.exec(source)?.[1]);
assert(Number.isInteger(threshold) && threshold > 1, 'Ping restart threshold must be declared');
const availabilitySource = readFileSync(new URL('../src-tauri/src/availability.rs', import.meta.url), 'utf8');
const stallGapMs = Number(/const POSSIBLE_SUSPEND_GAP_MS: u64 = ([\d_]+);/u.exec(availabilitySource)?.[1].replaceAll('_', ''));
assert(Number.isInteger(stallGapMs), 'The production stall threshold must be present');
// Pings go out every third tick, so the threshold-th failure lands on this tick.
const failUntil = threshold * 3;
const lastTick = failUntil + 12;
const fixture = `
use std::{sync::atomic::{AtomicU8, AtomicUsize, Ordering}, time::Duration};
const EXIT_MODE_RUNNING: u8 = 0;
const GUARDIAN_RESTART_EXIT_CODE: i32 = 70;
const RUNTIME_PING_FAILURES_BEFORE_RESTART: u8 = ${threshold};
const POSSIBLE_SUSPEND_GAP_MS: u64 = ${stallGapMs};
static NETWORK_MODE: AtomicUsize = AtomicUsize::new(0);
static NETWORK_CALLS: AtomicUsize = AtomicUsize::new(0);
static NETWORK_TICK: AtomicUsize = AtomicUsize::new(0);
static MODE: AtomicUsize = AtomicUsize::new(0);
static TICKS: AtomicUsize = AtomicUsize::new(0);
static CLOCK_MS: AtomicUsize = AtomicUsize::new(0);
static PREVIOUS_SAMPLE_MS: AtomicUsize = AtomicUsize::new(0);
static REFRESHES: AtomicUsize = AtomicUsize::new(0);
static STALL_REFRESHES: AtomicUsize = AtomicUsize::new(0);
static LAST_SAMPLE_STALLED: AtomicUsize = AtomicUsize::new(0);
static SHUTDOWNS: AtomicUsize = AtomicUsize::new(0);
static EVIDENCE: AtomicUsize = AtomicUsize::new(0);
// 0: five-second timeout; 1: stall before ping; 2/3: stall during failed/successful ping.
static PING_STYLE: AtomicUsize = AtomicUsize::new(0);
static LIFECYCLE: ApplicationLifecycle = ApplicationLifecycle(AtomicU8::new(0));
struct Instant(usize);
impl Instant {
    fn now() -> Self { Self(CLOCK_MS.load(Ordering::SeqCst)) }
    fn elapsed(&self) -> Duration { Duration::from_millis((CLOCK_MS.load(Ordering::SeqCst) - self.0) as u64) }
}
struct ApplicationLifecycle(AtomicU8);
impl ApplicationLifecycle {
    fn exit_mode(&self) -> u8 { self.0.load(Ordering::SeqCst) }
    fn begin_guardian_restart(&self) -> bool {
        self.0.compare_exchange(0, 2, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }
}
struct AppHandle;
impl AppHandle {
    fn state<T>(&self) -> &ApplicationLifecycle { &LIFECYCLE }
    fn exit(&self, _: i32) { LIFECYCLE.0.store(2, Ordering::SeqCst); }
}
struct RuntimeHostSupervisor;
impl RuntimeHostSupervisor { fn active(&self) -> RuntimeHost { RuntimeHost } }
struct RuntimeHost;
impl RuntimeHost {
    fn is_healthy(&self) -> bool { MODE.load(Ordering::SeqCst) < 3 || TICKS.load(Ordering::SeqCst) > 6 }
    fn ping(&self) -> Result<(), String> {
        if TICKS.load(Ordering::SeqCst) > ${failUntil} { return Ok(()); }
        let style = PING_STYLE.load(Ordering::SeqCst);
        CLOCK_MS.fetch_add(if style >= 2 { 30000 } else { 5000 }, Ordering::SeqCst);
        if style == 3 { Ok(()) } else { Err("transient timeout".into()) }
    }
    fn shutdown(&self) -> Result<(), String> { SHUTDOWNS.fetch_add(1, Ordering::SeqCst); Ok(()) }
    fn refresh_tunnel(&self) -> Result<(), String> {
        REFRESHES.fetch_add(1, Ordering::SeqCst);
        STALL_REFRESHES.fetch_add(LAST_SAMPLE_STALLED.load(Ordering::SeqCst), Ordering::SeqCst);
        Ok(())
    }
    fn refresh_tunnel_after_network_change(&self) -> Result<(), String> {
        NETWORK_CALLS.fetch_add(1, Ordering::SeqCst);
        NETWORK_TICK.store(TICKS.load(Ordering::SeqCst), Ordering::SeqCst);
        if NETWORK_MODE.load(Ordering::SeqCst) == 2 { Err("response lost".into()) } else { self.refresh_tunnel() }
    }
}
struct HostGuardian;
impl HostGuardian {
    fn is_enabled(&self) -> bool { MODE.load(Ordering::SeqCst) % 3 != 0 }
    fn prepare_restart(&self, _: &str) -> Result<(), String> {
        if MODE.load(Ordering::SeqCst) % 3 == 2 { Ok(()) } else { Err("ack timeout".into()) }
    }
    fn cancel_restart(&self) -> Result<(), String> { Ok(()) }
}
struct HostAvailability;
impl HostAvailability {
    fn sample_tick(&self) -> bool {
        // Match HostAvailability: a gap is observed at the next sample, not during ping.
        let now = CLOCK_MS.load(Ordering::SeqCst);
        let previous = PREVIOUS_SAMPLE_MS.swap(now, Ordering::SeqCst);
        let stalled = now - previous >= POSSIBLE_SUSPEND_GAP_MS as usize;
        LAST_SAMPLE_STALLED.store(usize::from(stalled), Ordering::SeqCst);
        stalled
    }
    fn note_runtime_failure(&self, _: &str) {}
    fn observe_runtime_state(&self, _: &()) {}
    fn note_network_check_failure(&self, _: &str) {}
}
mod thread {
    use super::*;
    pub fn spawn(f: impl FnOnce()) { f(); }
    pub fn sleep(duration: Duration) {
        if LIFECYCLE.exit_mode() != EXIT_MODE_RUNNING { return; }
        if TICKS.load(Ordering::SeqCst) == ${lastTick} {
            LIFECYCLE.0.store(1, Ordering::SeqCst);
            return;
        }
        let tick = TICKS.fetch_add(1, Ordering::SeqCst) + 1;
        let delay = if PING_STYLE.load(Ordering::SeqCst) == 1 && tick % 3 == 0 { 30000 } else { duration.as_millis() as usize };
        CLOCK_MS.fetch_add(delay, Ordering::SeqCst);
    }
}
fn network_path_fingerprint() -> Option<String> {
    Some(if NETWORK_MODE.load(Ordering::SeqCst) > 0 && TICKS.load(Ordering::SeqCst) >= 3 { "home-vpn" } else { "roaming" }.into())
}
fn should_wake_tunnel_after_network_path_change(previous: Option<&str>, current: Option<&str>) -> bool { current.is_some() && previous != current }
fn keep_runtime_failure_evidence(_: &RuntimeHost, _: &HostGuardian, _: &HostAvailability, _: &str, _: &mut Option<String>) {
    EVIDENCE.fetch_add(1, Ordering::SeqCst);
}
${source.slice(start, end)}
fn main() {
    for mode in 0..6 {
        MODE.store(mode, Ordering::SeqCst);
        TICKS.store(0, Ordering::SeqCst);
        CLOCK_MS.store(0, Ordering::SeqCst);
        PREVIOUS_SAMPLE_MS.store(0, Ordering::SeqCst);
        REFRESHES.store(0, Ordering::SeqCst);
        SHUTDOWNS.store(0, Ordering::SeqCst);
        EVIDENCE.store(0, Ordering::SeqCst);
        LIFECYCLE.0.store(0, Ordering::SeqCst);
        start_runtime_health_monitor(AppHandle, RuntimeHostSupervisor, HostGuardian, HostAvailability);
        assert!(EVIDENCE.load(Ordering::SeqCst) > 0, "mode {mode}: failure evidence was not kept");
        if mode % 3 == 2 {
            assert_eq!(SHUTDOWNS.load(Ordering::SeqCst), 1, "accepted restart must shut down once");
            // A dead process restarts at once; a slow one only after sustained silence.
            let expected = if mode < 3 { ${failUntil} } else { 1 };
            assert_eq!(TICKS.load(Ordering::SeqCst), expected, "mode {mode}: restarted at the wrong moment");
            if mode == 2 { assert_eq!(CLOCK_MS.load(Ordering::SeqCst), 120000, "six real ping timeouts take about two minutes"); }
        } else {
            assert_eq!(TICKS.load(Ordering::SeqCst), ${lastTick}, "mode {mode}: monitor stopped after failed recovery");
            assert!(REFRESHES.load(Ordering::SeqCst) > 0, "mode {mode}: tunnel checks never resumed");
            assert_eq!(SHUTDOWNS.load(Ordering::SeqCst), 0);
        }
    }
    for style in 1..=3 {
        MODE.store(2, Ordering::SeqCst);
        PING_STYLE.store(style, Ordering::SeqCst);
        TICKS.store(0, Ordering::SeqCst);
        CLOCK_MS.store(0, Ordering::SeqCst);
        PREVIOUS_SAMPLE_MS.store(0, Ordering::SeqCst);
        SHUTDOWNS.store(0, Ordering::SeqCst);
        STALL_REFRESHES.store(0, Ordering::SeqCst);
        LIFECYCLE.0.store(0, Ordering::SeqCst);
        start_runtime_health_monitor(AppHandle, RuntimeHostSupervisor, HostGuardian, HostAvailability);
        assert_eq!(SHUTDOWNS.load(Ordering::SeqCst), 0, "stall timing {style}: must not restart the runtime");
        assert_eq!(TICKS.load(Ordering::SeqCst), ${lastTick});
        if style >= 2 { assert!(STALL_REFRESHES.load(Ordering::SeqCst) > 0, "ping must not consume the next sample's network recovery"); }
    }
    for network_mode in 1..=2 {
        NETWORK_MODE.store(network_mode, Ordering::SeqCst);
        NETWORK_CALLS.store(0, Ordering::SeqCst);
        NETWORK_TICK.store(0, Ordering::SeqCst);
        MODE.store(0, Ordering::SeqCst);
        PING_STYLE.store(0, Ordering::SeqCst);
        TICKS.store(0, Ordering::SeqCst);
        CLOCK_MS.store(0, Ordering::SeqCst);
        PREVIOUS_SAMPLE_MS.store(0, Ordering::SeqCst);
        LIFECYCLE.0.store(0, Ordering::SeqCst);
        start_runtime_health_monitor(AppHandle, RuntimeHostSupervisor, HostGuardian, HostAvailability);
        assert_eq!(NETWORK_TICK.load(Ordering::SeqCst), 4, "network change on a failed ping must be delivered next tick");
        assert_eq!(NETWORK_CALLS.load(Ordering::SeqCst), 1, "an unknown refresh result must not repeatedly restart a recovered connector");
    }
    PING_STYLE.store(0, Ordering::SeqCst);
    TICKS.store(0, Ordering::SeqCst);
    LIFECYCLE.0.store(1, Ordering::SeqCst);
    start_runtime_health_monitor(AppHandle, RuntimeHostSupervisor, HostGuardian, HostAvailability);
    assert_eq!(TICKS.load(Ordering::SeqCst), 0, "intentional exit must stop immediately");
}
`;
const directory = mkdtempSync(path.join(tmpdir(), 'so-health-monitor-'));
const input = path.join(directory, 'monitor.rs');
const output = path.join(directory, process.platform === 'win32' ? 'monitor.exe' : 'monitor');
try {
writeFileSync(input, fixture);
execFileSync('rustc', ['--edition=2021', '-Awarnings', input, '-o', output], { stdio: 'inherit' });
execFileSync(output, [], { stdio: 'inherit', timeout: 10000 });
} finally {
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith('so-health-monitor-'));
  rmSync(directory, { recursive: true, force: true });
}
console.log(`Passed: ${threshold} timed-out pings take 120s; process failure bypasses threshold; stalls before/during ping are excluded; post-stall tunnel refresh preserved; Guardian refusal, intentional exit, and network-change delivery after a missed ping.`);
