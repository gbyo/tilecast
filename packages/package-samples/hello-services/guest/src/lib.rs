//! Sample Package API v3 guest.
//!
//! The `report` background job reads the organization name and the
//! screen list through `tilecast.call_v1`, then writes one namespaced
//! audit event. It exercises a read grant, a directory read grant, and
//! a write grant through the reference guest SDK. Any failure answers
//! -1: background jobs have no operator waiting, so they fail closed
//! and let the scheduler retry on the next interval.

use std::slice;

use tilecast_package_guest::{CallError, ListInput, audit, organization, screens};

/// Runs one declared background job. The host frames the job identity
/// at `in_ptr` and passes its length; the guest copies it first, then
/// does its work.
#[unsafe(no_mangle)]
pub extern "C" fn run_job(in_ptr: u32, in_len: u32) -> i32 {
    // SAFETY: the host framed exactly in_len input bytes at in_ptr for
    // this call. Copy out immediately; nothing else runs first.
    let job = unsafe { slice::from_raw_parts(in_ptr as *const u8, in_len as usize) }.to_vec();
    if job != b"report" {
        return -1;
    }
    match report() {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

fn report() -> Result<(), CallError> {
    let org = organization::get()?;
    let page = screens::list(&ListInput::default())?;
    let mut metadata = serde_json::Map::new();
    metadata.insert("organization".to_string(), serde_json::Value::String(org.name));
    metadata.insert("screenCount".to_string(), serde_json::Value::from(page.total));
    audit::write(&audit::WriteInput {
        action: "package.screens.reported".to_string(),
        resource_type: "package".to_string(),
        resource_id: String::new(),
        resource_name: String::new(),
        metadata: Some(serde_json::Value::Object(metadata)),
    })?;
    Ok(())
}

/// The sample ships no Studio UI. The export exists so the module shape
/// stays uniform; the host never calls it without a `studioUI`
/// capability, and it refuses if anything ever does.
#[unsafe(no_mangle)]
pub extern "C" fn handle_ui_request(_in_ptr: u32, _in_len: u32, _out_ptr: u32, _out_cap: u32) -> i32 {
    -1
}
