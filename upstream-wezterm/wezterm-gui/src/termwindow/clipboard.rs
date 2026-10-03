use crate::termwindow::TermWindowNotif;
use crate::TermWindow;
use config::keyassignment::{ClipboardCopyDestination, ClipboardPasteSource};
use mux::pane::Pane;
use mux::Mux;
use std::sync::Arc;
use window::{Clipboard, WindowOps};

impl TermWindow {
    pub fn copy_to_clipboard(&self, clipboard: ClipboardCopyDestination, text: String) {
        let clipboard = match clipboard {
            ClipboardCopyDestination::Clipboard => [Some(Clipboard::Clipboard), None],
            ClipboardCopyDestination::PrimarySelection => [Some(Clipboard::PrimarySelection), None],
            ClipboardCopyDestination::ClipboardAndPrimarySelection => [
                Some(Clipboard::Clipboard),
                Some(Clipboard::PrimarySelection),
            ],
        };
        for &c in &clipboard {
            if let Some(c) = c {
                self.window.as_ref().unwrap().set_clipboard(c, text.clone());
            }
        }
    }

    pub fn paste_from_clipboard(&mut self, pane: &Arc<dyn Pane>, clipboard: ClipboardPasteSource) {
        let pane_id = pane.pane_id();
        log::trace!(
            "paste_from_clipboard in pane {} {:?}",
            pane.pane_id(),
            clipboard
        );
        #[cfg(windows)]
        if matches!(clipboard, ClipboardPasteSource::Clipboard)
            && wtinator::image_paste::clipboard_has_image().is_some()
        {
            match wtinator::image_paste::paste_image_to_pane(pane) {
                Ok(Some(bytes)) => {
                    log::info!(
                        "wtinator pasted clipboard image as markdown file link: {} bytes",
                        bytes
                    );
                    self.maybe_scroll_to_bottom_for_input(pane);
                    return;
                }
                Ok(None) => {}
                Err(err) => {
                    log::warn!("wtinator image paste failed, falling back to text paste: {err:#}");
                }
            }
        }
        let window = self.window.as_ref().unwrap().clone();
        let clipboard = match clipboard {
            ClipboardPasteSource::Clipboard => Clipboard::Clipboard,
            ClipboardPasteSource::PrimarySelection => Clipboard::PrimarySelection,
        };
        let future = window.get_clipboard(clipboard);
        promise::spawn::spawn(async move {
            if let Ok(clip) = future.await {
                window.notify(TermWindowNotif::Apply(Box::new(move |myself| {
                    if let Some(pane) = myself
                        .pane_state(pane_id)
                        .overlay
                        .as_ref()
                        .map(|overlay| overlay.pane.clone())
                        .or_else(|| {
                            let mux = Mux::get();
                            mux.get_pane(pane_id)
                        })
                    {
                        // WezTerminator (patch 0067): prevent invisible
                        // clipboard controls such as U+001F from reaching a
                        // shell and being displayed as `^_`.
                        let clip = wtinator::clipboard::sanitize_paste_text(&clip);
                        let clip = if wtinator::wsl::pane_is_wsl(&pane) {
                            wtinator::clipboard::windows_paths_to_wsl(&clip)
                        } else {
                            clip
                        };
                        pane.send_paste(&clip).ok();
                    }
                })));
            }
        })
        .detach();
        self.maybe_scroll_to_bottom_for_input(&pane);
    }
}
