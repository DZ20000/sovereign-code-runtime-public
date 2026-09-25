use std::collections::{HashMap, HashSet};
use std::mem::size_of;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::{
    K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};

#[derive(Clone, Debug)]
pub struct ProcessInfo {
    pub process_id: u32,
    pub parent_process_id: u32,
    pub executable: String,
}

#[derive(Clone, Copy, Debug)]
pub struct ProcessMemory {
    pub working_set_bytes: u64,
    pub private_bytes: u64,
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub fn process_tree(root_process_id: u32) -> Result<Vec<ProcessInfo>, String> {
    let processes = enumerate_processes()?;
    let by_parent = processes.iter().fold(
        HashMap::<u32, Vec<&ProcessInfo>>::new(),
        |mut acc, process| {
            acc.entry(process.parent_process_id).or_default().push(process);
            acc
        },
    );
    let mut included = HashSet::from([root_process_id]);
    let mut frontier = vec![root_process_id];
    while let Some(parent) = frontier.pop() {
        if let Some(children) = by_parent.get(&parent) {
            for child in children {
                if included.insert(child.process_id) {
                    frontier.push(child.process_id);
                }
            }
        }
    }
    let mut tree = processes
        .into_iter()
        .filter(|process| included.contains(&process.process_id))
        .collect::<Vec<_>>();
    if !tree.iter().any(|process| process.process_id == root_process_id) {
        tree.push(ProcessInfo {
            process_id: root_process_id,
            parent_process_id: 0,
            executable: "sovereign-desktop-tauri.exe".into(),
        });
    }
    tree.sort_by_key(|process| process.process_id);
    Ok(tree)
}

pub fn memory(process_id: u32) -> Option<ProcessMemory> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_INFORMATION | PROCESS_VM_READ,
            false,
            process_id,
        )
        .ok()?
    };
    let handle = OwnedHandle(handle);
    let mut counters = PROCESS_MEMORY_COUNTERS_EX::default();
    counters.cb = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
    let ok = unsafe {
        K32GetProcessMemoryInfo(
            handle.0,
            (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>(),
            size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        )
    };
    if !ok.as_bool() {
        return None;
    }
    Some(ProcessMemory {
        working_set_bytes: counters.WorkingSetSize as u64,
        private_bytes: counters.PrivateUsage as u64,
    })
}

fn enumerate_processes() -> Result<Vec<ProcessInfo>, String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| format!("Could not enumerate Windows processes: {error}"))?;
    let snapshot = OwnedHandle(snapshot);
    let mut entry = PROCESSENTRY32W::default();
    entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
    let mut result = Vec::new();
    if unsafe { Process32FirstW(snapshot.0, &mut entry) }.is_err() {
        return Ok(result);
    }
    loop {
        result.push(ProcessInfo {
            process_id: entry.th32ProcessID,
            parent_process_id: entry.th32ParentProcessID,
            executable: wide_string(&entry.szExeFile),
        });
        if unsafe { Process32NextW(snapshot.0, &mut entry) }.is_err() {
            break;
        }
    }
    Ok(result)
}

fn wide_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}
