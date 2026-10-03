import Ionicons from "@expo/vector-icons/Ionicons";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { parseServerUrl, transportWarning } from "@/protocol/url";
import { listConnections, onConnectionsChanged, setConnectionReadOnly, type SavedConnection } from "@/storage/connections";
import { Button, EmptyState, IconButton } from "@/ui/components";
import { C, TOUCH } from "@/ui/theme";

// Tela "Conexoes": servidores salvos (nome, endereco; o token fica no cofre).

export default function ConnectionsScreen() {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<SavedConnection[] | null>(null);

  const load = useCallback(() => {
    listConnections().then(setItems, () => setItems([]));
  }, []);
  useEffect(() => {
    load();
    return onConnectionsChanged(load);
  }, [load]);

  return (
    <View style={[s.root, { paddingBottom: insets.bottom + 12 }]}>
      <FlatList
        data={items ?? []}
        keyExtractor={(c) => c.id}
        contentContainerStyle={s.list}
        ListEmptyComponent={
          items ? (
            <EmptyState icon="server-outline" title="Nenhum servidor salvo">
              <Text style={s.hint}>
                Adicione o PC com o BethTerm lendo o QR code de pareamento ou digitando o endereço e o token.
              </Text>
            </EmptyState>
          ) : null
        }
        renderItem={({ item }) => <ConnectionCard conn={item} />}
      />
      <View style={s.actions}>
        <Button label="Ler QR code" icon="qr-code-outline" onPress={() => router.push("/scan")} style={s.flex} />
        <Button label="Adicionar" icon="add" kind="secondary" onPress={() => router.push("/connection")} style={s.flex} />
      </View>
    </View>
  );
}

function ConnectionCard({ conn }: { conn: SavedConnection }) {
  let warning: string | null = null;
  let secure = false;
  try {
    const ep = parseServerUrl(conn.url);
    warning = transportWarning(ep);
    secure = ep.secure;
  } catch {
    warning = "Endereço inválido.";
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Abrir ${conn.name}`}
      onPress={() => router.push({ pathname: "/c/[connId]", params: { connId: conn.id } })}
      style={({ pressed }) => [s.card, pressed && { backgroundColor: C.bgHover }]}
    >
      <View style={s.cardHead}>
        <Ionicons name={secure ? "lock-closed" : "lock-open-outline"} size={18} color={secure ? C.ok : C.warn} />
        <Text style={s.name} numberOfLines={1}>
          {conn.name}
        </Text>
        <IconButton
          icon="create-outline"
          label={`Editar ${conn.name}`}
          onPress={() => router.push({ pathname: "/connection", params: { id: conn.id } })}
        />
      </View>
      <Text style={s.url} numberOfLines={1}>
        {conn.url}
      </Text>
      {warning && <Text style={s.warn}>{warning}</Text>}
      <View style={s.roRow}>
        <Text style={s.roLabel}>Somente leitura</Text>
        <Switch
          accessibilityLabel="Somente leitura"
          value={conn.readOnly}
          onValueChange={(v) => void setConnectionReadOnly(conn.id, v)}
          trackColor={{ true: C.accent, false: C.borderStrong }}
          thumbColor={C.text1}
        />
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBody },
  list: { padding: 12, gap: 10, flexGrow: 1 },
  hint: { color: C.text2, fontSize: 15, textAlign: "center", lineHeight: 21 },
  actions: { flexDirection: "row", gap: 10, paddingHorizontal: 12 },
  flex: { flex: 1 },
  card: { backgroundColor: C.bgCard, borderRadius: 12, padding: 12, gap: 4, borderWidth: 1, borderColor: C.border },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, color: C.text1, fontSize: 17, fontWeight: "600" },
  url: { color: C.text2, fontSize: 13, fontFamily: "monospace" },
  warn: { color: C.warn, fontSize: 12 },
  roRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: TOUCH },
  roLabel: { color: C.text1, fontSize: 15 },
});
