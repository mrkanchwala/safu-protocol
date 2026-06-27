pub mod initialize;
pub mod stake;
pub mod unstake;
pub mod submit_claim;
pub mod stream_claim;
pub mod cancel_claim;
pub mod approve_override;
pub mod admin;

// Anchor's #[program] macro needs glob re-exports to resolve __client_accounts_* types.
// The `handler` name collision is a lint warning only — suppress it here.
#[allow(ambiguous_glob_reexports)]
pub use initialize::*;
#[allow(ambiguous_glob_reexports)]
pub use stake::*;
#[allow(ambiguous_glob_reexports)]
pub use unstake::*;
#[allow(ambiguous_glob_reexports)]
pub use submit_claim::*;
#[allow(ambiguous_glob_reexports)]
pub use stream_claim::*;
#[allow(ambiguous_glob_reexports)]
pub use cancel_claim::*;
#[allow(ambiguous_glob_reexports)]
pub use approve_override::*;
#[allow(ambiguous_glob_reexports)]
pub use admin::*;
