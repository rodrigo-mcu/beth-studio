# Plano: celular, pareamento e aparelhos

Spec: `docs/superpowers/specs/2026-10-18-celular-pareamento-design.md`.
TDD em cada passo; commits pequenos.

1. `phone_devices.go`: modelo, hash, persistência, migração, criação/uso/expiração/revogação (+ testes).
2. `phone_auth.go`: sessões viram aparelhos; `setPassword` não revoga; `hub.dropPhone` e WS por aparelho.
3. Pareamento: `pairCreate`/`pairRedeem`, `/api/phone/pair` no gate, limitador, concorrência (+ testes).
4. Rotas de gestão locais + QR (reuso de `boombuler/barcode`) + bloqueio no gate e no Studio remoto (+ testes).
5. Proxy: última vez visto (memória + arquivo), offline HTML/JSON, teto de login (+ testes).
6. Frontend phone: `pair.ts`, `offline.ts`, tela de entrada, offline com hora e retry (+ testes).
7. Frontend Studio: `PhoneDevicesSection` (QR, lista, renomear, revogar) (+ testes da lógica).
8. Docs: wiki, FEATURES, CHANGELOG. Verificação final.
