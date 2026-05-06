---
'@ait-co/console-cli': patch
---

플랫폼 바이너리 빌드 toolchain의 Bun 버전을 `1.3.13`으로 핀한다 (`.bun-version` + `release-binaries.yml`이 이 파일을 참조). `@types/bun`도 `^1.3.13`으로 맞춤. 1.3.13은 macOS Mach-O `LC_CODE_SIGNATURE` stub 문제를 업스트림에서 수정한 버전 — 이 PR은 핀만 하고 rcodesign ad-hoc 서명 우회 제거는 후속 PR에서 별도로 검증한다.
