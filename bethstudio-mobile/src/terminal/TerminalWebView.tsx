import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Platform, StyleSheet } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ScreenEvent } from "@/protocol/types";
import { XTERM_THEME } from "@/ui/theme";
import { terminalHtml } from "./xtermHtml";

export interface TerminalWebViewHandle {
  screen(ev: ScreenEvent): void;
  focusKeyboard(): void;
  blurKeyboard(): void;
}

interface Props {
  readOnly: boolean;
  onData: (data: string) => void;
  onPaste: (data: string) => void;
  /** Linhas arrastadas: positivo = para tras no historico. */
  onScrollLines: (lines: number) => void;
  onTap?: () => void;
}

type PageMsg =
  | { t: "ready" }
  | { t: "data"; data: string }
  | { t: "paste"; data: string }
  | { t: "scroll"; lines: number }
  | { t: "tap" };

export const TerminalWebView = forwardRef<TerminalWebViewHandle, Props>(function TerminalWebView(
  { readOnly, onData, onPaste, onScrollLines, onTap },
  ref,
) {
  const web = useRef<WebView>(null);
  const ready = useRef(false);
  const pending = useRef<ScreenEvent | null>(null);
  const last = useRef<ScreenEvent | null>(null);
  const frame = useRef<number | null>(null);
  const readOnlyRef = useRef(readOnly);
  const html = useMemo(() => terminalHtml(), []);

  const inject = useCallback((msg: unknown) => {
    web.current?.injectJavaScript(`window.bt&&window.bt.recv(${JSON.stringify(msg)});true;`);
  }, []);

  // No maximo uma tela por quadro: a ponte manda ate' ~33 por segundo.
  const flush = useCallback(() => {
    frame.current = null;
    const ev = pending.current;
    if (!ev || !ready.current) return;
    pending.current = null;
    inject({ t: "screen", ev });
  }, [inject]);

  useImperativeHandle(
    ref,
    () => ({
      screen(ev) {
        pending.current = ev;
        last.current = ev;
        if (frame.current === null) frame.current = requestAnimationFrame(flush);
      },
      focusKeyboard() {
        inject({ t: "focus" });
      },
      blurKeyboard() {
        inject({ t: "blur" });
      },
    }),
    [flush, inject],
  );

  // Somente leitura vale tambem dentro da pagina (sem teclado, sem onData).
  useEffect(() => {
    readOnlyRef.current = readOnly;
    if (ready.current) inject({ t: "config", readOnly });
  }, [readOnly, inject]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let m: PageMsg;
      try {
        m = JSON.parse(e.nativeEvent.data) as PageMsg;
      } catch {
        return;
      }
      switch (m.t) {
        case "ready":
          // Tambem apos o WebView recarregar: reaplica config e a ultima tela.
          ready.current = true;
          inject({ t: "config", readOnly: readOnlyRef.current });
          pending.current = pending.current ?? last.current;
          if (pending.current && frame.current === null) frame.current = requestAnimationFrame(flush);
          break;
        case "data":
          if (!readOnlyRef.current && typeof m.data === "string") onData(m.data);
          break;
        case "paste":
          if (!readOnlyRef.current && typeof m.data === "string") onPaste(m.data);
          break;
        case "scroll":
          if (typeof m.lines === "number" && Number.isFinite(m.lines)) onScrollLines(m.lines);
          break;
        case "tap":
          onTap?.();
          break;
      }
    },
    [flush, inject, onData, onPaste, onScrollLines, onTap],
  );

  return (
    <WebView
      ref={web}
      style={styles.web}
      source={{ html }}
      originWhitelist={["about:blank", "data:*"]}
      onShouldStartLoadWithRequest={(r) => r.url === "about:blank" || r.url.startsWith("data:")}
      onMessage={onMessage}
      javaScriptEnabled
      domStorageEnabled={false}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      textZoom={100}
      webviewDebuggingEnabled={__DEV__}
      androidLayerType={Platform.OS === "android" ? "hardware" : undefined}
      onContentProcessDidTerminate={() => {
        ready.current = false;
        web.current?.reload();
      }}
      onRenderProcessGone={() => {
        ready.current = false;
        web.current?.reload();
        return true;
      }}
    />
  );
});

const styles = StyleSheet.create({
  web: { flex: 1, backgroundColor: XTERM_THEME.background },
});
