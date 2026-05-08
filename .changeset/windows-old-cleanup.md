---
'@ait-co/console-cli': patch
---

Windows에서 `aitcc upgrade` 후 남은 `<exePath>.old` 파일을 다음 CLI 기동 시 best-effort로 정리합니다. POSIX에선 no-op, 실패는 silently swallow (이전 process가 아직 잡고 있을 수 있음 — 다음 기동 때 재시도). stdout/stderr 출력 없음.
