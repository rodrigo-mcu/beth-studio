// Envia uma gravação da fila: trecho por trecho, salvando depois de cada um.
// Só decide a ordem e o que gravar; a rede está em `transcribe` (api.ts).

import { allPartsDone, completeTake, partDone, sendFailed, startSending, type Take } from "./queue";

export interface SenderDeps {
  now: () => number;
  transcribe: (uri: string, seconds: number) => Promise<string>;
  /** persiste o estado; erro aqui não pára o envio */
  save: (t: Take) => Promise<void>;
}

export async function processTake(initial: Take, deps: SenderDeps): Promise<Take> {
  const persist = async (t: Take) => {
    try {
      await deps.save(t);
    } catch {
      /* disco cheio ou parecido: o arquivo de áudio continua lá, segue o envio */
    }
  };

  let t = startSending(initial);
  await persist(t);
  for (let i = 0; i < t.parts.length; i++) {
    const part = t.parts[i];
    if (!part || part.text !== null) continue;
    try {
      const text = await deps.transcribe(part.uri, part.seconds || t.seconds / t.parts.length);
      t = partDone(t, i, text);
      await persist(t);
    } catch (e) {
      t = sendFailed(t, e, deps.now());
      await persist(t);
      return t;
    }
  }
  if (allPartsDone(t)) t = completeTake(t);
  await persist(t);
  return t;
}
