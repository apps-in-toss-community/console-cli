---
'@ait-co/console-cli': patch
---

`app register` 매니페스트 단계에서 `titleKo` / `titleEn`을 미리 검증해 server-side reject (errorCode `miniApp.InvalidTitle{,En}`) round-trip을 없앤다. titleKo는 한·영·숫자·공백·`:·?`만 허용 + 공백 제외 ≤10 code points, titleEn은 정규식 `^[A-Za-z0-9 :·?]+$` + 공백 제외 ≤15 code points + 단어별 title-case (all-caps 토큰 reject).
