// wtinator::clipboard — text clipboard helpers.

/// Remove invisible control characters that can leak from an application's
/// plain-text clipboard representation. Keep tabs and line endings.
pub fn sanitize_paste_text(text: &str) -> String {
    text.chars()
        .filter(|&ch| matches!(ch, '\t' | '\n' | '\r') || !ch.is_control())
        .collect()
}

/// Rejoin visual rows emitted as hard line breaks by full-screen agent CLIs.
///
/// Normal terminal soft wrapping is handled by WezTerm itself. Some TUIs,
/// however, paint each visual row independently, so copied prose contains a
/// newline at every screen edge. This deliberately conservative heuristic
/// keeps paragraph, list, Markdown and indented/code boundaries intact.
pub fn unwrap_visual_rows(text: &str, terminal_cols: usize) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() < 2 {
        return text.to_string();
    }

    let near_right_edge = terminal_cols.saturating_sub(8).max(32);
    let mut out = String::with_capacity(text.len());

    for (idx, line) in lines.iter().enumerate() {
        out.push_str(line);
        let Some(next) = lines.get(idx + 1) else {
            continue;
        };

        let current = line.trim_end();
        let following = next.trim_start();
        let next_is_indented = next.len() != following.len();
        let structural = following.is_empty()
            || next_is_indented
            || following.starts_with("```")
            || following.starts_with('#')
            || following.starts_with('>')
            || following.starts_with("- ")
            || following.starts_with("* ")
            || following.starts_with("+ ")
            || is_numbered_list_item(following);
        let sentence_continues = following
            .chars()
            .next()
            .map(|ch| ch.is_lowercase() || matches!(ch, ',' | '.' | ';' | ':' | ')' | ']'))
            .unwrap_or(false)
            && !current.ends_with(['.', '!', '?', ':']);
        let reached_edge = line.chars().count() >= near_right_edge;

        if !current.is_empty() && !structural && (reached_edge || sentence_continues) {
            out.push(' ');
        } else {
            out.push('\n');
        }
    }

    out
}

fn is_numbered_list_item(text: &str) -> bool {
    let digits = text.bytes().take_while(|b| b.is_ascii_digit()).count();
    digits > 0 && matches!(text.as_bytes().get(digits..digits + 2), Some([b'.' | b')', b' ']))
}

/// Rewrite drive-letter paths embedded in clipboard text for a WSL shell.
/// Quoted paths retain their quotes, so spaces remain shell-safe. Unquoted
/// paths end at whitespace or a shell delimiter.
pub fn windows_paths_to_wsl(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let mut i = 0usize;

    while i + 2 < bytes.len() {
        // A drive path must start at a token boundary. Without this guard the
        // trailing `s:/` inside `https://` looks like a Windows S: drive.
        let at_path_boundary = i == 0
            || (!bytes[i - 1].is_ascii_alphanumeric()
                && !matches!(bytes[i - 1], b'/' | b'\\'));
        let is_path = at_path_boundary
            && bytes[i].is_ascii_alphabetic()
            && bytes[i + 1] == b':'
            && matches!(bytes[i + 2], b'\\' | b'/');
        if !is_path {
            i += text[i..].chars().next().map(char::len_utf8).unwrap_or(1);
            continue;
        }

        let quote = i
            .checked_sub(1)
            .and_then(|idx| matches!(bytes[idx], b'\'' | b'"').then_some(bytes[idx]));
        let mut end = text.len();
        for (offset, ch) in text[i + 3..].char_indices() {
            let absolute = i + 3 + offset;
            let stop = match quote {
                Some(q) => ch as u32 == q as u32,
                None => ch.is_whitespace() || matches!(ch, '\'' | '"' | '<' | '>' | '|'),
            };
            if stop {
                end = absolute;
                break;
            }
        }

        out.push_str(&text[cursor..i]);
        out.push_str(&crate::wsl::windows_path_to_wsl_mount(&text[i..end]));
        cursor = end;
        i = end;
    }
    out.push_str(&text[cursor..]);
    out
}

#[cfg(test)]
mod tests {
    use super::{sanitize_paste_text, unwrap_visual_rows, windows_paths_to_wsl};

    #[test]
    fn removes_unit_separator_seen_as_caret_underscore() {
        assert_eq!(
            sanitize_paste_text("rm -rf \u{001f}_build-cache/tools/tmp"),
            "rm -rf _build-cache/tools/tmp"
        );
    }

    #[test]
    fn preserves_tabs_newlines_and_printable_unicode() {
        assert_eq!(sanitize_paste_text("a\tb\r\nOlá 👋"), "a\tb\r\nOlá 👋");
    }

    #[test]
    fn removes_other_c0_and_c1_controls() {
        assert_eq!(sanitize_paste_text("a\0\u{001b}b\u{0085}c"), "abc");
    }

    #[test]
    fn converts_windows_paths_for_wsl() {
        assert_eq!(
            windows_paths_to_wsl(r#"cd "C:\Program Files\Example" && cat D:\logs\x.txt"#),
            r#"cd "/mnt/c/Program Files/Example" && cat /mnt/d/logs/x.txt"#
        );
    }

    #[test]
    fn leaves_non_windows_text_unchanged() {
        assert_eq!(windows_paths_to_wsl("echo /tmp/x https://x/y"), "echo /tmp/x https://x/y");
    }

    #[test]
    fn rejoins_agent_prose_wrapped_at_terminal_edge() {
        let text = "This is a long explanation rendered across the terminal window\nand continues on the following visual row.";
        assert_eq!(
            unwrap_visual_rows(text, 68),
            "This is a long explanation rendered across the terminal window and continues on the following visual row."
        );
    }

    #[test]
    fn rejoins_clear_sentence_continuation_inside_wide_terminal() {
        assert_eq!(
            unwrap_visual_rows("A resposta continua\nna linha visual seguinte.", 160),
            "A resposta continua na linha visual seguinte."
        );
    }

    #[test]
    fn preserves_paragraphs_lists_and_indented_code() {
        let text = "Primeiro paragrafo.\n\n- item um\n- item dois\n\nCodigo:\n    cargo test";
        assert_eq!(unwrap_visual_rows(text, 80), text);
    }

    #[test]
    fn preserves_numbered_markdown_items() {
        let text = "Passos:\n1. abrir\n2) executar";
        assert_eq!(unwrap_visual_rows(text, 80), text);
    }
}
