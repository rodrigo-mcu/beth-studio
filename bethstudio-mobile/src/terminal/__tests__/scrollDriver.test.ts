import { ScrollDriver } from "../scrollDriver";

describe("ScrollDriver", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("acumula arrastos e envia no maximo um scroll a cada 30 ms", () => {
    const sent: number[] = [];
    const d = new ScrollDriver((o) => sent.push(o));
    d.onScreen({ offset: 0, scrollback: 100, rows: 24 });
    d.scrollBy(3);
    d.scrollBy(2);
    d.scrollBy(4);
    expect(sent).toEqual([]);
    jest.advanceTimersByTime(30);
    expect(sent).toEqual([9]);
  });

  it("limita ao scrollback e a zero", () => {
    const sent: number[] = [];
    const d = new ScrollDriver((o) => sent.push(o));
    d.onScreen({ offset: 0, scrollback: 50, rows: 24 });
    d.scrollBy(500);
    jest.advanceTimersByTime(30);
    d.onScreen({ offset: 50, scrollback: 50, rows: 24 });
    d.scrollBy(-999);
    jest.advanceTimersByTime(30);
    expect(sent).toEqual([50, 0]);
  });

  it("nao reenvia o mesmo offset e volta ao vivo apos digitar", () => {
    const sent: number[] = [];
    const d = new ScrollDriver((o) => sent.push(o));
    d.onScreen({ offset: 0, scrollback: 50, rows: 24 });
    d.scrollTo(10);
    jest.advanceTimersByTime(30);
    d.scrollTo(10);
    jest.advanceTimersByTime(30);
    expect(sent).toEqual([10]);
    d.resetToLive();
    d.onScreen({ offset: 0, scrollback: 50, rows: 24 });
    d.scrollBy(1);
    jest.advanceTimersByTime(30);
    expect(sent).toEqual([10, 1]);
  });
});
