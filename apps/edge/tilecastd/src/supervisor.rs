//! Edge wire-value adapters for shared renderer recovery policy.
use edge_protocol::ipc::{event::EvidenceKind, presentation::ItemKind};

pub use player_core::{Expectation, HealAction, SupervisorConfig, SupervisorState};

pub fn evidence(kind: EvidenceKind) -> player_core::ProgressEvidence {
    use player_core::ProgressEvidence as Semantic;
    match kind {
        EvidenceKind::ItemStarted => Semantic::ItemStarted,
        EvidenceKind::ItemTransition => Semantic::ItemTransition,
        EvidenceKind::VideoProgress => Semantic::VideoProgress,
        EvidenceKind::ImageShown => Semantic::ImageShown,
        EvidenceKind::WidgetShown => Semantic::WidgetShown,
        EvidenceKind::WidgetAlive => Semantic::WidgetAlive,
        EvidenceKind::WidgetEmpty => Semantic::WidgetEmpty,
        EvidenceKind::LayoutShown => Semantic::LayoutShown,
        EvidenceKind::LayoutAlive => Semantic::LayoutAlive,
        EvidenceKind::LayoutZoneRendered => Semantic::LayoutZoneRendered,
        EvidenceKind::WebsiteLoaded => Semantic::WebsiteLoaded,
        EvidenceKind::WebsiteAlive => Semantic::WebsiteAlive,
        EvidenceKind::SurfaceShown => Semantic::SurfaceShown,
        EvidenceKind::FrameChanged => Semantic::FrameChanged,
    }
}

pub fn expectation_for(kind: ItemKind) -> Expectation {
    use player_core::RendererItemKind as Semantic;
    let kind = match kind {
        ItemKind::Image => Semantic::Image,
        ItemKind::Video => Semantic::Video,
        ItemKind::Website => Semantic::Website,
        ItemKind::Widget => Semantic::Widget,
        ItemKind::Layout => Semantic::Layout,
        ItemKind::Youtube => Semantic::Youtube,
    };
    Expectation::for_item(kind)
}

pub fn is_meaningful(kind: EvidenceKind, expectation: Expectation) -> bool {
    player_core::is_meaningful(evidence(kind), expectation)
}
