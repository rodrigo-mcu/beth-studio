import Ionicons from "@expo/vector-icons/Ionicons";
import { addNetworkStateListener, getNetworkStateAsync } from "expo-network";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { originOf } from "@/config/domain";
import { loadPassword } from "@/storage/secrets";
import { clock } from "@/voice/describe";
import { retryDelayMs } from "@/voice/retry";
import type { Take } from "@/voice/queue";
import { voice } from "@/voice/service";
import { deliverTextScript, isAllowedNavigation, loginScript, parseAck, shouldWake, wakeScript, type Presence } from "@/web/inject";
import { Banner, Button } from "./components";
import { TakesPanel } from "./TakesPanel";
import { C } from "./theme";

// Casca fina: o web app do celular dentro de um WebView, mais uma barra nativa
// no topo com o microfone (gravação em arquivo, fila de envio, textos prontos).

const PRIVACY = "O áudio vai para o PC, que o transcreve com o provedor de voz configurado lá. Nada entra no terminal antes de você revisar e tocar em Enviar.";

function askPrivacy(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert("Gravar voz", PRIVACY, [
      { text: "Agora não", style: "cancel", onPress: () => resolve(false) },
      { text: "Entendi, gravar", onPress: () => resolve(true) },
    ]);
  });
}

