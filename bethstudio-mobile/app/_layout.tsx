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
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bgBody } }} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
