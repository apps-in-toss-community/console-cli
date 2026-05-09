---
'@ait-co/console-cli': patch
---

`aitcc app certs ls`가 만료 임박 cert를 ⚠ 마커로 강조하고 JSON 응답의 각 cert에 `daysUntilExpiry`(`number | null`)를 추가합니다. 내부적으로 cert API를 도메인 파일(`src/api/certs.ts`)로 분리하고 `--json` 단일라인 contract를 subprocess harness로 검증합니다.
