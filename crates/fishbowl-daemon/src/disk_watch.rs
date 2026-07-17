use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, TryRecvError, channel};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiskWatchPlan {
    FullDiscovery,
    Incremental(Vec<PathBuf>),
}

/// Keeps OS file-system watches alive for the daemon lifetime. A cache is only
/// trusted after this registry has observed a full candidate discovery. If the
/// watcher reports an overflow, an opaque event, or an error, the next capture
/// deliberately falls back to full discovery rather than guessing.
#[derive(Default)]
pub struct DiskWatchRegistry {
    watches: HashMap<PathBuf, DiskWatch>,
}

struct DiskWatch {
    _watcher: RecommendedWatcher,
    events: Receiver<notify::Result<Event>>,
    baseline_ready: bool,
}

impl DiskWatchRegistry {
    pub fn capture_plan(&mut self, root: &Path) -> DiskWatchPlan {
        let Ok(root) = std::fs::canonicalize(root) else {
            return DiskWatchPlan::FullDiscovery;
        };
        if !self.watches.contains_key(&root) {
            let Ok(watch) = DiskWatch::new(&root) else {
                return DiskWatchPlan::FullDiscovery;
            };
            self.watches.insert(root.clone(), watch);
            return DiskWatchPlan::FullDiscovery;
        }
        let watch = self.watches.get_mut(&root).expect("watch was inserted");
        let (changed_paths, requires_full_discovery) = watch.drain_events();
        if requires_full_discovery {
            watch.baseline_ready = false;
            return DiskWatchPlan::FullDiscovery;
        }
        if !watch.baseline_ready {
            return DiskWatchPlan::FullDiscovery;
        }
        DiskWatchPlan::Incremental(changed_paths)
    }

    pub fn record_capture(&mut self, root: &Path, discovery_complete: bool) {
        let Ok(root) = std::fs::canonicalize(root) else {
            return;
        };
        if let Some(watch) = self.watches.get_mut(&root) {
            watch.baseline_ready = discovery_complete;
        }
    }
}

impl DiskWatch {
    fn new(root: &Path) -> notify::Result<Self> {
        let (sender, events) = channel();
        let mut watcher = RecommendedWatcher::new(
            move |event| {
                let _ = sender.send(event);
            },
            Config::default(),
        )?;
        watcher.watch(root, RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            events,
            baseline_ready: false,
        })
    }

    fn drain_events(&mut self) -> (Vec<PathBuf>, bool) {
        let mut changed_paths = Vec::new();
        let mut requires_full_discovery = false;
        loop {
            match self.events.try_recv() {
                Ok(Ok(event)) => {
                    if event_requires_full_discovery(&event) {
                        requires_full_discovery = true;
                    } else if event.paths.is_empty() {
                        requires_full_discovery = true;
                    } else {
                        changed_paths.extend(event.paths);
                    }
                }
                Ok(Err(_)) => requires_full_discovery = true,
                Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
            }
        }
        changed_paths.sort();
        changed_paths.dedup();
        (changed_paths, requires_full_discovery)
    }
}

fn event_requires_full_discovery(event: &Event) -> bool {
    matches!(
        event.kind,
        EventKind::Any | EventKind::Other | EventKind::Access(_)
    )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use notify::event::CreateKind;
    use notify::{Event, EventKind};

    use super::{DiskWatchPlan, DiskWatchRegistry, event_requires_full_discovery};

    #[test]
    fn opaque_events_force_a_safe_full_discovery() {
        let opaque = Event::new(EventKind::Other);
        let create = Event::new(EventKind::Create(CreateKind::Any));
        assert!(event_requires_full_discovery(&opaque));
        assert!(!event_requires_full_discovery(&create));
    }

    #[test]
    fn completed_baseline_reuses_the_watch_without_a_second_walk() {
        let root = std::env::temp_dir().join(format!(
            "fishbowl-disk-watch-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock before epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create temporary watch root");

        {
            let mut registry = DiskWatchRegistry::default();
            assert_eq!(registry.capture_plan(&root), DiskWatchPlan::FullDiscovery);
            registry.record_capture(&root, true);
            assert_eq!(
                registry.capture_plan(&root),
                DiskWatchPlan::Incremental(Vec::new())
            );
        }

        fs::remove_dir_all(root).expect("remove temporary watch root");
    }
}
