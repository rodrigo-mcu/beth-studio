import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KEY, applyCtrl, arrow, type ArrowKey } from "@/protocol/keys";
import { paneLabel } from "@/protocol/panes";
import { useClientSnapshot, useConnectionClient } from "@/state/clients";
import { AccessoryBar } from "@/terminal/AccessoryBar";
import { ScrollDriver } from "@/terminal/scrollDriver";
import { TerminalWebView, type TerminalWebViewHandle } from "@/terminal/TerminalWebView";
import { Banner, StatusPill } from "@/ui/components";
import { C } from "@/ui/theme";

// Tela "Terminal": um pane. Mostra a imagem que a ponte manda (o grid do
// host, sem redimensionar o pane), rola o historico com o dedo e, se a
// conexao nao for somente leitura, digita pelo teclado + barra de teclas.

export default function TerminalScreen() {
  const { connId, paneId: paneParam } = useLocalSearchParams<{ connId: string; paneId: string }>();
  const paneId = Number(paneParam);
  const insets = useSafeAreaInsets();
  const { client, error } = useConnectionClient(connId);
  const snap = useClientSnapshot(client);
  const readOnly = snap.readOnly;
  const pane = useMemo(() => snap.panes?.find((p) => p.pane_id === paneId), [snap.panes, paneId]);
  const gone = !!snap.panes && !pane;

  const term = useRef<TerminalWebViewHandle>(null);
  const [gotScreen, setGotScreen] = useState(false);
  const [scroll, setScroll] = useState({ offset: 0, scrollback: 0, rows: 24 });
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlRef = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const driver = useMemo(() => (client && Number.isInteger(paneId) ? new ScrollDriver((o) => client.scroll(paneId, o)) : null), [client, paneId]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 1600);
  }, []);

  // Observa este pane e desenha cada tela nova.
  useEffect(() => {
    if (!client || !driver) return;
    const d = driver;
    client.setWatched([paneId]);
    const off = client.onScreen(paneId, (ev) => {
      term.current?.screen(ev);
      if (d.onScreen(ev)) setScroll({ offset: ev.offset, scrollback: ev.scrollback, rows: ev.rows });
      setGotScreen(true);
    });
    return () => {
      off();
      d.dispose();
      client.setWatched([]);
    };
  }, [client, driver, paneId]);

  const setCtrl = (v: boolean) => {
    ctrlRef.current = v;
    setCtrlArmed(v);
  };

  const send = useCallback(
    (data: string) => {
      if (!client || readOnly || !data) return;
      driver?.resetToLive();
      if (!client.send(paneId, data)) flash("Sem conexão: tecla não enviada");
    },
    [client, readOnly, driver, paneId, flash],
  );

  const onData = useCallback(
    (data: string) => {
      if (ctrlRef.current) {
        setCtrl(false);
        send(applyCtrl(data));
      } else send(data);
    },
    [send],
  );

  const pasteText = useCallback(
    (text: string) => {
      if (!client || readOnly || !text) return;
      const go = () => {
        driver?.resetToLive();
        if (!client.paste(paneId, text)) flash("Sem conexão: texto não enviado");
      };
      const lines = text.split(/\r\n|\r|\n/).length;
      // Varias linhas podem executar comandos: pede confirmacao.
      if (lines > 1) {
        Alert.alert("Colar no terminal", `Colar ${lines} linhas? Cada linha pode executar um comando.`, [
          { text: "Cancelar", style: "cancel" },
          { text: "Colar", onPress: go },
        ]);
      } else go();
    },
    [client, readOnly, driver, paneId, flash],
  );

  const pasteFromClipboard = async () => {
    const text = await Clipboard.getStringAsync();
    if (!text) flash("A área de transferência está vazia");
    else pasteText(text);
  };

  const onArrow = (k: ArrowKey) => {
    const withCtrl = ctrlRef.current;
    if (withCtrl) setCtrl(false);
    send(arrow(k, withCtrl));
  };

  const page = (dir: 1 | -1) => driver?.scrollBy(dir * Math.max(1, scroll.rows - 2));

  const title = pane ? paneLabel(pane) : `Terminal ${paneParam}`;

  return (
    <KeyboardAvoidingView
      style={[s.root, { paddingBottom: insets.bottom }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Stack.Screen
        options={{
          title,
          headerRight: () => (pane ? <Text style={s.size}>{`${pane.size.cols}×${pane.size.rows}`}</Text> : null),
        }}
      />
      {snap.socket !== "open" && (
        <View style={s.statusRow}>
          <StatusPill socket={snap.socket} readOnly={readOnly} />
        </View>
      )}
      {error && <Banner kind="error">{error}</Banner>}
      {snap.lastError && (
        <Banner kind="error" onClose={() => client?.clearError()}>
          {snap.lastError}
        </Banner>
      )}

      <View style={s.termArea}>
        <TerminalWebView
          ref={term}
          readOnly={readOnly}
          onData={onData}
          onPaste={pasteText}
          onScrollLines={(n) => driver?.scrollBy(n)}
        />
        {!gotScreen && !gone && (
          <View style={s.overlay} pointerEvents="none">
            <Text style={s.overlayText}>Carregando a tela do terminal…</Text>
          </View>
        )}
        {gone && (
          <View style={[s.overlay, s.goneBg]}>
            <Text style={s.overlayText}>Este terminal não existe mais no BethStudio.</Text>
          </View>
        )}
        {scroll.offset > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Voltar ao fim"
            onPress={() => driver?.scrollTo(0)}
            style={({ pressed }) => [s.live, pressed && { backgroundColor: C.accentPressed }]}
          >
            <Ionicons name="arrow-down-circle" size={20} color={C.text1} />
            <Text style={s.liveText}>Voltar ao fim</Text>
            <Text style={s.liveSub}>({scroll.offset} linhas acima)</Text>
          </Pressable>
        )}
        {toast && (
          <View style={s.toast} pointerEvents="none">
            <Text style={s.toastText}>{toast}</Text>
          </View>
        )}
      </View>

      <AccessoryBar
        readOnly={readOnly}
        ctrlArmed={ctrlArmed}
        onEsc={() => send(KEY.esc)}
        onTab={() => send(KEY.tab)}
        onToggleCtrl={() => setCtrl(!ctrlRef.current)}
        onArrow={onArrow}
        onCtrlC={() => send(KEY.ctrlC)}
        onPaste={() => void pasteFromClipboard()}
        onKeyboard={() => term.current?.focusKeyboard()}
        onPageUp={() => page(1)}
        onPageDown={() => page(-1)}
      />
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgTerm },
  statusRow: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: C.bgBody },
  termArea: { flex: 1 },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", padding: 24 },
  goneBg: { backgroundColor: "#0F1729E6" },
  overlayText: { color: C.text2, fontSize: 15, textAlign: "center" },
  size: { color: C.text2, fontFamily: "monospace", fontSize: 12, marginRight: 8 },
  live: {
    position: "absolute",
    right: 12,
    bottom: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.accent,
    borderRadius: 999,
    paddingHorizontal: 14,
    minHeight: 44,
  },
  liveText: { color: C.text1, fontSize: 14, fontWeight: "600" },
  liveSub: { color: C.text1, opacity: 0.75, fontSize: 12 },
  toast: {
    position: "absolute",
    bottom: 68,
    alignSelf: "center",
    backgroundColor: C.bgCard,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: C.border,
  },
  toastText: { color: C.text1, fontSize: 14 },
});
