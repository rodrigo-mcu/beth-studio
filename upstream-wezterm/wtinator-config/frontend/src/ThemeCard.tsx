import { ThemeSnapshot } from "./ipc";

interface Props {
  theme: ThemeSnapshot;
  selected: boolean;
  disabled: boolean;
  favorite: boolean;
  onToggleFavorite: () => void;
  // Patch 0062: present (pane mode) when the card is favourited — saves this
  // terminal's current font TYPE (family + bold/italic) into the favourite.
  // Undefined hides it.
  onUpdateFont?: () => void;
  onApply: () => void;
  // Patch 0110: this card is the persisted default for all terminals.
  isDefault?: boolean;
  onApplyAll?: () => void;
  applyAllDisabled?: boolean;
}

// A tiny ANSI-SGR renderer for the preview snippet. It understands
// the subset the preview_text uses: `\x1b[0m`, `\x1b[<n>m`, and
// `\x1b[1;<n>m` (bold + color). Colors 30-37 map to ansi[0..8],
// bold variants map to ansi[8..16].
interface Span {
  text: string;
  color: string;
  bold: boolean;
}

function renderAnsi(text: string, ansi: string[], fg: string): Span[] {
  const spans: Span[] = [];
  // The preview text is stored with literal "\x1b" escapes from Rust
  // JSON, which arrive here as real ESC (0x1b) characters.
  const ESC = "\u001b";
  let i = 0;
  let curColor = fg;
  let curBold = false;
  let buf = "";

  const flush = () => {
    if (buf.length > 0) {
      spans.push({ text: buf, color: curColor, bold: curBold });
      buf = "";
    }
  };

  while (i < text.length) {
    if (text[i] === ESC && text[i + 1] === "[") {
      flush();
      let j = i + 2;
      let code = "";
      while (j < text.length && text[j] !== "m") {
        code += text[j];
        j++;
      }
      const parts = code.split(";").filter((p) => p.length > 0);
      if (parts.length === 0 || code === "0") {
        curColor = fg;
        curBold = false;
      } else {
        for (const p of parts) {
          const n = parseInt(p, 10);
          if (n === 0) {
            curColor = fg;
            curBold = false;
          } else if (n === 1) {
            curBold = true;
          } else if (n >= 30 && n <= 37) {
            const idx = (n - 30) + (curBold ? 8 : 0);
            curColor = ansi[idx] ?? fg;
          } else if (n >= 90 && n <= 97) {
            curColor = ansi[(n - 90) + 8] ?? fg;
          }
        }
      }
      i = j + 1;
    } else {
      buf += text[i];
      i++;
    }
  }
  flush();
  return spans;
}

export function ThemeCard({
  theme,
  selected,
  disabled,
  favorite,
  onToggleFavorite,
  onUpdateFont,
  onApply,
  isDefault,
  onApplyAll,
  applyAllDisabled,
}: Props) {
  const spans = renderAnsi(theme.preview_text, theme.ansi, theme.foreground);

  return (
    <div className={"card" + (selected ? " selected" : "")}>
      <div className="card-head">
        <button
          className={"card-fav" + (favorite ? " on" : "")}
          onClick={onToggleFavorite}
          title={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label="Toggle favorite"
        >
          {favorite ? "★" : "☆"}
        </button>
        {favorite && onUpdateFont && (
          <button
            className="card-fav"
            onClick={onUpdateFont}
            title="Save this terminal's current font type (family, bold/italic) to this favorite"
            aria-label="Save current font to favorite"
          >
            ↻
          </button>
        )}
        <span className="card-name">{theme.name}</span>
        {theme.kind === "UserDownloaded" && (
          <span className="card-badge downloaded" title="Downloaded theme">
            downloaded
          </span>
        )}
        {isDefault && (
          <span className="card-badge default" title="Tema padrão de todos os terminais">
            padrão
          </span>
        )}
        {selected && <span className="card-badge">current</span>}
      </div>

      <div className="swatch">
        {theme.ansi.map((c, i) => (
          <span
            key={i}
            className="chip"
            style={{ background: c }}
            title={`ansi ${i}: ${c}`}
          />
        ))}
      </div>

      <div
        className="preview"
        style={{ background: theme.background, color: theme.foreground }}
      >
        <pre>
          {spans.map((s, idx) => (
            <span
              key={idx}
              style={{ color: s.color, fontWeight: s.bold ? 700 : 400 }}
            >
              {s.text}
            </span>
          ))}
        </pre>
      </div>

      <div className="card-foot">
        <div className="fgbg">
          <span className="dotc" style={{ background: theme.background }} />
          bg {theme.background}
          <span
            className="dotc"
            style={{ background: theme.foreground, marginLeft: 10 }}
          />
          fg {theme.foreground}
        </div>
        <div className="card-actions">
          {onApplyAll && (
            <button
              className="apply-all"
              onClick={onApplyAll}
              disabled={applyAllDisabled ?? disabled}
              title="Salvar este tema + a fonte atual (família, tamanho, negrito, itálico) como padrão dos novos terminais e aplicar em todos os abertos"
            >
              {isDefault ? "Padrão" : "Usar como padrão"}
            </button>
          )}
          <button className="apply" onClick={onApply} disabled={disabled}>
            {selected ? "Applied" : "Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}
