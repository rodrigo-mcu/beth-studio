import Ionicons from "@expo/vector-icons/Ionicons";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ArrowKey } from "@/protocol/keys";
import type { IconName } from "@/ui/components";
import { C } from "@/ui/theme";

// Barra de teclas acima do teclado do sistema. Tudo com o dedo: Esc, Tab,
// Ctrl (fica ligado ate' a proxima tecla), setas, Ctrl+C, colar, teclado.

interface Props {
  readOnly: boolean;
  ctrlArmed: boolean;
  onEsc: () => void;
  onTab: () => void;
  onToggleCtrl: () => void;
  onArrow: (k: ArrowKey) => void;
  onCtrlC: () => void;
  onPaste: () => void;
  onKeyboard: () => void;
  onPageUp: () => void;
  onPageDown: () => void;
}

export function AccessoryBar(p: Props) {
  if (p.readOnly) {
    return (
      <View style={s.bar}>
        <View style={s.roNote}>
          <Ionicons name="eye-outline" size={16} color={C.accentText} />
          <Text style={s.roText}>Somente leitura</Text>
        </View>
        <Key label="Página acima" icon="chevron-up" onPress={p.onPageUp} />
        <Key label="Página abaixo" icon="chevron-down" onPress={p.onPageDown} />
      </View>
    );
  }
  return (
    <View style={s.bar}>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
        <Key label="Esc" text="Esc" onPress={p.onEsc} />
        <Key label="Tab" text="Tab" onPress={p.onTab} />
        <Key label={p.ctrlArmed ? "Ctrl ligado" : "Ctrl"} text="Ctrl" onPress={p.onToggleCtrl} active={p.ctrlArmed} />
        <Key label="Seta para a esquerda" icon="arrow-back" onPress={() => p.onArrow("left")} />
        <Key label="Seta para cima" icon="arrow-up" onPress={() => p.onArrow("up")} />
        <Key label="Seta para baixo" icon="arrow-down" onPress={() => p.onArrow("down")} />
        <Key label="Seta para a direita" icon="arrow-forward" onPress={() => p.onArrow("right")} />
        <Key label="Ctrl+C (interromper)" text="^C" onPress={p.onCtrlC} />
        <Key label="Colar" icon="clipboard-outline" onPress={p.onPaste} />
        <Key label="Página acima" icon="chevron-up" onPress={p.onPageUp} />
        <Key label="Página abaixo" icon="chevron-down" onPress={p.onPageDown} />
        <Key label="Mostrar ou esconder o teclado" icon="keypad-outline" onPress={p.onKeyboard} />
      </ScrollView>
    </View>
  );
}

function Key({
  label,
  text,
  icon,
  onPress,
  active,
}: {
  label: string;
  text?: string;
  icon?: IconName;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={active !== undefined ? { selected: active } : undefined}
      onPress={onPress}
      style={({ pressed }) => [s.key, active && s.keyActive, pressed && { backgroundColor: C.bgHover }]}
    >
      {icon ? <Ionicons name={icon} size={20} color={active ? C.accentText : C.text1} /> : <Text style={[s.keyText, active && { color: C.accentText }]}>{text}</Text>}
    </Pressable>
  );
}

const s = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.bgPanel,
    borderTopWidth: 1,
    borderTopColor: C.border,
    paddingVertical: 4,
    paddingHorizontal: 4,
    gap: 4,
  },
  row: { gap: 4, paddingHorizontal: 2 },
  key: {
    minWidth: 48,
    height: 44,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: C.bgCard,
    alignItems: "center",
    justifyContent: "center",
  },
  keyActive: { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentText },
  keyText: { color: C.text1, fontSize: 15, fontWeight: "600", fontFamily: "monospace" },
  roNote: { flex: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8 },
  roText: { color: C.accentText, fontSize: 14 },
});
