import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { clearCredentials, loadHost, loadPassword } from "@/storage/secrets";
import { Setup } from "@/ui/Setup";
import { Shell } from "@/ui/Shell";
import { C } from "@/ui/theme";

// Uma tela só: pede o domínio e a senha na primeira vez e depois abre o web
// app do celular dentro do Shell (WebView + microfone nativo).

type State = { kind: "loading" } | { kind: "setup" } | { kind: "ready"; host: string };

export default function Home() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const refresh = useCallback(async () => {
    const [host, password] = await Promise.all([loadHost(), loadPassword()]);
    setState(host && password ? { kind: "ready", host } : { kind: "setup" });
  }, []);

  useEffect(() => {
    let alive = true;
    void Promise.all([loadHost(), loadPassword()]).then(([host, password]) => {
      if (alive) setState(host && password ? { kind: "ready", host } : { kind: "setup" });
    });
    return () => {
      alive = false;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <View style={{ flex: 1, backgroundColor: C.bgBody, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={C.accentText} />
      </View>
    );
  }
  if (state.kind === "setup") return <Setup onDone={refresh} />;
  return (
    <Shell
      host={state.host}
      onChangeServer={async () => {
        await clearCredentials();
        await refresh();
      }}
    />
  );
}
