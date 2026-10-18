import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { normalizeDomain } from "@/config/domain";
import { saveCredentials } from "@/storage/secrets";
import { PhoneApi } from "@/voice/api";
import { nativeHttp } from "@/voice/http";
import { Banner, Button } from "./components";
import { C, TOUCH } from "./theme";

// Primeira abertura (e "trocar servidor"): domínio + senha do celular. Testa o
// login antes de guardar; domínio e senha só vão para o cofre do aparelho.

export function Setup({ onDone }: { onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const [domain, setDomain] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const d = normalizeDomain(domain);
    if (!d.ok) return setError(d.error);
    if (!password.trim()) return setError("Digite a senha do celular.");
    setBusy(true);
    try {
      await new PhoneApi({ host: d.host, getPassword: async () => password, http: nativeHttp }).checkLogin();
      await saveCredentials({ host: d.host, password });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não deu para entrar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={[s.body, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Beth Studio</Text>
        <Text style={s.sub}>Digite o endereço do servidor e a senha do celular que foram combinados na configuração do PC. Isso é pedido uma vez só.</Text>
        <Text style={s.label}>Endereço do servidor</Text>
        <TextInput
          style={s.input}
          value={domain}
          onChangeText={setDomain}
          placeholder="beth.suaempresa.com.br"
          placeholderTextColor={C.text3}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          textContentType="URL"
          accessibilityLabel="Endereço do servidor"
        />
        <Text style={s.label}>Senha do celular</Text>
        <TextInput
          style={s.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="password"
          placeholderTextColor={C.text3}
          accessibilityLabel="Senha do celular"
          onSubmitEditing={() => void submit()}
        />
        {error && (
          <View style={{ marginHorizontal: -12 }}>
            <Banner kind="error">{error}</Banner>
          </View>
        )}
        <Button label={busy ? "Entrando…" : "Entrar"} icon="log-in-outline" onPress={() => void submit()} disabled={busy} style={{ marginTop: 20 }} />
        <Text style={s.fine}>O app só fala HTTPS. A senha fica guardada no cofre do aparelho (Keychain/Keystore) e nunca vai para log.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBody },
  body: { paddingHorizontal: 24, gap: 8 },
  title: { color: C.text1, fontSize: 28, fontWeight: "700" },
  sub: { color: C.text2, fontSize: 15, lineHeight: 21, marginBottom: 12 },
  label: { color: C.text2, fontSize: 13, marginTop: 8 },
  input: {
    minHeight: TOUCH,
    borderWidth: 1,
    borderColor: C.borderStrong,
    borderRadius: 8,
    paddingHorizontal: 12,
    color: C.text1,
    backgroundColor: C.bgCard,
    fontSize: 16,
  },
  fine: { color: C.text3, fontSize: 12, marginTop: 16, lineHeight: 17 },
});
