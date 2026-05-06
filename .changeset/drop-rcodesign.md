---
'@ait-co/console-cli': patch
---

darwin 바이너리 서명 경로에서 `rcodesign` 외부 의존을 제거하고 stock `codesign --sign - --options runtime`으로 통합한다. Bun 1.3.13(`engines.bun` 핀)이 만드는 `linker-signed` ad-hoc stub을 `codesign --remove-signature`로 벗기고 hardened runtime + ad-hoc로 재-사인 — teleprompter에서 production 검증된 동일 패턴. 부산물로 `scripts/macos-entitlements.plist` 삭제(ad-hoc + non-hardened 서명에선 entitlements가 사실상 no-op이고 hardened runtime 위에서도 ad-hoc은 entitlements를 의미 있게 부여하지 못함). `scripts/build-bin.ts`의 darwin 분기 인라인 서명도 제거 — signing은 CI workflow 단계로 일원화. install.sh의 `xattr -d com.apple.quarantine` + 재-사인 안전망은 그대로 유지.
