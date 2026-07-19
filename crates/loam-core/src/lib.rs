//! Pure Rust engine for Loam.
//!
//! Tauri-specific types and behavior belong in the desktop shell.

pub mod index;
pub mod parse;
pub mod vault;

/// The current product display name.
pub const APP_NAME: &str = "Loam";

#[cfg(test)]
mod tests {
    use super::APP_NAME;

    #[test]
    fn exposes_the_product_name() {
        assert_eq!(APP_NAME, "Loam");
    }
}
