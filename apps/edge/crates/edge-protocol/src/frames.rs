//! Compatibility path for shared native Player values.
pub use player_types::frames::*;

#[cfg(test)]
mod tests {
    use super::*;

    /// The WPE renderer is C and cannot link the shared constant, so its
    /// frame response header is pinned to the contract here. If it drifted
    /// back to a permissive policy, a Widget could exfiltrate through image
    /// or media URLs.
    #[test]
    fn the_wpe_frame_header_is_the_loopback_contract_policy() {
        let source = include_str!("../../../renderer-wpe/src/schemes.c");
        let start = source.find("#define TC_FRAME_SANDBOX_POLICY").expect("policy define");
        let block = source[start..].split("\n\n").next().expect("define block");
        let mut policy = String::new();
        for line in block.lines() {
            if let (Some(open), Some(close)) = (line.find('"'), line.rfind('"'))
                && open < close
            {
                policy.push_str(&line[open + 1..close]);
            }
        }
        assert_eq!(policy, FRAME_LOOPBACK_RESPONSE_POLICY);
    }
}
