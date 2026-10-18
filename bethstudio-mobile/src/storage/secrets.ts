import * as SecureStore from "expo-secure-store";

// Domínio e senha do celular ficam SÓ no cofre do aparelho (Keychain no iOS,
// Keystore no Android), presos a este aparelho. A senha é lida depois do
// primeiro desbloqueio, para o reenvio de áudio funcionar com a tela
// bloqueada. Nada disso vai para log.

const DOMAIN_KEY = "bethstudio_domain";
const PASSWORD_KEY = "bethstudio_password";
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export interface Credentials {
  host: string;
  password: string;
}

export async function loadHost(): Promise<string | null> {
  try {
    return (await SecureStore.getItemAsync(DOMAIN_KEY, OPTS)) || null;
  } catch {
    return null;
  }
}

export async function loadPassword(): Promise<string | null> {
  try {
    return (await SecureStore.getItemAsync(PASSWORD_KEY, OPTS)) || null;
  } catch {
    return null;
  }
}

export async function saveCredentials(c: Credentials): Promise<void> {
  await SecureStore.setItemAsync(DOMAIN_KEY, c.host, OPTS);
  await SecureStore.setItemAsync(PASSWORD_KEY, c.password, OPTS);
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(DOMAIN_KEY, OPTS).catch(() => undefined);
  await SecureStore.deleteItemAsync(PASSWORD_KEY, OPTS).catch(() => undefined);
}
