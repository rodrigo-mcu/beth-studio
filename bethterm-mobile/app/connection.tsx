import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { ProtocolClient } from "@/protocol/client";
import { validateToken } from "@/protocol/pairing";
import { parseServerUrl, transportWarning } from "@/protocol/url";
import { dropClient } from "@/state/clients";
import { takePendingPairing } from "@/state/pendingPairing";
import { deleteConnection, getConnection, getToken, newConnectionId, saveConnection, type SavedConnection } from "@/storage/connections";
import { Banner, Button } from "@/ui/components";
import { C, TOUCH } from "@/ui/theme";

// Adicionar / editar uma conexao. Tambem recebe o resultado do QR.

export default function ConnectionForm() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  // Dados do QR (se vieram da tela de leitura): lidos uma vez, na montagem.
  const [qr] = useState(() => takePendingPairing());
  const fromQr = qr !== null;
  const [existing, setExisting] = useState<SavedConnection | null>(null);
  const [name, setName] = useState(qr?.name ?? "");
  const [url, setUrl] = useState(qr?.url ?? "");
  const [token, setToken] = useState(qr?.token ?? "");
  const [readOnly, setReadOnly] = useState(qr?.readOnly ?? true); // padrao: somente leitura
  const [pin, setPin] = useState<string | null>(qr?.pin ?? null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    void getConnection(id).then((c) => {
      if (!c) return;
      setExisting(c);
      if (!qr) {
        setName(c.name);
        setUrl(c.url);
        setReadOnly(c.readOnly);
        setPin(c.pin);
      }
    });
  }, [id, qr]);

  const urlCheck = useMemo(() => {
    if (!url.trim()) return { ep: null, error: null, warning: null };
    try {
      const ep = parseServerUrl(url);
      return { ep, error: null, warning: transportWarning(ep) };
    } catch (e) {
      return { ep: null, error: e instanceof Error ? e.message : String(e), warning: null };
    }
  }, [url]);

  // Editando: token vazio = manter o que esta no cofre.
  const keepToken = !!existing && token === "";
  const tokenError = keepToken ? null : token ? validateToken(token) : "Informe o token.";
  const canSave = !!urlCheck.ep && !tokenError && name.trim().length > 0;

  const save = async () => {
    if (!urlCheck.ep) return;
    const conn: SavedConnection = {
      id: existing?.id ?? newConnectionId(),
      name: name.trim().slice(0, 60),
      url: urlCheck.ep.wsUrl,
      readOnly,
      pin,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    try {
      await saveConnection(conn, keepToken ? null : token.trim());
      dropClient(conn.id); // endereco/token podem ter mudado
      router.back();
    } catch (e) {
      Alert.alert("Não foi possível salvar", e instanceof Error ? e.message : String(e));
    }
  };

  const test = async () => {
    if (!urlCheck.ep) return;
    let tok = token.trim();
    if (keepToken && existing) {
      tok = (await getToken(existing.id)) ?? "";
    }
    setTesting(true);
    setTestResult(null);
    // Teste sempre em somente leitura: so' list.
    const c = new ProtocolClient({ url: urlCheck.ep.wsUrl, token: tok, readOnly: true, reconnect: false });
    const result = await new Promise<{ ok: boolean; msg: string }>((resolve) => {
      const timer = setTimeout(() => done({ ok: false, msg: "Sem resposta em 8 s." }), 8000);
      const off = c.subscribe(() => {
        const snap = c.getSnapshot();
        if (snap.panes) done({ ok: true, msg: `Conectado: ${snap.panes.length} terminal(is).` });
        else if (snap.socket === "closed") done({ ok: false, msg: snap.lastError ?? "A conexão foi recusada ou caiu." });
      });
      function done(r: { ok: boolean; msg: string }) {
        clearTimeout(timer);
        off();
        c.stop();
        resolve(r);
      }
      c.start();
    });
    setTesting(false);
    setTestResult(result);
  };

  const remove = () => {
    if (!existing) return;
    Alert.alert("Excluir conexão", `Excluir "${existing.name}" e o token salvo neste aparelho?`, [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Excluir",
        style: "destructive",
        onPress: async () => {
          dropClient(existing.id);
          await deleteConnection(existing.id);
          router.back();
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen options={{ title: existing ? "Editar conexão" : "Nova conexão" }} />
      <ScrollView contentContainerStyle={s.form} keyboardShouldPersistTaps="handled">
        {fromQr && <Banner kind="info">Dados lidos do QR code. Confira e salve.</Banner>}

        <Text style={s.label}>Nome</Text>
        <TextInput style={s.input} value={name} onChangeText={setName} placeholder="PC do escritório" placeholderTextColor={C.text3} maxLength={60} />

        <Text style={s.label}>Endereço</Text>
        <TextInput
          style={[s.input, s.mono]}
          value={url}
          onChangeText={setUrl}
          placeholder="wss://meu-pc.exemplo.ts.net/ws"
          placeholderTextColor={C.text3}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {urlCheck.error && <Text style={s.err}>{urlCheck.error}</Text>}
        {urlCheck.warning && <Text style={s.warn}>{urlCheck.warning}</Text>}
        {urlCheck.ep && <Text style={s.help}>Conecta em {urlCheck.ep.wsUrl}</Text>}

        <Text style={s.label}>Token</Text>
        <TextInput
          style={[s.input, s.mono]}
          value={token}
          onChangeText={setToken}
          placeholder={existing ? "(mantido — digite para trocar)" : "token de acesso"}
          placeholderTextColor={C.text3}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          textContentType="password"
        />
        {token !== "" && tokenError && <Text style={s.err}>{tokenError}</Text>}
        <Text style={s.help}>O token fica guardado no cofre do aparelho, nunca em texto aberto.</Text>

        <View style={s.switchRow}>
          <View style={s.flex}>
            <Text style={s.switchLabel}>Somente leitura</Text>
            <Text style={s.help}>Ligado, o app só mostra os terminais: nunca digita nem cola nada.</Text>
          </View>
          <Switch
            accessibilityLabel="Somente leitura"
            value={readOnly}
            onValueChange={setReadOnly}
            trackColor={{ true: C.accent, false: C.borderStrong }}
            thumbColor={C.text1}
          />
        </View>

        {testResult && <Banner kind={testResult.ok ? "info" : "error"}>{testResult.msg}</Banner>}

        <View style={s.buttons}>
          <Button label="Salvar" icon="checkmark" onPress={save} disabled={!canSave} />
          <Button
            label={testing ? "Testando…" : "Testar conexão"}
            icon="pulse"
            kind="secondary"
            onPress={test}
            disabled={testing || !urlCheck.ep || (!keepToken && !!tokenError)}
          />
          {testing && <ActivityIndicator color={C.accentText} />}
          {existing && <Button label="Excluir" icon="trash-outline" kind="danger" onPress={remove} />}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bgBody },
  form: { padding: 16, gap: 6, paddingBottom: 48 },
  label: { color: C.text1, fontSize: 15, fontWeight: "600", marginTop: 10 },
  input: {
    minHeight: TOUCH,
    backgroundColor: C.bgCard,
    color: C.text1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  mono: { fontFamily: "monospace", fontSize: 14 },
  help: { color: C.text2, fontSize: 13 },
  err: { color: C.err, fontSize: 13 },
  warn: { color: C.warn, fontSize: 13 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, minHeight: TOUCH },
  switchLabel: { color: C.text1, fontSize: 16, fontWeight: "600" },
  flex: { flex: 1 },
  buttons: { gap: 10, marginTop: 20 },
});