export function Shell({ host, onChangeServer }: { host: string; onChangeServer: () => void }) {
  const insets = useSafeAreaInsets();
  const web = useRef<WebView>(null);
  const snap = useSyncExternalStore(voice.subscribe, voice.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  const [panel, setPanel] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const origin = originOf(host);
  const mainUrl = `${origin}/`;

  // A senha só é lida do cofre aqui e usada para entrar dentro da página do próprio servidor.
  const passwordRef = useRef("");
  useEffect(() => {
    void loadPassword().then((p) => {
      passwordRef.current = p ?? "";
    });
  }, [host]);

  // --- fila de voz
  useEffect(() => {
    void voice.init(host, loadPassword);
    return () => voice.shutdown();
  }, [host]);

  useEffect(() => {
    if (!snap.recording && !panel) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [snap.recording, panel]);

  // --- reconexão rápida: voltou ao app / voltou a rede
  const reload = useCallback(() => {
    setFailed(false);
    web.current?.reload();
  }, []);
  const failedRef = useRef(failed);
  useEffect(() => {
    failedRef.current = failed;
  }, [failed]);
  const presence = useRef<Presence>({ appState: AppState.currentState, online: true });
  useEffect(() => {
    const apply = (patch: Partial<Presence>) => {
      const prev = presence.current;
      const next = { ...prev, ...patch };
      presence.current = next;
      if (!shouldWake(prev, next)) return;
      voice.wake();
      if (failedRef.current) {
        setAttempt(0);
        reload();
      } else {
        web.current?.injectJavaScript(wakeScript());
      }
    };
    const sub = AppState.addEventListener("change", (s) => apply({ appState: s }));
    const net = addNetworkStateListener((e) => apply({ online: e.isConnected !== false && e.isInternetReachable !== false }));
    void getNetworkStateAsync().then((e) => {
      presence.current = { ...presence.current, online: e.isConnected !== false };
    });
    return () => {
      sub.remove();
      net.remove();
    };
  }, [reload]);

  // Página que não carregou (sem rede, PC desligado): tenta de novo sozinha, 2, 4, 8, 15, 30 s.
  useEffect(() => {
    if (!failed) return;
    const t = setTimeout(() => {
      setAttempt((a) => a + 1);
      reload();
    }, retryDelayMs(attempt));
    return () => clearTimeout(t);
  }, [failed, attempt, reload]);

  // --- texto pronto -> campo de mensagem do web app
  const offered = useRef(new Set<string>());
  const place = useCallback((t: Take) => {
    if (t.text) web.current?.injectJavaScript(deliverTextScript(t.id, t.text));
  }, []);
  useEffect(() => {
    for (const t of snap.takes) {
      if (t.status === "ready" && !offered.current.has(t.id)) {
        offered.current.add(t.id);
        place(t);
      }
    }
  }, [snap.takes, place]);

  const onMessage = (e: WebViewMessageEvent) => {
    const ack = parseAck(e.nativeEvent.data);
    if (!ack) return;
    if (ack.ok) voice.delivered(ack.id);
    else voice.notice("Abra um terminal para receber o texto. Ele está guardado na lista.", true);
  };

  const onMic = async () => {
    if (snap.recording) return voice.stopRecording();
    if (!(await voice.ensurePrivacy(askPrivacy))) return;
    await voice.startRecording();
  };

  const waiting = snap.takes.filter((t) => t.status !== "recording" || t.parts.length > 0);
  const ready = snap.takes.filter((t) => t.status === "ready").length;
  const failedTakes = snap.takes.filter((t) => t.status === "failed").length;
  const elapsed = snap.recording ? now - snap.recording.startedAt : 0;

  return (
    <View style={s.root}>
      <View style={[s.bar, { paddingTop: insets.top + 4 }, snap.recording && s.barRec]}>
        {snap.recording ? (
          <>
            <Ionicons name="radio-button-on" size={16} color={C.err} />
            <Text style={s.timer}>{clock(elapsed)}</Text>
            <View style={s.meter}>
              <View style={[s.meterFill, { width: `${Math.round(snap.level * 100)}%` }]} />
            </View>
            <Pressable style={s.iconBtn} onPress={() => void voice.cancelRecording()} accessibilityRole="button" accessibilityLabel="Descartar gravação">
              <Ionicons name="close" size={24} color={C.text1} />
            </Pressable>
            <Pressable style={[s.iconBtn, s.stop]} onPress={() => void onMic()} accessibilityRole="button" accessibilityLabel="Parar e transcrever">
              <Ionicons name="stop" size={22} color={C.text1} />
            </Pressable>
          </>
        ) : (
          <>
            <Text style={s.brand}>Beth Studio</Text>
            <View style={{ flex: 1 }} />
            <Pressable style={s.iconBtn} onPress={() => setPanel(true)} accessibilityRole="button" accessibilityLabel={`Áudios e textos, ${waiting.length} na lista`}>
              <Ionicons name="list" size={24} color={failedTakes ? C.err : C.text1} />
              {waiting.length > 0 && (
                <View style={[s.badge, failedTakes > 0 && { backgroundColor: C.err }]}>
                  <Text style={s.badgeText}>{waiting.length}</Text>
                </View>
              )}
            </Pressable>
            <Pressable style={[s.iconBtn, s.mic]} onPress={() => void onMic()} accessibilityRole="button" accessibilityLabel="Gravar voz">
              <Ionicons name="mic" size={22} color={C.text1} />
            </Pressable>
          </>
        )}
      </View>

      {snap.notice && (
        <Banner kind={snap.notice.error ? "error" : "info"} onClose={voice.dismissNotice}>
          {snap.notice.text}
        </Banner>
      )}
      {ready > 0 && !panel && !snap.notice && (
        <Banner kind="info">{ready === 1 ? "Há um texto pronto na lista." : `Há ${ready} textos prontos na lista.`}</Banner>
      )}

      <View style={s.web}>
        <WebView
          ref={web}
          source={{ uri: mainUrl }}
          style={s.webview}
          originWhitelist={[origin]}
          setSupportMultipleWindows={false}
          mediaCapturePermissionGrantType="grant"
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowsBackForwardNavigationGestures={false}
          pullToRefreshEnabled
          onMessage={onMessage}
          onShouldStartLoadWithRequest={(r) => {
            if (isAllowedNavigation(r.url, host)) return true;
            if (/^https:\/\//i.test(r.url)) void Linking.openURL(r.url).catch(() => undefined);
            return false;
          }}
          onLoadEnd={(e) => {
            const url = e.nativeEvent.url;
            if (passwordRef.current && url.startsWith("https://") && isAllowedNavigation(url, host)) {
              web.current?.injectJavaScript(loginScript(passwordRef.current));
            }
          }}
          onLoad={() => {
            setFailed(false);
            setAttempt(0);
          }}
          onError={() => setFailed(true)}
          onHttpError={(e) => {
            if (e.nativeEvent.url === mainUrl && e.nativeEvent.statusCode >= 500) setFailed(true);
          }}
          onContentProcessDidTerminate={reload}
          onRenderProcessGone={reload}
        />
        {failed && (
          <View style={s.offline}>
            <Ionicons name="cloud-offline-outline" size={40} color={C.text2} />
            <Text style={s.offTitle}>Sem conexão com o servidor</Text>
            <Text style={s.offText}>O app tenta de novo sozinho e quando a rede voltar. Seus áudios continuam guardados.</Text>
            <Button
              label="Tentar agora"
              icon="refresh"
              onPress={() => {
                setAttempt(0);
                reload();
              }}
            />
          </View>
        )}
      </View>

      <TakesPanel visible={panel} takes={waiting} now={now} host={host} onClose={() => setPanel(false)} onPlace={place} onChangeServer={onChangeServer} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBody },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 4, backgroundColor: C.bgPanel, borderBottomWidth: 1, borderColor: C.border },
  barRec: { backgroundColor: "#3B1219" },
  brand: { color: C.text2, fontSize: 14, fontWeight: "600" },
  iconBtn: { minWidth: 44, height: 40, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  mic: { backgroundColor: C.accent },
  stop: { backgroundColor: "#7F1D1D" },
  timer: { color: C.text1, fontSize: 16, fontVariant: ["tabular-nums"], minWidth: 48 },
  meter: { flex: 1, height: 8, borderRadius: 4, backgroundColor: "#00000055", overflow: "hidden" },
  meterFill: { height: 8, backgroundColor: C.err },
  badge: { position: "absolute", top: 2, right: 2, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: C.accent, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  badgeText: { color: C.text1, fontSize: 11, fontWeight: "700" },
  web: { flex: 1 },
  webview: { flex: 1, backgroundColor: C.bgBody },
  offline: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C.bgBody, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  offTitle: { color: C.text1, fontSize: 18, fontWeight: "600" },
  offText: { color: C.text2, fontSize: 14, textAlign: "center", lineHeight: 20 },
});
