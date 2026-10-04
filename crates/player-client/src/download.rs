//! A validated player API download path, without a query, fragment, or origin.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerDownloadPath(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("download path must be a plain /api/v1/player/ path")]
pub struct InvalidDownloadPath;

impl PlayerDownloadPath {
    pub fn parse(path: &str) -> Result<Self, InvalidDownloadPath> {
        let plain = path.starts_with("/api/v1/player/")
            && path.len() <= 512
            && !path.split('/').any(|segment| segment == "." || segment == "..")
            && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'));
        if plain { Ok(Self(path.to_owned())) } else { Err(InvalidDownloadPath) }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_plain_player_paths_can_receive_download_credentials() {
        assert!(PlayerDownloadPath::parse("/api/v1/player/assets/a/variants/b").is_ok());
        for bad in [
            "/api/v1/system/identity",
            "https://other.example/a",
            "//other.example/a",
            "/api/v1/player/../system",
            "/api/v1/player/./asset",
            "/api/v1/player/a?token=x",
            "/api/v1/player/a#fragment",
            "/api/v1/player/%2e%2e/a",
        ] {
            assert!(PlayerDownloadPath::parse(bad).is_err(), "{bad}");
        }
        assert!(PlayerDownloadPath::parse(&format!("/api/v1/player/{}", "a".repeat(512))).is_err());
    }
}
