import { DarkTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { C } from "@/ui/theme";

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bgBody, card: C.bgPanel, text: C.text1, border: C.border, primary: C.accentText },
};

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider value={theme}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: C.bgPanel },
            headerTintColor: C.text1,
            headerTitleStyle: { fontWeight: "600" },
            contentStyle: { backgroundColor: C.bgBody },
          }}
        >
          <Stack.Screen name="index" options={{ title: "Conexões" }} />
          <Stack.Screen name="connection" options={{ title: "Conexão", presentation: "modal" }} />
          <Stack.Screen name="scan" options={{ title: "Ler QR code", presentation: "modal" }} />
          <Stack.Screen name="c/[connId]/index" options={{ title: "Terminais" }} />
          <Stack.Screen name="c/[connId]/[paneId]" options={{ title: "Terminal" }} />
        </Stack>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
