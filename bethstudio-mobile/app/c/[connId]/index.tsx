import Ionicons from "@expo/vector-icons/Ionicons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { groupPanes, paneLabel, shortCwd } from "@/protocol/panes";
import { useClientSnapshot, useConnectionClient } from "@/state/clients";
import { Banner, EmptyState, StatusPill } from "@/ui/components";
import { C, TOUCH } from "@/ui/theme";

// Tela "Terminais": Janela -> Aba -> terminal, como a barra lateral do
// bethstudio-web. Puxar para baixo pede a lista de novo.

export default function PanesScreen() {
  const { connId } = useLocalSearchParams<{ connId: string }>();
  const { client, conn, error } = useConnectionClient(connId);
  const snap = useClientSnapshot(client);
  const groups = useMemo(() => (snap.panes ? groupPanes(snap.panes) : []), [snap.panes]);
  const [refreshing, setRefreshing] = useState(false);
  const refreshAt = useRef(0);

  // O "atualizando" termina quando chega uma lista nova (ou em 3 s).
  useEffect(() => {
    if (refreshing && snap.listAt > refreshAt.current) setRefreshing(false);
  }, [refreshing, snap.listAt]);

  const onRefresh = () => {
    if (!client) return;
    refreshAt.current = Date.now();
    setRefreshing(true);
    if (snap.socket !== "open") client.reconnectNow();
    else client.refreshList();
    setTimeout(() => setRefreshing(false), 3000);
  };

  return (
    <View style={s.root}>
      <Stack.Screen options={{ title: conn?.name ?? "Terminais" }} />
      <View style={s.statusRow}>
        <StatusPill socket={snap.socket} readOnly={snap.readOnly} />
      </View>
      {error && <Banner kind="error">{error}</Banner>}
      {snap.lastError && (
        <Banner kind="error" onClose={() => client?.clearError()}>
          {snap.lastError}
        </Banner>
      )}
      {snap.status && snap.status.state !== "up" && (
        <Banner kind="warn">Beth Studio no PC: {snap.status.message || snap.status.state}</Banner>
      )}
      <ScrollView
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accentText} colors={[C.accent]} />}
      >
        {!snap.panes ? (
          <EmptyState icon="hourglass-outline" title={snap.socket === "open" ? "Buscando terminais…" : "Conectando ao PC…"} />
        ) : snap.panes.length === 0 ? (
          <EmptyState icon="terminal-outline" title="Nenhum terminal aberto no BethStudio." />
        ) : (
          groups.map((w) => (
            <View key={w.windowId} style={s.window}>
              <View style={s.windowHead}>
                <Ionicons name="browsers-outline" size={14} color={C.text2} />
                <Text style={s.windowLabel} numberOfLines={1}>
                  {w.label}
                </Text>
              </View>
              {w.tabs.map((t) => (
                <View key={t.tabId} style={s.tab}>
                  {w.tabs.length > 1 && (
                    <Text style={s.tabLabel} numberOfLines={1}>
                      {t.label}
                    </Text>
                  )}
                  {t.panes.map((p) => {
                    const cwd = shortCwd(p.cwd);
                    return (
                      <Pressable
                        key={p.pane_id}
                        accessibilityRole="button"
                        accessibilityLabel={`Abrir ${paneLabel(p)}`}
                        onPress={() =>
                          router.push({ pathname: "/c/[connId]/[paneId]", params: { connId, paneId: String(p.pane_id) } })
                        }
                        style={({ pressed }) => [s.pane, pressed && { backgroundColor: C.bgHover }]}
                      >
                        <View style={[s.dot, { backgroundColor: p.is_active ? C.ok : C.borderStrong }]} />
                        <View style={s.flex}>
                          <Text style={s.paneTitle} numberOfLines={1}>
                            {paneLabel(p)}
                          </Text>
                          {!!cwd && (
                            <Text style={s.cwd} numberOfLines={1}>
                              {cwd}
                            </Text>
                          )}
                        </View>
                        <Text style={s.size}>
                          {p.size.cols}×{p.size.rows}
                        </Text>
                        <Ionicons name="chevron-forward" size={18} color={C.text3} />
                      </Pressable>
                    );
                  })}
                </View>
              ))}
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBody },
  statusRow: { paddingHorizontal: 12, paddingTop: 10 },
  list: { padding: 12, gap: 14, flexGrow: 1 },
  window: { gap: 4 },
  windowHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
  windowLabel: { color: C.text2, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5, flex: 1 },
  tab: { gap: 4 },
  tabLabel: { color: C.text3, fontSize: 12, paddingLeft: 20, paddingTop: 4 },
  pane: {
    minHeight: TOUCH + 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.bgCard,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  flex: { flex: 1 },
  paneTitle: { color: C.text1, fontSize: 16 },
  cwd: { color: C.text2, fontSize: 12, fontFamily: "monospace" },
  size: { color: C.text3, fontSize: 12, fontFamily: "monospace" },
});
