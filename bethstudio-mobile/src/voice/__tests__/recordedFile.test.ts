import { isSilent, MIN_BYTES_PER_SEC, pickRecordedFile } from "../recordedFile";

describe("pickRecordedFile", () => {
  it("fica com o primeiro arquivo que tem tamanho de áudio de verdade", () => {
    const r = pickRecordedFile(
      [
        { uri: "file:///vazio.m4a", bytes: 0 },
        { uri: "file:///bom.m4a", bytes: 40_000 },
        { uri: "file:///outro.m4a", bytes: 90_000 },
      ],
      10,
    );
    expect(r).toBe("file:///bom.m4a");
  });

  it("exige o mínimo de bytes por segundo (e 2000 bytes de piso)", () => {
    expect(pickRecordedFile([{ uri: "file:///x.m4a", bytes: 1999 }], 0.5)).toBeNull();
    expect(pickRecordedFile([{ uri: "file:///x.m4a", bytes: Math.ceil(30 * MIN_BYTES_PER_SEC) - 1 }], 30)).toBeNull();
    expect(pickRecordedFile([{ uri: "file:///x.m4a", bytes: Math.ceil(30 * MIN_BYTES_PER_SEC) }], 30)).toBe("file:///x.m4a");
  });

  it("ignora candidato sem caminho e devolve null se não sobrar nenhum", () => {
    expect(pickRecordedFile([{ uri: null, bytes: 999_999 }], 5)).toBeNull();
    expect(pickRecordedFile([], 5)).toBeNull();
  });
});

describe("isSilent", () => {
  it("silêncio é pico de medidor muito baixo (dB), só quando houve medição", () => {
    expect(isSilent(-90)).toBe(true);
    expect(isSilent(-30)).toBe(false);
    expect(isSilent(null)).toBe(false);
    expect(isSilent(Number.NEGATIVE_INFINITY)).toBe(true);
  });
});
