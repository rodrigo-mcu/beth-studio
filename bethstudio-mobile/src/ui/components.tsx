import Ionicons from "@expo/vector-icons/Ionicons";
import type { ComponentProps, ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { SocketState } from "@/protocol/types";
import { C, TOUCH } from "./theme";

export type IconName = ComponentProps<typeof Ionicons>["name"];

interface ButtonProps {
  label: string;
  onPress: () => void;
  icon?: IconName;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Button({ label, onPress, icon, kind = "primary", disabled, style }: ButtonProps) {
  const bg = kind === "primary" ? C.accent : kind === "danger" ? "#7F1D1D" : C.bgCard;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.75 : 1 },
        kind === "secondary" && styles.buttonBorder,
        style,
      ]}
    >
      {icon && <Ionicons name={icon} size={20} color={C.text1} />}
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

interface IconButtonProps {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  active?: boolean;
  color?: string;
}

export function IconButton({ icon, label, onPress, disabled, active, color }: IconButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, active && { backgroundColor: C.accentSoft }, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
    >
      <Ionicons name={icon} size={22} color={color ?? (active ? C.accentText : C.text1)} />
    </Pressable>
  );
}

export function Banner({ kind, children, onClose }: { kind: "error" | "warn" | "info"; children: ReactNode; onClose?: () => void }) {
  const color = kind === "error" ? C.err : kind === "warn" ? C.warn : C.accentText;
  return (
    <View style={[styles.banner, { borderColor: color }]}>
      <Ionicons name={kind === "info" ? "information-circle" : "warning"} size={18} color={color} />
      <Text style={[styles.bannerText, { color }]}>{children}</Text>
      {onClose && <IconButton icon="close" label="Fechar aviso" onPress={onClose} color={color} />}
    </View>
  );
}

const SOCKET_LABEL: Record<SocketState, string> = {
  idle: "Desligado",
  connecting: "Conectando…",
  open: "Conectado",
  closed: "Sem conexão",
};

export function StatusPill({ socket, readOnly }: { socket: SocketState; readOnly: boolean }) {
  const color = socket === "open" ? C.ok : socket === "connecting" ? C.busy : C.err;
  return (
    <View style={styles.pillRow}>
      <View style={styles.pill} accessibilityLabel={SOCKET_LABEL[socket]}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.pillText}>{SOCKET_LABEL[socket]}</Text>
      </View>
      {readOnly && (
        <View style={styles.pill}>
          <Ionicons name="eye-outline" size={14} color={C.accentText} />
          <Text style={styles.pillText}>Somente leitura</Text>
        </View>
      )}
    </View>
  );
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={48} color={C.text3} />
      <Text style={styles.emptyTitle}>{title}</Text>
      {children}
    </View>
  );
}

export const styles = StyleSheet.create({
  button: {
    minHeight: TOUCH,
    borderRadius: 10,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  buttonBorder: { borderWidth: 1, borderColor: C.borderStrong },
  buttonText: { color: C.text1, fontSize: 16, fontWeight: "600" },
  iconButton: { minWidth: 44, minHeight: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 8,
    paddingLeft: 12,
    paddingVertical: 6,
    marginHorizontal: 12,
    marginTop: 8,
    backgroundColor: C.bgPanel,
  },
  bannerText: { flex: 1, fontSize: 14 },
  pillRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.bgCard,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  pillText: { color: C.text2, fontSize: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  empty: { alignItems: "center", gap: 12, padding: 32 },
  emptyTitle: { color: C.text1, fontSize: 17, fontWeight: "600", textAlign: "center" },
});
