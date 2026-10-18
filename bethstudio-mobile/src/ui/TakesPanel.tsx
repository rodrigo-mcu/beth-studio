import * as Clipboard from "expo-clipboard";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { describeTake, type TakeAction } from "@/voice/describe";
import type { Take } from "@/voice/queue";
import { voice } from "@/voice/service";
import { Button } from "./components";
import { C } from "./theme";

// Lista dos áudios que ainda não viraram texto (e dos textos que ainda não
// entraram no campo): Tentar de novo / Baixar / Descartar, como no web app.

interface Props {
  visible: boolean;
  takes: Take[];
  now: number;
  host: string;
  onClose: () => void;
  onPlace: (t: Take) => void;
  onChangeServer: () => void;
}

const LABEL: Record<TakeAction, string> = {
  sendNow: "Enviar agora",
  retry: "Tentar de novo",
  download: "Baixar",
  discard: "Descartar",
  place: "Colocar no campo",
  copy: "Copiar",
};

export function TakesPanel({ visible, takes, now, host, onClose, onPlace, onChangeServer }: Props) {
  const insets = useSafeAreaInsets();

  const run = (t: Take, a: TakeAction) => {
    switch (a) {
      case "sendNow":
        voice.wake();
        break;
      case "retry":
        voice.retry(t.id);
        break;
      case "download":
        void voice.sharePart(t.id, 0);
        break;
      case "discard":
        voice.discard(t.id);
        break;
      case "place":
        onPlace(t);
        break;
      case "copy":
        if (t.text) void Clipboard.setStringAsync(t.text);
        break;
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Fechar lista" />
      <View style={[s.sheet, { paddingBottom: insets.bottom + 12 }]}>
        <View style={s.head}>
          <Text style={s.title}>Áudios e textos</Text>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Fechar" hitSlop={10}>
            <Text style={s.close}>Fechar</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={s.list}>
          {takes.length === 0 && <Text style={s.empty}>Nenhum áudio pendente. Tudo que você gravar aparece aqui até virar texto.</Text>}
          {takes.map((t) => {
            const v = describeTake(t, now);
            return (
              <View key={t.id} style={s.card}>
                <Text style={s.cardTitle}>{v.title}</Text>
                <Text style={[s.detail, t.status === "failed" && { color: C.err }]}>{v.detail}</Text>
                {v.preview && <Text style={s.preview}>{v.preview}</Text>}
                {t.parts.length > 1 && t.status === "failed" && (
                  <View style={s.row}>
                    {t.parts.map((p, i) => (
                      <Button key={p.uri} label={`Baixar ${i + 1}/${t.parts.length}`} kind="secondary" onPress={() => void voice.sharePart(t.id, i)} style={s.btn} />
                    ))}
                  </View>
                )}
                <View style={s.row}>
                  {v.actions.map((a) => (
                    <Button key={a} label={LABEL[a]} kind={a === "discard" ? "danger" : a === "download" || a === "copy" ? "secondary" : "primary"} onPress={() => run(t, a)} style={s.btn} />
                  ))}
                </View>
              </View>
            );
          })}
          <View style={s.foot}>
            <Text style={s.server} numberOfLines={1}>
              Servidor: {host}
            </Text>
            <Button label="Trocar servidor ou senha" kind="secondary" icon="swap-horizontal-outline" onPress={onChangeServer} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: "#00000088" },
  sheet: { backgroundColor: C.bgPanel, maxHeight: "75%", borderTopLeftRadius: 16, borderTopRightRadius: 16, borderTopWidth: 1, borderColor: C.border },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 },
  title: { color: C.text1, fontSize: 17, fontWeight: "600" },
  close: { color: C.accentText, fontSize: 16 },
  list: { paddingHorizontal: 16, gap: 12 },
  empty: { color: C.text2, fontSize: 14, lineHeight: 20 },
  card: { backgroundColor: C.bgCard, borderRadius: 10, padding: 12, gap: 6, borderWidth: 1, borderColor: C.border },
  cardTitle: { color: C.text1, fontSize: 15, fontWeight: "600" },
  detail: { color: C.text2, fontSize: 13, lineHeight: 18 },
  preview: { color: C.text1, fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  btn: { minWidth: 110 },
  foot: { marginTop: 8, gap: 8 },
  server: { color: C.text3, fontSize: 12 },
});
