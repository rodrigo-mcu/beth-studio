import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { parsePairingPayload } from "@/protocol/pairing";
import { setPendingPairing } from "@/state/pendingPairing";
import { Banner, Button, EmptyState } from "@/ui/components";
import { C } from "@/ui/theme";

// Le o QR de pareamento (formato em docs/REMOTE_ACCESS.md) e abre o
// formulario ja' preenchido. Nada e' salvo sem a pessoa confirmar.

export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  if (!permission) return <View style={s.root} />;

  if (!permission.granted) {
    return (
      <View style={[s.root, s.center]}>
        <EmptyState icon="camera-outline" title="Permitir a câmera">
          <Text style={s.hint}>A câmera é usada só para ler o QR code de pareamento.</Text>
          {permission.canAskAgain ? (
            <Button label="Permitir" icon="camera" onPress={requestPermission} />
          ) : (
            <Text style={s.hint}>Libere a câmera para o BethTerm nas configurações do aparelho.</Text>
          )}
          <Button label="Digitar manualmente" kind="secondary" onPress={() => router.replace("/connection")} />
        </EmptyState>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          try {
            const info = parsePairingPayload(data);
            handled.current = true;
            setPendingPairing(info);
            router.replace("/connection");
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      <View style={s.overlay} pointerEvents="box-none">
        <View style={s.frame} />
        <Text style={s.caption}>Aponte para o QR code de pareamento do BethTerm</Text>
        {error && (
          <Banner kind="error" onClose={() => setError(null)}>
            {error}
          </Banner>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBody },
  center: { justifyContent: "center" },
  hint: { color: C.text2, fontSize: 15, textAlign: "center" },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 16 },
  frame: { width: 240, height: 240, borderWidth: 3, borderColor: C.accentText, borderRadius: 16 },
  caption: { color: C.text1, fontSize: 15, backgroundColor: "#0F1729CC", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
});
